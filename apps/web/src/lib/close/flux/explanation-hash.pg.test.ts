/**
 * The review pin's TS hash must equal migration 187's CHECK expression byte-for-byte
 * (unicode, newlines, null category / text) — checked against a real Postgres (PGlite).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { explanationHash } from './explanations';

let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.waitReady;
}, 60_000);
afterAll(async () => {
  await db?.close();
});

const SQL = `select encode(sha256(convert_to(coalesce($1::text, '') || chr(10) || coalesce($2::text, ''), 'UTF8')), 'hex') as h`;

describe('explanationHash ≡ mig-187 CHECK expression', () => {
  it.each([
    ['TIMING', 'Insurance renewal paid a month early.'],
    ['ONE_TIME', 'Compressor — new vendor “Mech Co” · €1.200 · 日本語\nsecond line\r\nthird'],
    [null, 'no category yet'],
    ['PRICE', null],
    [null, null],
  ])('category=%j text=%j', async (category, text) => {
    const { rows } = await db.query<{ h: string }>(SQL, [category, text]);
    expect(explanationHash(category, text)).toBe(rows[0].h);
  });
});
