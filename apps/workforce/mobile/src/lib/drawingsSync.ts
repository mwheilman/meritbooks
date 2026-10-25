/**
 * Keep the current drawing set of my jobs on the phone (core/drawings.ts plans, lib/files.ts
 * stores). Single-flight; runs after today's work refreshes and when the Drawings screen opens.
 * The index (which revision each file is) is sealed in SQLite with the rest of the cache.
 */
import type { PhoneSheet } from '@/core/contract';
import { isCachedSheets, planCache, toCached, type CachedSheet } from '@/core/drawings';
import type { Api } from './api';
import { removeSheet, saveSheet, sheetOnDisk } from './files';
import { getJson, setJson } from './kv';

const INDEX = 'drawings.index';
const MANIFEST = 'drawings.manifest';

const isSheetList = (v: unknown): v is PhoneSheet[] => Array.isArray(v) && v.every((x) => typeof x === 'object' && x !== null && typeof (x as PhoneSheet).revisionId === 'string');

export async function drawingIndex(): Promise<{ sheets: CachedSheet[]; at: number | null; manifest: PhoneSheet[] }> {
  const [i, m] = await Promise.all([getJson(INDEX, isCachedSheets), getJson(MANIFEST, isSheetList)]);
  return { sheets: i?.value ?? [], at: i?.updatedAt ?? null, manifest: m?.value ?? [] };
}

export interface DrawingSyncReport {
  downloaded: number;
  removed: number;
  skipped: number;
  failed: number;
}

let running: Promise<DrawingSyncReport> | null = null;

export function syncDrawings(api: Api, jobIds: ReadonlyArray<string>, priority: ReadonlyArray<string>, onProgress?: (left: number) => void): Promise<DrawingSyncReport> {
  running ??= (async () => {
    const report: DrawingSyncReport = { downloaded: 0, removed: 0, skipped: 0, failed: 0 };
    if (!jobIds.length) return report;
    const { sheets: cached } = await drawingIndex();
    const fresh = await api.drawings(jobIds); // throws when offline: keep everything as it is
    const plan = planCache(fresh.sheets, cached, sheetOnDisk, priority);
    for (const r of plan.remove) {
      removeSheet(r.revisionId);
      report.removed += 1;
    }
    const kept: CachedSheet[] = [...plan.keep];
    let left = plan.download.length;
    for (const s of plan.download) {
      onProgress?.(left);
      left -= 1;
      if (s.url && (await saveSheet(s.revisionId, s.url))) {
        kept.push(toCached(s, Date.now()));
        report.downloaded += 1;
      } else report.failed += 1;
    }
    report.skipped = plan.skipped.length;
    await setJson(INDEX, kept);
    // without the one-hour links (they would only go stale on the phone)
    await setJson(MANIFEST, fresh.sheets.map((s) => ({ ...s, url: null })));
    onProgress?.(0);
    return report;
  })().finally(() => {
    running = null;
  });
  return running;
}
