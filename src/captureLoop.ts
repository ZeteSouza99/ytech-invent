// A single photo is owned until analysis AND deletion finish. Callers can cancel
// while native work is pending; the photo is still deleted before this resolves.
export async function captureLoop<T>(options: {
  capture: () => Promise<{ uri?: string; captureMs: number }>;
  analyze: (uri: string) => Promise<T>;
  discard: (uri: string) => Promise<void>;
  continue: () => boolean;
  result: (result: T, captureMs: number) => void;
  error: (error: unknown) => void;
  cleanupError: () => void;
  delay: () => Promise<void>;
}): Promise<void> {
  while (options.continue()) {
    let uri: string | undefined;
    let retry = false;
    try {
      const photo = await options.capture();
      uri = photo.uri;
      if (!uri || !options.continue()) break;
      const result = await options.analyze(uri);
      if (options.continue()) options.result(result, photo.captureMs);
    } catch (error) {
      if (options.continue()) { options.error(error); retry = true; }
    } finally {
      if (uri) {
        try { await options.discard(uri); }
        catch { options.cleanupError(); }
      }
    }
    if (retry && options.continue()) await options.delay();
  }
}
