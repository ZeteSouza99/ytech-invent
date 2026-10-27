import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, Text, Vibration, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import * as FileSystem from 'expo-file-system/legacy';
import { analyzeLabelImage } from '../modules/label-reader';
import {
  analyzeLabel, classifyBarcode, createCatalogIndex, ReadingPool,
  type Decision, type Evidence, type Reading,
} from '../shared/labels';
import { errorMessage } from '../shared/model';
import { pictureSizeFor } from './pictureSize';
import { captureLoop } from './captureLoop';
import { Button, colors, Notice, styles } from './ui';

export type ScannedUnit = { pn: Reading; ns: Reading };

// Formats printed on the inventory labels; fewer formats decode faster and avoid false reads.
const FORMATS = ['code128', 'code39', 'datamatrix', 'pdf417'] as const;
const SCANNER_SETTINGS = { barcodeTypes: [...FORMATS] };
const SEARCHING: Decision = { status: 'searching', hint: 'Centralize a etiqueta com o PN e o NS do equipamento.' };
// Photo size chosen for this phone; reopening the reader binds the camera once, already with it.
let chosenPictureSize: string | null = null;

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
type Shot = { uri?: string; captureMs: number };

const EVIDENCE: Record<Evidence, string> = {
  codigo: 'código de barras',
  identificador: 'identificador (1P)/(S)',
  rotulo: 'rótulo impresso',
  catalogo: 'catálogo',
  'catalogo-aproximado': 'semelhante a um PN conhecido',
  padrao: 'formato de série',
  texto: 'texto impresso',
  'digitos-corrigidos': 'dígitos ajustados',
  historico: 'PN já contado',
  fixado: 'PN mantido',
};

const CONFIDENCE = {
  alta: { text: 'confirmado', color: colors.green, background: '#E3F2ED' },
  media: { text: 'provável', color: colors.amber, background: '#FFF3DC' },
  baixa: { text: 'incerto', color: colors.red, background: '#FDEEF0' },
} as const;

function ReadingRow({ label, reading, confirmations, description }: {
  label: string; reading?: Reading; confirmations: number; description?: string;
}) {
  const state = reading ? CONFIDENCE[reading.confidence] : null;
  return <View style={[styles.panel, { gap: 6, padding: 14 }]}>
    <View style={[styles.row, { justifyContent: 'space-between' }]}>
      <Text style={styles.label}>{label}</Text>
      {state && <Text style={{ color: state.color, backgroundColor: state.background, paddingHorizontal: 10, paddingVertical: 3, borderRadius: 12, fontSize: 12, fontWeight: '700' }}>
        {reading!.confidence === 'media' && confirmations < 2 ? 'provável · confirmando' : state.text}
      </Text>}
    </View>
    <Text selectable style={[styles.code, { fontSize: 20 }]}>{reading?.value ?? '—'}</Text>
    {reading && <Text style={[styles.body, { fontSize: 13, lineHeight: 18 }]}>{reading.evidence.map(item => EVIDENCE[item]).join(' · ')}</Text>}
    {description !== undefined && <Text style={[styles.body, { fontSize: 13, lineHeight: 18 }]}>{description}</Text>}
  </View>;
}

