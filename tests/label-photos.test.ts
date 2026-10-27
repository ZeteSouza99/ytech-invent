import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { analyzeLabel, createCatalogIndex, ReadingPool, type CatalogIndex, type Decision, type LabelScan } from '../shared/labels';
import { createWorkbookService } from '../shared/workbook';

// ML Kit output (barcodes + OCR lines with positions) for the label photos kept in tests/fixtures/photos
// (local only, not versioned), recorded on the Motorola Edge 60 Fusion. They are WhatsApp copies (1600x1200, recompressed),
// harder than the 12 MP photos taken by the app. The rotated set is the same photos stored sideways
// with EXIF orientation 6, the way the camera saves them, so ML Kit applies the rotation.
type Photo = LabelScan & { file: string };

// What each photo really shows, read from the photos themselves.
const TRUTH: Record<string, { pn: string[]; ns: string[] }> = {
  '09.00.139.jpeg': { pn: ['MC3401-0G1R64SS-A6'], ns: ['25150523023493'] },
  '09.00.217.jpeg': { pn: [], ns: ['52N222300499'] },
  '09.00.27.jpeg': { pn: ['ZT41142-T0A0000Z'], ns: ['99J242000740'] },
  '09.00.30.jpeg': { pn: ['ZT23142-T0A000FZ'], ns: ['T3N232800835'] },
  '09.00.31.jpeg': { pn: ['DS9208-SR00004NNWW'], ns: ['13317000503377'] },
  '09.00.318.jpeg': { pn: ['ZD22042-T0AG00EZ'], ns: ['D5J242300912'] },
  '09.00.32.jpeg': { pn: ['AP305C-1-WR'], ns: ['03052211308046'] },
  '09.00.33.jpeg': { pn: ['MS4717-LU000R'], ns: ['22192520100839'] },
  '09.00.36.jpeg': { pn: ['MS4717-LU000R'], ns: ['22194520101338'] },
  '09.00.37.jpeg': { pn: ['DS9908-SR00004ZZWW'], ns: ['19245520180264'] },
  '09.00.38.jpeg': { pn: ['DS2278-SR00007ZZWW'], ns: ['25302523700953'] },
  '09.00.40.jpeg': { pn: ['SAC-MC33-4SCHG-01'], ns: ['21097523700980'] },
  '09.00.431.jpeg': { pn: ['WLMT0-T22B6ABC2-A6'], ns: ['26172525700892', '26173525701443'] },
  '09.001.36.jpeg': { pn: ['DS2278-SR00007ZZWW', 'CBA-U21-S07ZBR', 'CR2278-PC10004WW'], ns: ['25113523703776', '25134523705759'] },
  // The serial number printed on this box was scribbled over; its barcodes still carry it.
  '09.001.40.jpeg': { pn: ['ET40AB-001C1B0-A6'], ns: ['24347524701910'] },
  '09.010.139.jpeg': { pn: ['MC330X-GE4EG4RW'], ns: ['24118525100190'] },
};

let photos: Map<string, Photo>;
let rotated: Map<string, Photo>;
let catalog: CatalogIndex;
let catalogPns: string[];

async function load(path: string): Promise<Map<string, Photo>> {
  const list = JSON.parse(await readFile(path, 'utf8')) as Photo[];
  return new Map(list.map(photo => [photo.file, photo]));
}

beforeAll(async () => {
  photos = await load('tests/fixtures/label-photos.json');
  rotated = await load('tests/fixtures/label-photos-rotated.json');
  const service = await createWorkbookService(new Uint8Array(await readFile('assets/catalog/sb1-produtos.xlsx')), 'fotos');
  catalogPns = service.catalog.products.map(product => product.pn);
  catalog = createCatalogIndex(catalogPns);
});

function decideAfter(file: string, frames: number, savedSerials: ReadonlySet<string> = new Set(), set = photos, index = catalog): Decision {
  const photo = set.get(file)!;
  const pool = new ReadingPool();
  let decision: Decision | undefined;
  for (let frame = 0; frame < frames; frame += 1) {
    pool.addFrame(analyzeLabel(photo, index));
    decision = pool.decide({ savedSerials });
  }
  return decision!;
}

function ready(decision: Decision) {
  expect(decision.status).toBe('ready');
  return decision as Extract<Decision, { status: 'ready' }>;
}

