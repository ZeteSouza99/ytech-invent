import { describe, expect, it } from 'vitest';
import {
  analyzeLabel, classifyBarcode, createCatalogIndex, ReadingPool, skeleton,
  type BarcodeRead, type LabelScan, type Reading, type TextLineRead,
} from '../shared/labels';

const catalog = createCatalogIndex([
  'WLMT0-T22B6ABC2-A6', 'MC3401-0G1R64SS-A6', 'MC330X-GE4EG4RW', 'ZT23142-T0A000FZ', 'ZT41142-T0A0000Z',
  'AP305C-1-WR', 'DS9208-SR00004NNWW', 'SAC-MC33-4SCHG-01', 'ET40AB-001C1B0-A6', 'MS4717-LU000R',
  'ZD22042-T0AG00EZ', 'TC200J-1KC111A6 BR', 'HMC3200-LI(H)', '53345', 'MC330K-GE4HG4RW',
]);

const GS = String.fromCharCode(29);
const RS = String.fromCharCode(30);
const EOT = String.fromCharCode(4);

function line(text: string, y: number, x = 100, height = 30, width = 600): TextLineRead {
  return { text, box: { x, y, width, height } };
}
function code(value: string, y: number, x = 100, height = 50, width = 500): BarcodeRead {
  return { value, box: { x, y, width, height } };
}
function values(readings: Reading[], field: 'pn' | 'ns') {
  return readings.filter(reading => reading.field === field).map(reading => [reading.value, reading.confidence]);
}

describe('códigos de barras: apenas PN e NS', () => {
  it('remove identificadores ANSI (1P) e (S) e descarta MAC, IP, data, quantidade, revisão e país', () => {
    expect(classifyBarcode({ value: '1PWLMT0-T22B6ABC2-A6' }, catalog)).toMatchObject([{ field: 'pn', value: 'WLMT0-T22B6ABC2-A6', confidence: 'alta' }]);
    expect(classifyBarcode({ value: 'S26172525700892' }, catalog)).toMatchObject([{ field: 'ns', value: '26172525700892', confidence: 'alta' }]);
    for (const value of ['88:BC:AC:9B:2A:6C', '88BCAC650A8C', '787D53FB98C0', '169.254.152.192', '07/16/2023', '13JUL22', '1', 'Q1', '2PF', '4LVN', 'D220713', 'VIET NAM', 'MADE IN TAIWAN', 'ZT231']) {
      expect(classifyBarcode({ value }, catalog), value).toEqual([]);
    }
  });

  it('reconhece séries Zebra de 14 dígitos e de impressoras, preservando zeros e o prefixo D do NS', () => {
    for (const value of ['03052211308046', '25150523023493', '99J242000740', 'T3N232800835', 'D5J242300912', '52N222300499']) {
      expect(classifyBarcode({ value }, catalog), value).toMatchObject([{ field: 'ns', value, confidence: 'alta' }]);
    }
  });

  it('PN sem identificador vale pelo catálogo; fora dele é só provável', () => {
    expect(classifyBarcode({ value: 'ZT23142-T0A000FZ' }, catalog)).toMatchObject([{ field: 'pn', confidence: 'alta' }]);
    expect(classifyBarcode({ value: 'CR2278-PC10004WW' }, catalog)).toMatchObject([{ field: 'pn', confidence: 'media' }]);
    expect(classifyBarcode({ value: '1PCR2278-PC10004WW' }, catalog)).toMatchObject([{ field: 'pn', value: 'CR2278-PC10004WW', confidence: 'alta' }]);
    expect(classifyBarcode({ value: '53345' }, catalog)).toMatchObject([{ field: 'pn', confidence: 'media' }]);
  });

  it('lê PN e NS do código 2D ISO 15434 das caixas', () => {
    const value = `[)>${RS}06${GS}1PWLMT0-T22B6ABC2-A6${GS}S26172525700892${GS}2PA${GS}4LVN${GS}Q1${RS}${EOT}`;
    const readings = classifyBarcode({ value }, catalog);
    expect(values(readings, 'pn')).toEqual([['WLMT0-T22B6ABC2-A6', 'alta']]);
    expect(values(readings, 'ns')).toEqual([['26172525700892', 'alta']]);
  });

  it('PDF417 com campos separados por TAB: PN e NS separados, sem juntar país e série ao PN', () => {
    const readings = classifyBarcode({ value: '1PMS4717-LU000R\tTW\tS22194520101338' }, catalog);
    expect(values(readings, 'pn')).toEqual([['MS4717-LU000R', 'alta']]);
    expect(values(readings, 'ns')).toEqual([['22194520101338', 'alta']]);
    expect(classifyBarcode({ value: 'TW\tVIET NAM' }, catalog)).toEqual([]);
  });

  it('DataMatrix GS1 das impressoras: NS no fim do GIAI (8004) e no AI 21', () => {
    expect(classifyBarcode({ value: `[)>${RS}05${GS}800466305699J242000740${RS}${EOT}` }, catalog))
      .toMatchObject([{ field: 'ns', value: '99J242000740', confidence: 'alta' }]);
    expect(values(classifyBarcode({ value: `[)>${RS}05${GS}010001234567890521AB12345678${RS}${EOT}` }, catalog), 'ns'))
      .toEqual([['AB12345678', 'media']]);
    // A GIAI that does not end in a known serial layout says nothing about the serial number.
    expect(classifyBarcode({ value: `[)>${RS}05${GS}8004663056ASSET0001${RS}${EOT}` }, catalog)).toEqual([]);
  });
});

