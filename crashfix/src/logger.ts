import { appendFileSync } from 'node:fs';

export interface Logger {
  info(m: string, x?: unknown): void;
  warn(m: string, x?: unknown): void;
  error(m: string, x?: unknown): void;
  child(scope: string): Logger;
}

type Level = 'info' | 'warn' | 'error';

// ponytail: JSON-lines to stderr + optional append-only file. No rotation, no
// async writes, no levels config — add when a real need shows up.
function make(file: string | undefined, scope: string): Logger {
  const emit = (level: Level, m: string, x?: unknown) => {
    const rec: Record<string, unknown> = { t: new Date().toISOString(), level, msg: m };
    if (scope) rec.scope = scope;
    if (x !== undefined) rec.data = x instanceof Error ? { message: x.message, stack: x.stack } : x;
    const line = JSON.stringify(rec);
    process.stderr.write(line + '\n');
    if (file) {
      try {
        appendFileSync(file, line + '\n');
      } catch {
        /* logging must never throw */
      }
    }
  };
  return {
    info: (m, x) => emit('info', m, x),
    warn: (m, x) => emit('warn', m, x),
    error: (m, x) => emit('error', m, x),
    child: (s) => make(file, scope ? `${scope}:${s}` : s),
  };
}

export function createLogger(file?: string): Logger {
  return make(file, '');
}
