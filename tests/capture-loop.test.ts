import { describe, expect, it, vi } from 'vitest';
import { captureLoop } from '../src/captureLoop';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('ciclo de vida da foto temporária', () => {
  it('cancelar durante a captura ainda apaga a foto e espera a exclusão', async () => {
    const shot = deferred<{ uri: string; captureMs: number }>();
    const removal = deferred<void>();
    let active = true;
    const analyze = vi.fn(async () => 'texto');
    const discard = vi.fn(() => removal.promise);
    const complete = vi.fn();
    const job = captureLoop({
      capture: () => shot.promise, analyze, discard, continue: () => active,
      result: vi.fn(), error: vi.fn(), cleanupError: vi.fn(), delay: async () => undefined,
    }).then(complete);
    active = false;
    shot.resolve({ uri: 'file:///photo.jpg', captureMs: 10 });
    await vi.waitFor(() => expect(discard).toHaveBeenCalledWith('file:///photo.jpg'));
    expect(analyze).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    removal.resolve();
    await job;
    expect(complete).toHaveBeenCalledOnce();
  });

  it('cancelar durante OCR descarta o resultado e ainda limpa a foto', async () => {
    const recognition = deferred<string>();
    let active = true;
    const result = vi.fn();
    const analyze = vi.fn(() => recognition.promise);
    const discard = vi.fn(async () => undefined);
    const job = captureLoop({
      capture: async () => ({ uri: 'file:///photo.jpg', captureMs: 1 }), analyze, discard,
      continue: () => active, result, error: vi.fn(), cleanupError: vi.fn(), delay: async () => undefined,
    });
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledOnce());
    active = false;
    recognition.resolve('NS0001');
    await job;
    expect(result).not.toHaveBeenCalled();
    expect(discard).toHaveBeenCalledOnce();
  });

  it('falhas de OCR e limpeza são reportadas separadamente', async () => {
    let active = true;
    const error = vi.fn();
    const cleanupError = vi.fn(() => { active = false; });
    await captureLoop({
      capture: async () => ({ uri: 'file:///photo.jpg', captureMs: 1 }),
      analyze: async () => { throw new Error('OCR'); },
      discard: async () => { throw new Error('armazenamento'); },
      continue: () => active, result: vi.fn(), error, cleanupError, delay: async () => undefined,
    });
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: 'OCR' }));
    expect(cleanupError).toHaveBeenCalledOnce();
  });
});