describe('etiquetas completas (padrões das fotos)', () => {
  it('etiqueta de dispositivo MC3401: PN só impresso, NS no código; ignora WLAN e BT', () => {
    const scan: LabelScan = {
      width: 1600, height: 1200,
      lines: [
        line('MODEL( 型号 ): MC3401', 680), line('P/N:MC3401-0G1R64SS-A6', 715), line('(S) S/N: 25150523023493', 750),
        line('WLAN : 88BCAC650A8C', 785), line('MFD: 30MAY25', 830, 1000, 30, 200),
      ],
      barcodes: [code('25150523023493', 820), code('88BCAC650A8D', 200, 600, 300, 40)],
    };
    const result = analyzeLabel(scan, catalog);
    expect(values(result.readings, 'pn')).toEqual([['MC3401-0G1R64SS-A6', 'alta']]);
    expect(values(result.readings, 'ns')).toEqual([['25150523023493', 'alta']]);
    expect(result.readings.find(reading => reading.field === 'ns')!.evidence).toEqual(expect.arrayContaining(['codigo', 'rotulo']));
  });

  it('corrige pelo catálogo confusões de OCR no PN (O/0, S/5) quando há um único candidato', () => {
    const scan: LabelScan = { barcodes: [], lines: [line('P/N:MC34O1-0G1R64S5-A6', 100)] };
    expect(values(analyzeLabel(scan, catalog).readings, 'pn')).toEqual([['MC3401-0G1R64SS-A6', 'alta']]);
    const edited: LabelScan = { barcodes: [], lines: [line('P/N:MC3401-0G1R64SS-A', 100)] };
    expect(values(analyzeLabel(edited, catalog).readings, 'pn')).toEqual([['MC3401-0G1R64SS-A6', 'media']]);
  });

  it('impressora ZT231: rótulo acima, código no meio e valor abaixo; ignora quantidade, modelo e data', () => {
    const scan: LabelScan = {
      lines: [
        line('Quantity/Quantidade', 180, 80, 30, 330), line('Model/Modelo', 190, 450, 30, 200),
        line('1', 320, 190, 30, 30), line('ZT231', 320, 430, 30, 120),
        line('Part Number/Número da peça', 400, 120), line('ZT23142 – T0A000FZ', 560, 200, 60, 700),
        line('Serial Number / Numero de Serie', 650, 110), line('T3N232800835', 780, 260, 40, 280),
        line('Date/Data', 1290, 90, 30, 150), line('07/16/2023', 1360, 340, 30, 170),
      ],
      barcodes: [code('1', 220, 130, 70, 120), code('ZT231', 240, 430, 70, 200), code('ZT23142-T0A000FZ', 430, 130, 90, 730),
        code('T3N232800835', 680, 120, 70, 580), code('07/16/2023', 1300, 280, 60, 490)],
    };
    const result = analyzeLabel(scan, catalog);
    expect(values(result.readings, 'pn')).toEqual([['ZT23142-T0A000FZ', 'alta']]);
    expect(values(result.readings, 'ns')).toEqual([['T3N232800835', 'alta']]);
  });

  it('impressora ZT411: série abaixo de "Serial No./No. de Série" com caracteres chineses; ignora P1105959', () => {
    const scan: LabelScan = {
      lines: [
        line('Model/Modelo', 70), line('ZT411', 90, 560, 40, 150), line('Serial No./No. de Série', 145),
        line('FFJ 99J242000740', 185, 380, 35, 480), line('P1105959-001', 560, 390, 25, 120),
        line('Part Number: ZT41142–T0A0000Z', 455, 380, 35, 600), line('R-41004481', 520, 980, 25, 150),
      ],
      barcodes: [code('99J242000740', 160, 600, 60, 650), code('ZT41142-T0A0000Z', 480, 440, 40, 650)],
    };
    const result = analyzeLabel(scan, catalog);
    expect(values(result.readings, 'pn')).toEqual([['ZT41142-T0A0000Z', 'alta']]);
    expect(values(result.readings, 'ns')).toEqual([['99J242000740', 'alta']]);
  });

  it('Extreme AP305C: SN e P/N com código, descartando MAC e IP com código', () => {
    const scan: LabelScan = {
      lines: [line('SN: 03052211308046', 600), line('MAC: 787D53FB98C0', 660), line('P/N: AP305C-1-WR', 580, 860), line('IP: 169.254.152.192', 640, 860)],
      barcodes: [code('03052211308046', 560), code('787D53FB98C0', 620), code('AP305C-1-WR', 600, 860), code('169.254.152.192', 660, 860)],
    };
    const result = analyzeLabel(scan, catalog);
    expect(values(result.readings, 'pn')).toEqual([['AP305C-1-WR', 'alta']]);
    expect(values(result.readings, 'ns')).toEqual([['03052211308046', 'alta']]);
  });

  it('PN com espaços em volta dos hífens (SAC - MC33 - 4SCHG - 01) e NS só impresso é provável', () => {
    const scan: LabelScan = {
      lines: [line('Model (型号): SHARECRADLE-01', 100), line('P/N: SAC - MC33 - 4SCHG - 01', 140), line('(S) S/N: 21097523700980', 180), line('MFD:07APR21', 220), line('Factory ID: 5237', 260)],
      barcodes: [],
    };
    const result = analyzeLabel(scan, catalog);
    expect(values(result.readings, 'pn')).toEqual([['SAC-MC33-4SCHG-01', 'alta']]);
    expect(values(result.readings, 'ns')).toEqual([['21097523700980', 'media']]);
  });

  it('NS impresso com letras parecidas com dígitos fica com baixa confiança, nunca alta', () => {
    const scan: LabelScan = { barcodes: [], lines: [line('S/N: 2530252370O9S3', 100)] };
    expect(values(analyzeLabel(scan, catalog).readings, 'ns')).toEqual([['25302523700953', 'baixa']]);
  });

  it('texto lido errado ao lado do código vale pelo valor exato do código, no NS e no PN', () => {
    const serial: LabelScan = { lines: [line('(S) S/N: 25113523703778', 100)], barcodes: [code('S25113523703776', 150)] };
    expect(values(analyzeLabel(serial, catalog).readings, 'ns')).toEqual([['25113523703776', 'alta']]);
    const part: LabelScan = { lines: [line('P/N: DS2278-SR00007ZZVW', 100)], barcodes: [code('1PDS2278-SR00007ZZWW', 150)] };
    expect(values(analyzeLabel(part, catalog).readings, 'pn')).toEqual([['DS2278-SR00007ZZWW', 'alta']]);
    // Elsewhere in the photo, a text one digit away from a code-confirmed serial is still taken as its misread.
    const far: LabelScan = { lines: [line('S/N: 25113523703778', 100)], barcodes: [code('S25113523703776', 900)] };
    expect(values(analyzeLabel(far, catalog).readings, 'ns')).toEqual([['25113523703776', 'alta']]);
  });

  it('NS impresso em grupos ou com símbolos antes é reconstituído pelo padrão de série', () => {
    const grouped: LabelScan = { barcodes: [], lines: [line('(S)S/N: 241185251 00190', 100)] };
    expect(values(analyzeLabel(grouped, catalog).readings, 'ns')).toEqual([['24118525100190', 'media']]);
    const prefixed: LabelScan = { barcodes: [], lines: [line('Serial No./No. de Série', 100), line('F9|52N222300499', 150)] };
    expect(values(analyzeLabel(prefixed, catalog).readings, 'ns')).toEqual([['52N222300499', 'media']]);
  });

  it('PN fora do catálogo: zeros lidos como letra O em sequências de dígitos são ajustados, mas continua provável', () => {
    const scan: LabelScan = { barcodes: [], lines: [line('P/N :DS9908-SRO0004ZZWW', 100)] };
    expect(analyzeLabel(scan, catalog).readings).toMatchObject([
      { field: 'pn', value: 'DS9908-SR00004ZZWW', confidence: 'media', evidence: expect.arrayContaining(['digitos-corrigidos']) },
    ]);
    const doubled: LabelScan = { barcodes: [], lines: [line('PIN: DS2278--SROO007ZZWW', 100)] };
    expect(values(analyzeLabel(doubled, catalog).readings, 'pn')).toEqual([['DS2278-SR00007ZZWW', 'media']]);
  });

  it('o rótulo impresso decide o campo de um código ambíguo', () => {
    const scan: LabelScan = { lines: [line('S/N: AB12345678', 100)], barcodes: [code('AB12345678', 150)] };
    const result = analyzeLabel(scan, catalog);
    expect(values(result.readings, 'ns')).toEqual([['AB12345678', 'alta']]);
    expect(values(result.readings, 'pn')).toEqual([]);
  });

  it('PN fora do catálogo com rótulo e código é aceito; só com texto é provável', () => {
    const withCode: LabelScan = { lines: [line('(1P)PART NUMBER: DS2278-SR00007ZZWW', 100)], barcodes: [code('1PDS2278-SR00007ZZWW', 140)] };
    expect(values(analyzeLabel(withCode, catalog).readings, 'pn')).toEqual([['DS2278-SR00007ZZWW', 'alta']]);
    const textOnly: LabelScan = { lines: [line('P/N: DS2278-SR00007ZZWW', 100)], barcodes: [] };
    expect(values(analyzeLabel(textOnly, catalog).readings, 'pn')).toEqual([['DS2278-SR00007ZZWW', 'media']]);
  });

  it('kit com três itens: associa cada NS ao PN impresso acima dele', () => {
    const scan: LabelScan = {
      width: 1200, height: 1600,
      lines: [
        line('(1P)PART NUMBER: DS2278-SR00007ZZWW', 410), line('DS2278: AREA IMAGER, STANDARD RANGE', 460), line('(S)SERIAL NUMBER: 25113523703776', 540),
        line('(1P)PART NUMBER: CBA-U21-S07ZBR', 700), line('CABLE - SHIELDED USB', 750),
        line('(1P)PART NUMBER: CR2278-PC10004WW', 960), line('DS2278: PRESENTATION CRADLE', 1010), line('(S)SERIAL NUMBER: 25134523705759', 1090),
      ],
      barcodes: [
        code('1PDS2278-SR00007ZZWW', 490), code('S25113523703776', 590), code('1PCBA-U21-S07ZBR', 790),
        code('1PCR2278-PC10004WW', 1040), code('S25134523705759', 1140), code('4LVN', 150), code('Q1', 230),
      ],
    };
    const result = analyzeLabel(scan, catalog);
    expect(result.pairs).toEqual(expect.arrayContaining([
      { ns: '25113523703776', pn: 'DS2278-SR00007ZZWW' },
      { ns: '25134523705759', pn: 'CR2278-PC10004WW' },
    ]));
    const pool = new ReadingPool();
    pool.addFrame(result);
    const decision = pool.decide({ savedSerials: new Set() });
    expect(decision.status).toBe('multiple');
    if (decision.status === 'multiple') {
      expect(decision.options.map(option => [option.ns.value, option.pn?.value])).toEqual(expect.arrayContaining([
        ['25113523703776', 'DS2278-SR00007ZZWW'], ['25134523705759', 'CR2278-PC10004WW'],
      ]));
    }
  });

  it('caixas empilhadas: escolhe a etiqueta centralizada; sem centralização clara, pergunta', () => {
    const label = (offset: number, serial: string) => ({
      lines: [line('(1P) P/N: WLMT0-T22B6ABC2-A6', offset), line(`(S)SN: ${serial}`, offset + 60), line('WLAN: 88:BC:AC:9B:2A:6C', offset + 120)],
      barcodes: [code('1PWLMT0-T22B6ABC2-A6', offset + 30), code(`S${serial}`, offset + 90), code('88:BC:AC:9B:2A:6C', offset + 150)],
    });
    const top = label(500, '26172525700892');
    const bottom = label(1150, '26173525701443');
    const centered = analyzeLabel({ width: 1200, height: 1300, lines: [...top.lines, ...bottom.lines], barcodes: [...top.barcodes, ...bottom.barcodes] }, catalog);
    expect(centered.focus).toBe('26172525700892');
    const pool = new ReadingPool();
    pool.addFrame(centered);
    expect(pool.decide({ savedSerials: new Set() })).toMatchObject({ status: 'ready', pn: { value: 'WLMT0-T22B6ABC2-A6' }, ns: { value: '26172525700892' } });

    const even = analyzeLabel({ width: 1200, height: 1900, lines: [...top.lines, ...label(1300, '26173525701443').lines], barcodes: [...top.barcodes, ...label(1300, '26173525701443').barcodes] }, catalog);
    expect(even.focus).toBeUndefined();
    const second = new ReadingPool();
    second.addFrame(even);
    expect(second.decide({ savedSerials: new Set() }).status).toBe('multiple');
    expect(bottom.lines).toHaveLength(3);
  });
});

