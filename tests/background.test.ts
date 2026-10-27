import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  defineTask: vi.fn(),
  isTaskRegisteredAsync: vi.fn(),
  getStatusAsync: vi.fn(),
  registerTaskAsync: vi.fn(),
  unregisterTaskAsync: vi.fn(),
  restoreSession: vi.fn(),
  storageReady: vi.fn(),
  openServices: vi.fn(),
  sync: vi.fn(),
}));
vi.mock('expo-task-manager', () => ({ defineTask: mocks.defineTask, isTaskRegisteredAsync: mocks.isTaskRegisteredAsync }));
vi.mock('expo-background-task', () => ({
  BackgroundTaskResult: { Success: 1, Failed: 2 },
  BackgroundTaskStatus: { Restricted: 1, Available: 2 },
  getStatusAsync: mocks.getStatusAsync,
  registerTaskAsync: mocks.registerTaskAsync,
  unregisterTaskAsync: mocks.unregisterTaskAsync,
}));
vi.mock('../src/google', () => ({ restoreSession: mocks.restoreSession }));
vi.mock('../src/database', () => ({ storageReadyForBackground: mocks.storageReady }));
vi.mock('../src/services', () => ({ openServices: mocks.openServices }));

const { OUTBOX_TASK, disableBackgroundSending, enableBackgroundSending, runOutboxTask } = await import('../src/backgroundSend');
// Copied before any test runs: the call happens when the module loads.
const definedTasks = mocks.defineTask.mock.calls.slice();
const user = { sub: '123', email: 'ana@ytechsolucoes.com', name: 'Ana' };

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.storageReady.mockResolvedValue(true);
  mocks.openServices.mockResolvedValue({ outbox: { sync: mocks.sync } });
});

describe('envio em segundo plano', () => {
  it('define a tarefa ao carregar o bundle, antes de qualquer tela', () => {
    expect(definedTasks).toEqual([[OUTBOX_TASK, runOutboxTask]]);
  });

  it('envia a fila da conta conectada em modo segundo plano', async () => {
    mocks.restoreSession.mockResolvedValue(user);
    mocks.sync.mockResolvedValue(true);
    expect(await runOutboxTask()).toBe(1);
    expect(mocks.sync).toHaveBeenCalledWith('123', { background: true });
  });

  it('não abre o banco sem sessão e não propaga falhas', async () => {
    mocks.restoreSession.mockResolvedValue(null);
    expect(await runOutboxTask()).toBe(1);
    expect(mocks.openServices).not.toHaveBeenCalled();
    mocks.restoreSession.mockResolvedValue(user);
    mocks.sync.mockRejectedValue(new Error('Gmail fora do ar'));
    expect(await runOutboxTask()).toBe(2);
  });

  it('deixa para o app aberto criar ou migrar o banco', async () => {
    mocks.restoreSession.mockResolvedValue(user);
    mocks.storageReady.mockResolvedValue(false);
    expect(await runOutboxTask()).toBe(1);
    expect(mocks.openServices).not.toHaveBeenCalled();
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it('registra somente quando o sistema permite e desfaz no logout', async () => {
    mocks.getStatusAsync.mockResolvedValue(1);
    expect(await enableBackgroundSending()).toBe(false);
    expect(mocks.registerTaskAsync).not.toHaveBeenCalled();
    mocks.getStatusAsync.mockResolvedValue(2);
    expect(await enableBackgroundSending()).toBe(true);
    expect(mocks.registerTaskAsync).toHaveBeenCalledWith(OUTBOX_TASK, { minimumInterval: 15 });
    mocks.isTaskRegisteredAsync.mockResolvedValue(true);
    await disableBackgroundSending();
    expect(mocks.unregisterTaskAsync).toHaveBeenCalledWith(OUTBOX_TASK);
  });
});