describe('fotos reais das etiquetas', () => {
  it('cobre todas as fotos registradas, nas duas orientações', () => {
    expect([...photos.keys()].sort()).toEqual(Object.keys(TRUTH).sort());
    expect([...rotated.keys()].sort()).toEqual(Object.keys(TRUTH).sort());
  });

  it('nenhum valor errado recebe confiança alta', () => {
    for (const set of [photos, rotated]) {
      for (const [file, photo] of set) {
        for (const reading of analyzeLabel(photo, catalog).readings) {
          if (reading.confidence !== 'alta') continue;
          expect(TRUTH[file]![reading.field], `${file}: ${reading.field} ${reading.value}`).toContain(reading.value);
        }
      }
    }
  });

  it('foto deitada como a câmera grava: posições na imagem em pé e mesmas decisões', () => {
    for (const [file, photo] of rotated) {
      expect([photo.width, photo.height], file).toEqual([photos.get(file)!.width, photos.get(file)!.height]);
    }
    for (const file of ['09.00.27.jpeg', '09.00.30.jpeg', '09.00.318.jpeg', '09.00.32.jpeg', '09.00.33.jpeg', '09.00.36.jpeg', '09.00.31.jpeg', '09.001.40.jpeg']) {
      const decision = ready(decideAfter(file, 1, new Set(), rotated));
      expect([decision.pn.value, decision.ns.value], file).toEqual([TRUTH[file]!.pn[0], TRUTH[file]!.ns[0]]);
    }
    const kit = decideAfter('09.001.36.jpeg', 2, new Set(), rotated);
    expect(kit.status).toBe('multiple');
    expect((kit as Extract<Decision, { status: 'multiple' }>).options.map(option => [option.ns.value, option.pn?.value])).toEqual(expect.arrayContaining([
      ['25113523703776', 'DS2278-SR00007ZZWW'], ['25134523705759', 'CR2278-PC10004WW'],
    ]));
  });

  it('etiquetas com código de PN e NS ficam prontas na primeira foto', () => {
    for (const file of ['09.00.27.jpeg', '09.00.30.jpeg', '09.00.318.jpeg', '09.00.32.jpeg', '09.00.33.jpeg', '09.00.36.jpeg']) {
      const decision = ready(decideAfter(file, 1));
      expect([decision.pn.value, decision.ns.value], file).toEqual([TRUTH[file]!.pn[0], TRUTH[file]!.ns[0]]);
      expect([decision.pn.confidence, decision.ns.confidence], file).toEqual(['alta', 'alta']);
    }
  });

  it('NS lido só pelo texto, inclusive quebrado em grupos, é confirmado na segunda foto', () => {
    for (const file of ['09.00.139.jpeg', '09.00.40.jpeg', '09.010.139.jpeg']) {
      expect(decideAfter(file, 1).status, file).toBe('searching');
      const decision = ready(decideAfter(file, 2));
      expect([decision.pn.value, decision.ns.value], file).toEqual([TRUTH[file]!.pn[0], TRUTH[file]!.ns[0]]);
    }
  });

  it('PN fora do catálogo lido só pelo texto nunca é dado como certo', () => {
    for (const file of ['09.00.37.jpeg', '09.00.38.jpeg']) {
      const decision = ready(decideAfter(file, 2));
      expect(decision.ns.value, file).toBe(TRUTH[file]!.ns[0]);
      expect(decision.pn.confidence, file).not.toBe('alta');
    }
  });

  it('PDF417 com campos separados por TAB não vira PN e mostra as duas caixas empilhadas', () => {
    const decision = decideAfter('09.00.431.jpeg', 1);
    expect(decision.status).toBe('multiple');
    const options = (decision as Extract<Decision, { status: 'multiple' }>).options;
    expect(options.map(option => option.ns.value).sort()).toEqual(TRUTH['09.00.431.jpeg']!.ns);
    expect(options.map(option => option.pn?.value)).toEqual(['WLMT0-T22B6ABC2-A6', 'WLMT0-T22B6ABC2-A6']);
  });

  it('impressoras: NS do DataMatrix GS1 (8004) confirmado pelo texto; ZT230 sem PN pede para escolher o PN', () => {
    const decision = decideAfter('09.00.217.jpeg', 3);
    expect(decision.status).toBe('searching');
    const searching = decision as Extract<Decision, { status: 'searching' }>;
    expect(searching.ns).toMatchObject({ value: '52N222300499', confidence: 'alta' });
    expect(searching.pn).toBeUndefined();
    expect(searching.hint).toContain('não mostra o PN');
  });

  it('kit DS2278: espera a etiqueta central e, depois de salva, oferece a outra unidade com o PN dela', () => {
    const first = decideAfter('09.001.36.jpeg', 1);
    expect(first.status).toBe('searching');
    expect((first as Extract<Decision, { status: 'searching' }>).pn?.value).toBe('DS2278-SR00007ZZWW');
    const central = ready(decideAfter('09.001.36.jpeg', 2));
    expect([central.pn.value, central.ns.value]).toEqual(['DS2278-SR00007ZZWW', '25113523703776']);
    const next = ready(decideAfter('09.001.36.jpeg', 1, new Set(['25113523703776'])));
    expect([next.pn.value, next.ns.value]).toEqual(['CR2278-PC10004WW', '25134523705759']);
  });

  it('sem o PN ou sem o NS legível, continua procurando sem inventar valor', () => {
    expect(decideAfter('09.00.31.jpeg', 3)).toMatchObject({ status: 'searching', ns: { value: '13317000503377' } });
    expect(decideAfter('09.001.40.jpeg', 3)).toMatchObject({ status: 'searching', pn: { value: 'ET40AB-001C1B0-A6' } });
    expect((decideAfter('09.001.40.jpeg', 3) as Extract<Decision, { status: 'searching' }>).ns).toBeUndefined();
  });
});

