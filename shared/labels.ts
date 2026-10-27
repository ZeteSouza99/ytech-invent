// The public API. Modules in ./labels also export internal helpers, so import from this file only.
export type { BarcodeRead, Box, Confidence, Evidence, LabelAnalysis, LabelField, LabelScan, Reading, TextLineRead } from './labels/types';
export { skeleton, strongSerial } from './labels/values';
export { createCatalogIndex, matchingProducts, type CatalogIndex, type CatalogMatch } from './labels/catalog';
export { classifyBarcode } from './labels/barcode';
export { analyzeLabel } from './labels/text';
export { ReadingPool, type Decision } from './labels/pool';
