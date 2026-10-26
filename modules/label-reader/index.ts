import { requireNativeModule } from 'expo';
import type { LabelScan } from '../../shared/labels';

export type AnalyzeOptions = {
  // Longest side, in pixels, of the image handed to ML Kit.
  maxSide?: number;
  barcodes?: boolean;
  text?: boolean;
  formats?: string[];
};

type NativeLabelReader = {
  analyzeAsync(uri: string, options: AnalyzeOptions): Promise<LabelScan & { elapsedMs: number }>;
};

const LabelReader = requireNativeModule<NativeLabelReader>('LabelReader');

export function analyzeLabelImage(uri: string, options: AnalyzeOptions = {}) {
  return LabelReader.analyzeAsync(uri, options);
}