describe('PN já contado', () => {
  const OUTSIDE_CATALOG = ['09.00.37.jpeg', '09.00.38.jpeg'];

  it('PN fora do catálogo já contado: lido com letras parecidas vale na hora; com um caractere a mais é corrigido e conferido', () => {
    const counted = createCatalogIndex(catalogPns, ['DS9908-SR00004ZZWW', 'DS2278-SR00007ZZWW']);
    // 09.00.38 reads "SROO0072ZWW" (O/0 and Z/2); 09.00.37 reads "SRO0004ZZVWW", one character more, as a sibling model could.
    const expected: Record<string, 'alta' | 'media'> = { '09.00.38.jpeg': 'alta', '09.00.37.jpeg': 'media' };
    for (const file of OUTSIDE_CATALOG) {
      const before = analyzeLabel(photos.get(file)!, catalog).readings.find(reading => reading.field === 'pn')!;
      // Without history the OCR misread ("ZZVWW", "72ZWW") is only a probable value.
      expect(before.value, file).not.toBe(TRUTH[file]!.pn[0]);
      const pn = analyzeLabel(photos.get(file)!, counted).readings.find(reading => reading.field === 'pn')!;
      expect(pn, file).toMatchObject({ value: TRUTH[file]!.pn[0], confidence: expected[file] });
      expect(pn.evidence, file).toContain('historico');
      // The serial was read only from text, so the second photo confirms it either way.
      expect(decideAfter(file, 1, new Set(), photos, counted).status, file).toBe('searching');
      const decision = ready(decideAfter(file, 2, new Set(), photos, counted));
      expect([decision.pn.value, decision.pn.confidence, decision.ns.value], file).toEqual([TRUTH[file]!.pn[0], expected[file], TRUTH[file]!.ns[0]]);
    }
  });

  it('PN salvo durante a leitura passa a ser reconhecido sem recriar o índice', () => {
    const index = createCatalogIndex(catalogPns);
    expect(index.seen('DS2278-SR00007ZZWW')).toBe(false);
    index.remember('ds2278-sr00007zzww');
    expect(index.seen('DS2278-SR00007ZZWW')).toBe(true);
    expect(analyzeLabel(photos.get('09.00.38.jpeg')!, index).readings.find(reading => reading.field === 'pn'))
      .toMatchObject({ value: 'DS2278-SR00007ZZWW', confidence: 'alta' });
  });

  it('nenhum valor errado recebe confiança alta, mesmo com todos os PN das fotos já contados', () => {
    const counted = createCatalogIndex(catalogPns, Object.values(TRUTH).flatMap(truth => truth.pn));
    for (const set of [photos, rotated]) {
      for (const [file, photo] of set) {
        for (const reading of analyzeLabel(photo, counted).readings) {
          if (reading.confidence !== 'alta') continue;
          expect(TRUTH[file]![reading.field], `${file}: ${reading.field} ${reading.value}`).toContain(reading.value);
        }
      }
    }
  });

  it('PN já contado não muda o NS escolhido nem a espera pela etiqueta central do kit', () => {
    const counted = createCatalogIndex(catalogPns, ['DS2278-SR00007ZZWW', 'CR2278-PC10004WW']);
    const central = ready(decideAfter('09.001.36.jpeg', 2, new Set(), photos, counted));
    expect([central.pn.value, central.ns.value]).toEqual(['DS2278-SR00007ZZWW', '25113523703776']);
    const next = ready(decideAfter('09.001.36.jpeg', 1, new Set(['25113523703776']), photos, counted));
    expect([next.pn.value, next.ns.value]).toEqual(['CR2278-PC10004WW', '25134523705759']);
  });
});