describe('decisão ao longo das fotos', () => {
  const pnLine = line('P/N: DS2278-SR00007ZZWW', 100);
  const nsLine = line('S/N: 25302523700953', 140);

  it('valor provável só é aceito quando se repete em outra foto', () => {
    const pool = new ReadingPool();
    pool.addFrame(analyzeLabel({ lines: [pnLine, nsLine], barcodes: [code('25302523700953', 180)] }, catalog));
    expect(pool.decide({ savedSerials: new Set() })).toMatchObject({ status: 'searching', ns: { value: '25302523700953' } });
    pool.addFrame(analyzeLabel({ lines: [pnLine, nsLine], barcodes: [code('25302523700953', 180)] }, catalog));
    expect(pool.decide({ savedSerials: new Set() })).toMatchObject({ status: 'ready', pn: { value: 'DS2278-SR00007ZZWW' } });
  });

  it('ignora o NS já salvo e avisa para apontar o próximo equipamento', () => {
    const pool = new ReadingPool();
    pool.addFrame(analyzeLabel({ lines: [line('P/N: AP305C-1-WR', 100)], barcodes: [code('03052211308046', 140), code('AP305C-1-WR', 120)] }, catalog));
    const decision = pool.decide({ savedSerials: new Set(['03052211308046']) });
    expect(decision.status).toBe('searching');
    expect(decision.status === 'searching' && decision.hint).toContain('já foi contado');
  });

  it('PN mantido: basta o NS, mas bloqueia etiqueta de outro PN', () => {
    const pool = new ReadingPool();
    pool.addFrame(analyzeLabel({ lines: [], barcodes: [code('S26172525700892', 100)] }, catalog));
    expect(pool.decide({ lockedPn: 'WLMT0-T22B6ABC2-A6', savedSerials: new Set() })).toMatchObject({ status: 'ready', pn: { value: 'WLMT0-T22B6ABC2-A6', evidence: ['fixado'] } });
    pool.addFrame(analyzeLabel({ lines: [], barcodes: [code('1PET40AB-001C1B0-A6', 60), code('S26172525700892', 100)] }, catalog));
    const decision = pool.decide({ lockedPn: 'WLMT0-T22B6ABC2-A6', savedSerials: new Set() });
    expect(decision.status).toBe('searching');
    expect(decision.status === 'searching' && decision.hint).toContain('diferente do PN mantido');
  });

  it('leituras antigas saem da decisão quando o usuário muda de etiqueta', () => {
    const pool = new ReadingPool();
    pool.addFrame(analyzeLabel({ lines: [], barcodes: [code('1PET40AB-001C1B0-A6', 60)] }, catalog));
    for (let index = 0; index < 3; index += 1) pool.addFrame(analyzeLabel({ lines: [], barcodes: [code('1PWLMT0-T22B6ABC2-A6', 60), code('S26172525700892', 100)] }, catalog));
    expect(pool.decide({ savedSerials: new Set() })).toMatchObject({ status: 'ready', pn: { value: 'WLMT0-T22B6ABC2-A6' } });
    pool.reset();
    expect(pool.decide({ savedSerials: new Set() }).status).toBe('searching');
  });

  it('leitura ao vivo de um código 2D completo resolve sem foto', () => {
    const pool = new ReadingPool();
    pool.addLive(classifyBarcode({ value: `[)>${RS}06${GS}1PMS4717-LU000R${GS}S22194520101338${RS}${EOT}` }, catalog));
    expect(pool.decide({ savedSerials: new Set() })).toMatchObject({ status: 'ready', pn: { value: 'MS4717-LU000R' }, ns: { value: '22194520101338' } });
  });

  it('com o NS central ainda em confirmação, espera por ele em vez de escolher o da borda', () => {
    const scan: LabelScan = {
      width: 1200, height: 1600,
      lines: [line('(1P)PART NUMBER: DS2278-SR00007ZZWW', 560, 300), line('(S)SERIAL NUMBER: 25113523703776', 620, 300)],
      barcodes: [code('1PCR2278-PC10004WW', 1450, 300), code('S25134523705759', 1510, 300)],
    };
    const pool = new ReadingPool();
    pool.addFrame(analyzeLabel(scan, catalog));
    expect(pool.decide({ savedSerials: new Set() })).toMatchObject({
      status: 'searching', ns: { value: '25113523703776' }, pn: { value: 'DS2278-SR00007ZZWW' }, hint: expect.stringContaining('Confirmando o NS'),
    });
    pool.addFrame(analyzeLabel(scan, catalog));
    expect(pool.decide({ savedSerials: new Set() })).toMatchObject({ status: 'ready', pn: { value: 'DS2278-SR00007ZZWW' }, ns: { value: '25113523703776' } });
  });

  it('dois NS sem foco claro, um deles ainda provável: pede para centralizar a etiqueta', () => {
    const scan: LabelScan = { width: 1200, height: 1600, lines: [line('S/N: 25113523703776', 385, 300)], barcodes: [code('S25134523705759', 1175, 300)] };
    const pool = new ReadingPool();
    pool.addFrame(analyzeLabel(scan, catalog));
    const decision = pool.decide({ savedSerials: new Set() });
    expect(decision.status).toBe('searching');
    expect(decision.status === 'searching' && decision.hint).toContain('mais de um NS');
  });

  it('erro de OCR numa foto não trava a decisão quando outra foto confirmou o NS pelo código', () => {
    const pnLine = line('P/N: DS2278-SR00007ZZWW', 100);
    const pool = new ReadingPool();
    pool.addFrame(analyzeLabel({ lines: [pnLine], barcodes: [code('S25113523703776', 300)] }, catalog));
    expect(pool.decide({ savedSerials: new Set() }).status).toBe('searching');
    pool.addFrame(analyzeLabel({ lines: [pnLine, line('S/N: 25113523703778', 300)], barcodes: [] }, catalog));
    expect(pool.decide({ savedSerials: new Set() })).toMatchObject({
      status: 'ready', pn: { value: 'DS2278-SR00007ZZWW' }, ns: { value: '25113523703776' },
    });
  });

  it('ao passar para outra etiqueta, vale o NS lido na foto mais recente', () => {
    const pool = new ReadingPool();
    pool.addFrame(analyzeLabel({ lines: [], barcodes: [code('S22192520100839', 100)] }, catalog));
    expect(pool.decide({ savedSerials: new Set() }).status).toBe('searching');
    pool.addFrame(analyzeLabel({ lines: [], barcodes: [code('1PAP305C-1-WR', 60), code('S03052211308046', 100)] }, catalog));
    expect(pool.decide({ savedSerials: new Set() })).toMatchObject({ status: 'ready', pn: { value: 'AP305C-1-WR' }, ns: { value: '03052211308046' } });
  });
});

