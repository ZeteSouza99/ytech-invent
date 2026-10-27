import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { storageReadyForBackground } from './database';
import { restoreSession } from './google';
import { openServices } from './services';

export const OUTBOX_TASK = 'ytech-invent-outbox';
// Android treats this as a minimum; the system decides the actual moment and requires a network connection.
const INTERVAL_MINUTES = 15;

export async function runOutboxTask(): Promise<BackgroundTask.BackgroundTaskResult> {
  try {
    const user = await restoreSession();
    if (!user) return BackgroundTask.BackgroundTaskResult.Success;
    // Creating or migrating the database is left to the app on screen, which may be starting at this moment.
    if (!await storageReadyForBackground()) return BackgroundTask.BackgroundTaskResult.Success;
    const { outbox } = await openServices();
    await outbox.sync(user.sub, { background: true });
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    // Nothing is lost: inventories stay in the local queue for the next attempt, in the background or with the app open.
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
}

// Defined when the bundle loads: Android may start the app only to run this task, with no screen mounted.
TaskManager.defineTask(OUTBOX_TASK, runOutboxTask);

export async function enableBackgroundSending(): Promise<boolean> {
  if (await BackgroundTask.getStatusAsync() !== BackgroundTask.BackgroundTaskStatus.Available) return false;
  await BackgroundTask.registerTaskAsync(OUTBOX_TASK, { minimumInterval: INTERVAL_MINUTES });
  return true;
}

export async function disableBackgroundSending(): Promise<void> {
  if (await TaskManager.isTaskRegisteredAsync(OUTBOX_TASK)) await BackgroundTask.unregisterTaskAsync(OUTBOX_TASK);
}
