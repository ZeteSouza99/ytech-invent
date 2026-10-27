import { useEffect, useMemo, useState } from 'react';
import { AppState, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { randomUUID } from 'expo-crypto';
import { buildInventoryMessage } from '../shared/mime';
import { errorMessage, type Catalog, type Inventory } from '../shared/model';
import { loadWorkbookService } from './catalog';
import { UnitScanner, type ScannedUnit } from './UnitScanner';
import { Button, Notice, styles } from './ui';

const NO_SERIALS: ReadonlySet<string> = new Set();

// Builds both workbooks and the e-mail on the device without sending anything.
async function workbookCheck(unit: ScannedUnit | null): Promise<string> {
  const started = Date.now();
  const service = await loadWorkbookService();
  const loaded = Date.now();
  const now = new Date().toISOString();
  const pn = unit?.pn.value ?? service.catalog.products[0]?.pn ?? 'DIAGNOSTICO';
  const ns = unit?.ns.value ?? 'DIAG0001';
  const location = service.catalog.locations[0] ?? 'DIAGNOSTICO';
  const sample: Inventory = {
    id: randomUUID(), title: 'Diagnóstico de planilhas', location, startedAt: now, completedAt: now,
    catalogVersion: service.catalog.version,
    items: [{ id: randomUUID(), pn, ns, location, quantity: 1, capturedAt: now, source: 'manual', rawPn: pn, rawNs: ns, confirmed: true }],
  };
  const user = { sub: 'diagnostico', email: 'diagnostico@ytechsolucoes.com', name: 'Diagnóstico' };
  const spreadsheet = await service.spreadsheet([{ inventory: sample, partial: false }]);
  const raw = buildInventoryMessage({ inventory: sample, user, attachments: [spreadsheet] });
  return `Catálogo: ${service.catalog.products.length} PN em ${loaded - started} ms.\nPlanilha: ${spreadsheet.filename} ${(spreadsheet.content.length / 1024).toFixed(1)} KB, gerada em ${Date.now() - loaded} ms.\nE-mail montado: ${(raw.length / 1024).toFixed(1)} KB. Nada foi enviado.`;
}

export function CameraDiagnostics({ onClose }: { onClose: () => void }) {
  const [scanning, setScanning] = useState(false);
  const [unit, setUnit] = useState<ScannedUnit | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [active, setActive] = useState(AppState.currentState === 'active');
  const [workbookBusy, setWorkbookBusy] = useState(false);
  const [workbookResult, setWorkbookResult] = useState<{ ok: boolean; text: string } | null>(null);
  // A new array on every render would restart the scanner's capture loop.
  const catalogPns = useMemo(() => catalog?.products.map(product => product.pn) ?? [], [catalog]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => setActive(state === 'active'));
    loadWorkbookService().then(service => setCatalog(service.catalog)).catch(() => setCatalog(null));
    return () => subscription.remove();
  }, []);

  return <SafeAreaView style={styles.screen}>
    <View style={styles.header}><Text style={styles.subheading}>Teste da câmera</Text></View>
    <ScrollView contentContainerStyle={styles.content}>
      <Notice>Diagnóstico de desenvolvimento. Sem login, inventário ou envio. Os resultados ficam apenas nesta tela e são descartados ao sair.</Notice>
      <Text style={styles.body}>Aponte para uma etiqueta real. O leitor procura apenas PN e NS, usando códigos de barras, o texto impresso e o catálogo de produtos. Compare cada caractere com a etiqueta.</Text>
      <Button title="Ler etiqueta" onPress={() => setScanning(true)} />
      {unit && <View style={styles.panel}>
        <Text style={styles.subheading}>Última leitura usada</Text>
        <Text selectable style={styles.code}>PN {unit.pn.value}</Text>
        <Text selectable style={styles.code}>NS {unit.ns.value}</Text>
      </View>}
      <View style={styles.panel}>
        <Text style={styles.subheading}>Planilhas no celular</Text>
        <Text style={styles.body}>Gera a planilha com uma unidade de teste e monta o e-mail, sem enviar. Usa o PN e o NS lidos acima, se houver.</Text>
        <Button title={workbookBusy ? 'Gerando…' : 'Gerar planilhas de teste'} disabled={workbookBusy} onPress={() => {
          setWorkbookBusy(true);
          setWorkbookResult(null);
          workbookCheck(unit)
            .then(text => setWorkbookResult({ ok: true, text }))
            .catch(error => setWorkbookResult({ ok: false, text: `Falha: ${errorMessage(error)}` }))
            .finally(() => setWorkbookBusy(false));
        }} />
        {workbookResult && <Notice error={!workbookResult.ok}>{workbookResult.text}</Notice>}
      </View>
      <Button title="Sair do teste" secondary disabled={workbookBusy} onPress={onClose} />
    </ScrollView>
    {scanning && <UnitScanner active={active} catalogPns={catalogPns}
      describe={value => catalog?.products.find(product => product.pn === value)?.description}
      savedSerials={NO_SERIALS} onClose={() => setScanning(false)}
      onUse={selected => { setUnit(selected); setScanning(false); }} />}
  </SafeAreaView>;
}
