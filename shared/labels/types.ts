export type Box = { x: number; y: number; width: number; height: number };
export type BarcodeRead = { value: string; format?: string; box?: Box };
export type TextLineRead = { text: string; box?: Box; block?: number };
export type LabelScan = { width?: number; height?: number; barcodes: BarcodeRead[]; lines: TextLineRead[] };

export type LabelField = 'pn' | 'ns';
export type Confidence = 'alta' | 'media' | 'baixa';
export type Evidence =
  | 'codigo'              // decoded barcode: exact characters, protected by the symbology checksum
  | 'identificador'       // ANSI MH10.8.2 data identifier (1P, S) or ISO 15434 field
  | 'rotulo'              // printed next to "P/N", "Part Number", "S/N", "Serial No."...
  | 'catalogo'            // known part number (SB1 catalog or already counted), read as it is or with look-alike characters
  | 'catalogo-aproximado' // printed text close to a single known part number: a suggestion to compare with the label
  | 'padrao'              // matches the serial layouts found on the labels
  | 'texto'               // read from printed characters (OCR)
  | 'digitos-corrigidos'  // OCR letters mapped to digits by the serial layout
  | 'historico'           // part number already counted by this account
  | 'fixado';             // part number kept from the previous unit

export type Reading = {
  field: LabelField;
  value: string;
  raw: string;
  source: 'barcode' | 'ocr';
  evidence: Evidence[];
  confidence: Confidence;
  box?: Box;
};

export type LabelAnalysis = {
  readings: Reading[];
  // Serial number -> part number printed on the same label, and whether that part number is only a suggestion.
  pairs: { ns: string; pn: string; suggested?: true }[];
  // Serial number of the label at the center of the photo, when it clearly stands out.
  focus?: string;
  // Different serial numbers in this photo; more than one means several labels are in view.
  serials: number;
};

export const RANK: Record<Confidence, number> = { baixa: 0, media: 1, alta: 2 };