describe('índice do catálogo', () => {
  it('lê PNs do catálogo com espaços, parênteses e sinais, impressos ou em código', () => {
    const special = createCatalogIndex(['TC200J-1KC111A6 BR', 'HMC3200-LI(H)', 'PN=PD-9001GR-ENT_SC', 'CZ IP6 888191', 'WB CAPA MC93G']);
    for (const pn of ['TC200J-1KC111A6 BR', 'HMC3200-LI(H)', 'PN=PD-9001GR-ENT_SC', 'CZ IP6 888191', 'WB CAPA MC93G']) {
      expect(classifyBarcode({ value: pn }, special), pn).toMatchObject([{ field: 'pn', value: pn, confidence: 'alta' }]);
      expect(values(analyzeLabel({ barcodes: [], lines: [line(`P/N: ${pn}`, 100)] }, special).readings, 'pn'), pn).toEqual([[pn, 'alta']]);
    }
  });

  it('não adivinha quando dois PNs do catálogo ficam a um caractere de distância', () => {
    const ambiguous = createCatalogIndex(['MC330K-GE4HG4RW', 'MC330K-GE4HG4RX']);
    expect(ambiguous.match('MC330K-GE4HG4R')).toBeNull();
    expect(createCatalogIndex(['MC330K-GE4HG4RW']).match('MC330K-GE4HG4R')).toEqual({ value: 'MC330K-GE4HG4RW', kind: 'approximate' });
    expect(skeleton('DS9208-SR00004NNWW')).toBe(skeleton('D59208-5R0OO04NNWW'));
    expect(catalog.match('TC200J-1KC111A6 BR')).toEqual({ value: 'TC200J-1KC111A6 BR', kind: 'exact' });
  });
});

