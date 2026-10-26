import { Directory, File, Paths } from 'expo-file-system';
import { analyzeLabelImage } from '../modules/label-reader';

// Development aid: analyzes label photos copied to files/label-eval and stores the raw ML Kit output,
// so the PN/NS classifier can be measured against real labels and kept as regression fixtures.
export async function runLabelEvaluation(): Promise<{ count: number; uri: string }> {
  const directory = new Directory(Paths.document, 'label-eval');
  if (!directory.exists) throw new Error('Pasta label-eval ausente no aparelho.');
  const results: unknown[] = [];
  for (const entry of directory.list()) {
    if (!(entry instanceof File) || !/\.(jpe?g|png)$/i.test(entry.name)) continue;
    const started = Date.now();
    try {
      const scan = await analyzeLabelImage(entry.uri, { maxSide: 4096 });
      // Every symbology, to find codes on the labels that the production formats would miss.
      const everything = await analyzeLabelImage(entry.uri, { maxSide: 4096, text: false, formats: [] });
      results.push({ file: entry.name, totalMs: Date.now() - started, ...scan, allBarcodes: everything.barcodes });
    } catch (error) {
      results.push({ file: entry.name, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const output = new File(directory, 'results.json');
  if (output.exists) output.delete();
  output.create();
  output.write(JSON.stringify(results));
  return { count: results.length, uri: output.uri };
}
