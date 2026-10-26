import { File, Paths } from 'expo-file-system';

// Development aid (temporary): keeps what the reader saw during a real run, so it can be replayed offline.
const MAX_EVENTS = 600;
const events: unknown[] = [];
let scheduled = false;

export function recordScan(event: Record<string, unknown>): void {
  if (!__DEV__ || process.env.EXPO_PUBLIC_RECORD_SCANS !== 'true') return;
  events.push({ t: Date.now(), ...event });
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    try {
      const file = new File(Paths.document, 'scan-log.json');
      if (!file.exists) file.create();
      file.write(JSON.stringify(events));
    } catch (error) {
      console.warn('[scan-log] não foi possível gravar', error);
    }
  }, 1500);
}