describe('PN já contado (histórico)', () => {
  const NS = '25150523023493';
  function label(pn: string): LabelScan {
    return { barcodes: [code(NS, 820)], lines: [line(`P/N: ${pn}`, 715), line(`(S) S/N: ${NS}`, 750)] };
  }
  function firstPhoto(scan: LabelScan, index: typeof catalog) {
    const pool = new ReadingPool();
    pool.addFrame(analyzeLabel(scan, index));
    return pool.decide({ savedSerials: new Set() });
  }

  it('PN contado lido como está, ou com letras parecidas (O/0), fica pronto na primeira foto', () => {
    const counted = createCatalogIndex(['MC3401-0G1R64SS-A6'], ['CR2278-PC10004WW']);
    for (const text of ['CR2278-PC10004WW', 'CR2278-PC1OOO4WW']) {
      expect(values(analyzeLabel(label(text), counted).readings, 'pn'), text).toEqual([['CR2278-PC10004WW', 'alta']]);
      expect(firstPhoto(label(text), counted), text).toMatchObject({ status: 'ready', pn: { value: 'CR2278-PC10004WW' }, ns: { value: NS } });
    }
  });

  // A7 may be a sibling model of the counted A6 (as ZT41142 and ZT41143 differ only in resolution), not an OCR error.
  it('PN a um caractere de um PN contado não é confirmado na primeira foto', () => {
    const inCatalog = createCatalogIndex(['MC3401-0G1R64SS-A6'], ['MC3401-0G1R64SS-A6']);
    expect(values(analyzeLabel(label('MC3401-0G1R64SS-A7'), inCatalog).readings, 'pn')).toEqual([['MC3401-0G1R64SS-A6', 'media']]);
    expect(firstPhoto(label('MC3401-0G1R64SS-A7'), inCatalog).status).toBe('searching');
    const outsideCatalog = createCatalogIndex([], ['CR2278-PC10004WW']);
    expect(values(analyzeLabel(label('CR2278-PC10005WW'), outsideCatalog).readings, 'pn')).toEqual([['CR2278-PC10004WW', 'media']]);
    expect(firstPhoto(label('CR2278-PC10005WW'), outsideCatalog).status).toBe('searching');
  });

  // XT4100-82C3D4 may be another model beside the counted XT4100-B2C3D4. And DS2278-SR000072ZWW, a misreading
  // saved once, must not confirm the correct reading of DS2278-SR00007ZZWW from then on.
  it('leitura só parecida (B/8, Z/2) com um PN contado fora do catálogo é sugestão a conferir, não confirmação', () => {
    const counted = createCatalogIndex(['MC3401-0G1R64SS-A6'], ['XT4100-B2C3D4', 'DS2278-SR000072ZWW']);
    for (const text of ['XT4100-82C3D4', 'DS2278-SR00007ZZWW']) {
      const readings = analyzeLabel(label(text), counted).readings.filter(reading => reading.field === 'pn');
      expect(readings.map(reading => reading.confidence), text).toEqual(['media']);
      expect(readings[0]!.evidence, text).toContain('catalogo-aproximado');
      expect(firstPhoto(label(text), counted).status, text).toBe('searching');
    }
    // Catalog part numbers keep the look-alike correction they already had.
    expect(values(analyzeLabel(label('MC34O1-0G1R64S5-A6'), counted).readings, 'pn')).toEqual([['MC3401-0G1R64SS-A6', 'alta']]);
  });

  it('dígitos que o catálogo se recusou a corrigir não são confirmados pelo histórico', () => {
    // RT1O00-AB is as close to the catalog RT1OOO-AB as to the counted RT1000-AB.
    const ambiguous = createCatalogIndex(['RT1OOO-AB'], ['RT1000-AB']);
    expect(ambiguous.match('RT1O00-AB')).toBeNull();
    expect(values(analyzeLabel(label('RT1O00-AB'), ambiguous).readings, 'pn')).toEqual([['RT1000-AB', 'media']]);
    expect(firstPhoto(label('RT1O00-AB'), ambiguous).status).toBe('searching');
  });
});
