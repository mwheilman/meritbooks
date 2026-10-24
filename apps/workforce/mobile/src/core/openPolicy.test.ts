import { describe, expect, it } from 'vitest';
import { OpenFailedError, isKeyMismatch, openWithRecovery } from './openPolicy';

const noSleep = { sleep: async () => undefined };

function opener(failures: Array<Error | null>) {
  let i = 0;
  const calls = { open: 0, destroy: 0 };
  return {
    calls,
    open: async () => {
      calls.open += 1;
      const f = failures[i++] ?? null;
      if (f) throw f;
      return 'db';
    },
    destroy: async () => {
      calls.destroy += 1;
    },
  };
}

describe('opening the saved work', () => {
  it('recognises a key mismatch, and only that', () => {
    expect(isKeyMismatch(new Error('Error code 26: file is not a database'))).toBe(true);
    expect(isKeyMismatch(new Error('SQLITE_NOTADB'))).toBe(true);
    expect(isKeyMismatch(new Error('User interaction is not allowed (keychain)'))).toBe(false);
    expect(isKeyMismatch(new Error('database is locked'))).toBe(false);
    expect(isKeyMismatch(new Error('unable to open database file'))).toBe(false);
  });

  it('a confirmed key mismatch deletes the unreadable file once and opens a fresh one', async () => {
    const o = opener([new Error('file is not a database')]);
    await expect(openWithRecovery(o.open, o.destroy, noSleep)).resolves.toBe('db');
    expect(o.calls).toEqual({ open: 2, destroy: 1 });
  });

  it('a passing failure (key store busy) is retried and NOTHING is deleted', async () => {
    const o = opener([new Error('User interaction is not allowed'), null]);
    await expect(openWithRecovery(o.open, o.destroy, noSleep)).resolves.toBe('db');
    expect(o.calls).toEqual({ open: 2, destroy: 0 });
  });

  it('a failure that persists gives up with OpenFailedError (blocking screen) and never deletes', async () => {
    const busy = new Error('unable to open database file');
    const o = opener([busy, busy, busy, busy]);
    await expect(openWithRecovery(o.open, o.destroy, { ...noSleep, retries: 2 })).rejects.toBeInstanceOf(OpenFailedError);
    expect(o.calls).toEqual({ open: 3, destroy: 0 });
  });

  it('if the fresh database will not open either, it reports instead of looping', async () => {
    const o = opener([new Error('file is not a database'), new Error('disk I/O error')]);
    await expect(openWithRecovery(o.open, o.destroy, noSleep)).rejects.toBeInstanceOf(OpenFailedError);
    expect(o.calls).toEqual({ open: 2, destroy: 1 });
  });
});