export function UnitScanner({
  active, catalogPns, countedPns, describe, lockedPn = null, savedSerials, location, onSave, onUse, onManual, onUnlockPn, onClose,
}: {
  active: boolean;
  catalogPns: readonly string[];
  // Part numbers already counted by this account; recognized at the first photo.
  countedPns?: ReadonlySet<string>;
  describe?: (pn: string) => string | undefined;
  lockedPn?: string | null;
  savedSerials: ReadonlySet<string>;
  location?: string;
  // Saves the unit and returns the message to show; omitted in the diagnostic screen.
  onSave?: (unit: ScannedUnit, keepPn: boolean) => Promise<string>;
  // Fills a form with the values instead of saving.
  onUse?: (unit: ScannedUnit) => void;
  onManual?: (unit: Partial<ScannedUnit>) => void;
  onUnlockPn?: () => void;
  onClose: () => void;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const camera = useRef<CameraView>(null);
  // Kept for the whole session so remembering a counted part number never restarts the capture loop.
  const catalog = useMemo(() => createCatalogIndex(catalogPns), [catalogPns]);
  const inCatalog = useMemo(() => new Set(catalogPns), [catalogPns]);
  useEffect(() => {
    for (const pn of countedPns ?? []) catalog.remember(pn);
  }, [catalog, countedPns]);
  const pool = useRef(new ReadingPool());
  const [ready, setReady] = useState(false);
  const [pictureSize, setPictureSize] = useState<string | null>(chosenPictureSize);
  const settle = useRef(false);
  const [torch, setTorch] = useState(false);
  const [zoom, setZoom] = useState(0);
  const [decision, setDecision] = useState<Decision>(SEARCHING);
  const [chosen, setChosen] = useState<ScannedUnit | null>(null);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const savingRef = useRef(false);
  const captureTask = useRef<Promise<void>>(Promise.resolve());
  const cancelCapture = useRef<() => void>(() => undefined);
  const cleanupWarning = useRef<string | null>(null);
  const [keepPn, setKeepPn] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [cleanupError, setCleanupError] = useState<string | null>(null);
  const [frames, setFrames] = useState(0);
  const justSaved = useRef(new Set<string>());
  const lastLive = useRef({ value: '', at: 0 });
  const lockedRef = useRef(lockedPn);
  lockedRef.current = lockedPn;
  const savedRef = useRef(savedSerials);
  savedRef.current = savedSerials;

  // Both read only refs and state setters, so they keep the same identity and never restart the capture loop.
  const serialsToSkip = useCallback((): ReadonlySet<string> => new Set([...savedRef.current, ...justSaved.current]), []);

  const evaluate = useCallback(() => {
    const next = pool.current.decide({ lockedPn: lockedRef.current, savedSerials: serialsToSkip() });
    setDecision(next);
    if ((next.status === 'ready' || next.status === 'multiple') && !pausedRef.current) {
      pausedRef.current = true;
      setPaused(true);
      Vibration.vibrate(next.status === 'ready' ? 60 : [0, 40, 70, 40]);
    }
  }, [serialsToSkip]);

  function resume(saved?: ScannedUnit) {
    if (closingRef.current) return;
    pool.current.reset(saved ? { ns: saved.ns.value, pn: saved.pn.value } : undefined);
    setChosen(null);
    setDecision(SEARCHING);
    setFrames(0);
    pausedRef.current = false;
    setPaused(false);
  }

  useEffect(() => {
    // A different kept part number invalidates readings taken under the previous rule.
    if (!pausedRef.current) setDecision(pool.current.decide({ lockedPn, savedSerials: serialsToSkip() }));
  }, [lockedPn, serialsToSkip]);

  useEffect(() => {
    // The preview unmounts in background; capturing before it is ready again would fail.
    if (!active) setReady(false);
  }, [active]);

  useEffect(() => {
    if (!active || !ready || paused || pictureSize === null || !permission?.granted) return;
    let cancelled = false;
    cancelCapture.current = () => { cancelled = true; };
    const shoot = (): Promise<Shot> => {
      const started = Date.now();
      const view = camera.current;
      if (!view) return Promise.resolve({ captureMs: 0 });
      return view.takePictureAsync({ skipProcessing: true, shutterSound: false, exif: false })
        .then(photo => ({ ...(photo?.uri ? { uri: photo.uri } : {}), captureMs: Date.now() - started }));
    };
    const task = captureTask.current.then(async () => {
      if (cancelled) return;
      if (settle.current) {
        // CameraX is rebinding with the chosen photo size.
        await wait(350);
        settle.current = false;
      }
      let failures = 0;
      await captureLoop<Awaited<ReturnType<typeof analyzeLabelImage>>>({
        capture: shoot,
        analyze: uri => analyzeLabelImage(uri, { maxSide: 4096, formats: [...FORMATS] }),
        discard: uri => FileSystem.deleteAsync(uri, { idempotent: true }),
        continue: () => !cancelled && !pausedRef.current && !closingRef.current,
        result: scan => {
          failures = 0;
          pool.current.addFrame(analyzeLabel(scan, catalog));
          setReadError(null);
          setFrames(count => count + 1);
          evaluate();
        },
        error: error => {
          failures += 1;
          // A single failure while the camera settles is retried silently.
          if (failures >= 2) setReadError(`Falha na leitura: ${errorMessage(error)}`);
        },
        cleanupError: () => {
          cleanupWarning.current = 'Não foi possível apagar uma foto temporária do cache. Ela não foi enviada; verifique o armazenamento do aparelho.';
          setCleanupError(cleanupWarning.current);
          pausedRef.current = true;
          setPaused(true);
        },
        delay: () => wait(500),
      });
    });
    captureTask.current = task.catch(error => { if (!cancelled) setReadError(errorMessage(error)); });
    return () => { cancelled = true; };
  }, [active, ready, paused, pictureSize, permission?.granted, catalog, evaluate]);

  function onCameraReady() {
    setReady(true);
    if (pictureSize !== null) return;
    const apply = (size: string) => {
      chosenPictureSize = size;
      settle.current = size !== '';
      setPictureSize(size);
    };
    camera.current?.getAvailablePictureSizesAsync()
      .then(sizes => apply(pictureSizeFor(sizes) ?? ''))
      .catch(() => apply(''));
  }

  function onBarcode(event: BarcodeScanningResult) {
    if (pausedRef.current || closingRef.current || savingRef.current) return;
    const value = event.raw ?? event.data;
    const now = Date.now();
    if (!value || (value === lastLive.current.value && now - lastLive.current.at < 1000)) return;
    lastLive.current = { value, at: now };
    const readings = classifyBarcode({ value }, catalog);
    if (!readings.length) return;
    pool.current.addLive(readings);
    evaluate();
  }

  const unit: ScannedUnit | null = chosen ?? (decision.status === 'ready' ? { pn: decision.pn, ns: decision.ns } : null);
  const shownPn = unit?.pn ?? (decision.status === 'searching' ? decision.pn : undefined);
  const shownNs = unit?.ns ?? (decision.status === 'searching' ? decision.ns : undefined);
  const describePn = (pn?: Reading) => {
    if (!pn) return undefined;
    const description = describe?.(pn.value);
    return description ?? (inCatalog.has(pn.value) ? undefined : 'PN fora do catálogo: será salvo sem descrição.');
  };

  async function save(selected: ScannedUnit) {
    if (!onSave || savingRef.current || closingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setMessage(null);
    try {
      const text = await onSave(selected, keepPn);
      justSaved.current.add(selected.ns.value);
      // The next unit of the same model is recognized at the first photo.
      catalog.remember(selected.pn.value);
      setMessage({ text, error: false });
      Vibration.vibrate(30);
      resume(selected);
    } catch (error) {
      setMessage({ text: errorMessage(error), error: true });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  async function leave(action: () => void) {
    if (savingRef.current || closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    pausedRef.current = true;
    setPaused(true);
    cancelCapture.current();
    await captureTask.current;
    // Do not unmount before the user can see a failure to remove a photo.
    if (cleanupWarning.current) {
      closingRef.current = false;
      setClosing(false);
      return;
    }
    action();
  }

  const controlsBusy = saving || closing;


  return <Modal visible={active} onRequestClose={() => { void leave(onClose); }} animationType="slide">
    <SafeAreaView style={styles.screen}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.subheading}>Ler equipamento</Text>
          <Text style={[styles.body, { fontSize: 13 }]}>{location ? `Local: ${location}` : 'PN e NS na mesma leitura'}</Text>
        </View>
        <Button title={closing ? 'Finalizando…' : 'Concluir'} secondary disabled={controlsBusy} onPress={() => { void leave(onClose); }} />
      </View>
      <ScrollView contentContainerStyle={[styles.content, { gap: 12 }]}>
        {!permission?.granted ? <View style={styles.panel}>
          <Notice>A câmera precisa de permissão para ler as etiquetas.</Notice>
          <Button title="Permitir câmera" onPress={() => { void requestPermission().catch(error => setMessage({ text: errorMessage(error), error: true })); }} />
        </View> : <View style={{ height: 300, borderRadius: 16, overflow: 'hidden', backgroundColor: colors.ink }}>
          {active && <CameraView ref={camera} style={{ flex: 1 }} facing="back" enableTorch={torch} zoom={zoom} animateShutter={false}
            {...(pictureSize ? { pictureSize } : {})}
            onCameraReady={onCameraReady} onMountError={event => setMessage({ text: event.message, error: true })}
            barcodeScannerSettings={SCANNER_SETTINGS} onBarcodeScanned={onBarcode} />}
          <View pointerEvents="none" style={{ position: 'absolute', left: '6%', right: '6%', top: '12%', bottom: '12%', borderWidth: 2, borderColor: unit ? '#7CE0B5' : colors.white, borderRadius: 10 }} />
        </View>}
        <View style={styles.row}>
          <View style={{ flex: 1 }}><Button title={torch ? 'Apagar luz' : 'Lanterna'} secondary disabled={!permission?.granted} onPress={() => setTorch(!torch)} /></View>
          <View style={{ flex: 1 }}><Button title={zoom ? 'Zoom normal' : 'Aproximar'} secondary onPress={() => setZoom(zoom ? 0 : 0.2)} /></View>
        </View>
        {lockedPn && <View style={[styles.panel, styles.row, { padding: 12 }]}>
          <Text style={[styles.body, { flex: 1 }]}>PN mantido: <Text style={styles.code}>{lockedPn}</Text>. Só o NS é necessário.</Text>
          {onUnlockPn && <Button title="Liberar" secondary disabled={controlsBusy} onPress={onUnlockPn} />}
        </View>}
        {message && <Notice error={message.error}>{message.text}</Notice>}
        {readError && <Notice error>{readError}</Notice>}
        {cleanupError && <View style={{ gap: 8 }}>
          <Notice error>{cleanupError}</Notice>
          <Button title="Entendi o aviso de armazenamento" secondary onPress={() => { cleanupWarning.current = null; setCleanupError(null); }} />
        </View>}

        {decision.status === 'multiple' && !chosen ? <View style={[styles.panel, { gap: 10 }]}>
          <Text style={styles.subheading}>Mais de um equipamento na imagem</Text>
          <Text style={styles.body}>Toque no equipamento que está contando, ou centralize uma única etiqueta e leia de novo.</Text>
          {decision.options.map(option => {
            const pn = option.pn ?? (lockedPn ? { field: 'pn' as const, value: lockedPn, raw: lockedPn, source: 'ocr' as const, evidence: ['fixado' as const], confidence: 'alta' as const } : undefined);
            return <Button key={`${option.ns.value}-${option.pn?.value ?? ''}`} secondary disabled={!pn}
              title={`NS ${option.ns.value}\nPN ${pn?.value ?? 'não identificado'}`}
              onPress={() => { if (pn) setChosen({ pn, ns: option.ns }); }} />;
          })}
          <Button title="Ler de novo" secondary disabled={controlsBusy} onPress={() => resume()} />
        </View> : <>
          <ReadingRow label="PN · Part number" reading={shownPn} description={describePn(shownPn)}
            confirmations={shownPn ? pool.current.confirmations(shownPn) : 0} />
          <ReadingRow label="NS · Número de série" reading={shownNs}
            confirmations={shownNs ? pool.current.confirmations(shownNs) : 0} />
        </>}

        {unit ? <View style={{ gap: 10 }}>
          {(unit.pn.confidence !== 'alta' || unit.ns.confidence !== 'alta') &&
            <Notice>Valor provável confirmado em mais de uma foto. Compare com a etiqueta antes de salvar.</Notice>}
          {onSave && !lockedPn && <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: keepPn }} onPress={() => setKeepPn(!keepPn)} style={[styles.row, { minHeight: 44 }]}>
            <Text style={{ fontSize: 22, color: colors.blue }}>{keepPn ? '☑' : '☐'}</Text>
            <Text style={[styles.body, { flex: 1 }]}>Manter este PN nas próximas unidades (lotes do mesmo modelo)</Text>
          </Pressable>}
          {onSave && <Button title={saving ? 'Salvando…' : unit.pn.confidence === 'alta' && unit.ns.confidence === 'alta' ? 'Salvar unidade' : 'Conferi com a etiqueta, salvar'}
            disabled={controlsBusy} onPress={() => { void save(unit); }} />}
          {onUse && <Button title="Usar estes valores" disabled={controlsBusy} onPress={() => { void leave(() => onUse(unit)); }} />}
          {!onSave && !onUse && <Notice>Leitura de teste: nada é salvo.</Notice>}
          <Button title="Ler de novo" secondary disabled={controlsBusy} onPress={() => resume()} />
        </View> : decision.status === 'searching' && <Text accessibilityLiveRegion="polite" style={[styles.body, { textAlign: 'center' }]}>
          {permission?.granted ? decision.hint : ''}{frames ? `\n${frames} ${frames === 1 ? 'foto analisada' : 'fotos analisadas'}` : ''}
        </Text>}

        {paused && !unit && decision.status === 'searching' && <Button title="Retomar leitura" secondary disabled={controlsBusy || !!cleanupError} onPress={() => resume()} />}
        {onManual && <Button title="Digitar ou corrigir manualmente" secondary disabled={controlsBusy}
          onPress={() => { void leave(() => onManual({ ...(shownPn ? { pn: shownPn } : {}), ...(shownNs ? { ns: shownNs } : {}) })); }} />}

      </ScrollView>
    </SafeAreaView>
  </Modal>;
}
