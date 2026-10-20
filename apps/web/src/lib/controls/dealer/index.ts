/**
 * Dealer Pack exception detectors (FPB-dealer-pack §6) — the registry + the scan.
 *
 * `scanDealerControls(db, orgId, { locationId? })` runs every detector for every
 * client with the dealer pack ENABLED (or just the one client), through the caller's
 * RLS client, and returns counts. It never throws. DL-9 (interest variance) is not a
 * scan: D1 raises it at the API when billed interest is recorded (409
 * INTEREST_VARIANCE), so it has no detector here.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { todayIso } from '@/lib/dealer/dates';
import { loadSettings } from '@/lib/dealer/service/settings';
import type { DealerSettings } from '@/lib/dealer/types';
import { emptyPersist, persistDealerFindings, type DealerDetectorDef, type DealerFinding, type PersistSummary } from './shared';
import { SOT_DETECTOR } from './sot';
import { CURTAILMENT_DETECTOR, LINE_UTILIZATION_DETECTOR } from './floor-plan';
import { FLOOR_MISMATCH_DETECTOR } from './mismatch';
import { AGED_UNIT_DETECTOR, DEMO_ON_FLOOR_DETECTOR } from './units';
import { INCENTIVE_DETECTOR, WARRANTY_DETECTOR } from './receivables';
import { STATEMENT_VARIANCE_DETECTOR } from './statements';
import { TRADE_RISK_DETECTOR } from './trade-ins';
import { DOUBLE_FLOORING_DETECTOR } from './double-flooring';

export { DEALER_FEATURES, type DealerFeature, type DealerFinding } from './shared';

export interface DealerScanOptions {
  /** Only this client (must have the pack enabled). */
  locationId?: string;
  /** Evaluate as of this date (tests); default today (UTC). */
  asOf?: string;
  /** Stop between clients/detectors when aborted (scheduler timeout). */
  signal?: AbortSignal;
}

export interface DealerClient {
  locationId: string;
  settings: DealerSettings;
}

export interface DetectorRunSummary extends PersistSummary {
  key: string;
  feature: string;
  clients: number;
}

/** Clients of the org with the dealer pack on (RLS + client scope apply). */
export async function loadDealerClients(db: SupabaseClient, orgId: string, locationId?: string): Promise<DealerClient[]> {
  let q = db.from('dealer_pack_settings').select('location_id').eq('org_id', orgId).eq('enabled', true);
  if (locationId) q = q.eq('location_id', locationId);
  const { data, error } = await q;
  if (error) throw new Error(`Dealer settings lookup failed: ${error.message}`);
  const ids = ((data ?? []) as Array<{ location_id: string }>).map((r) => r.location_id);
  const out: DealerClient[] = [];
  for (const id of ids) out.push({ locationId: id, settings: await loadSettings({ db, orgId, locationId: id }) });
  return out;
}

/** Run one detector over already-loaded clients and persist (never throws). */
export async function runDealerDetector(
  db: SupabaseClient,
  orgId: string,
  det: DealerDetectorDef,
  clients: DealerClient[],
  opts: DealerScanOptions = {},
): Promise<DetectorRunSummary> {
  const asOf = opts.asOf ?? todayIso();
  const live: Array<{ locationId: string; finding: DealerFinding }> = [];
  const scanned: string[] = [];
  let collectErrors = 0;
  for (const cl of clients) {
    if (opts.signal?.aborted) break;
    try {
      const found = await det.collect({ db, orgId, locationId: cl.locationId, settings: cl.settings, asOf });
      for (const f of found) live.push({ locationId: cl.locationId, finding: f });
      scanned.push(cl.locationId);
    } catch (e) {
      // This client is not expired/updated this run — its open rows stay as they were.
      collectErrors += 1;
      console.warn(`[controls/dealer] ${det.key} failed for a client:`, e instanceof Error ? e.message : String(e));
    }
  }
  let persisted: PersistSummary;
  try {
    persisted = await persistDealerFindings(db, orgId, det.feature, live, scanned);
  } catch (e) {
    console.warn(`[controls/dealer] ${det.key} persist failed:`, e instanceof Error ? e.message : String(e));
    persisted = { ...emptyPersist(), detected: live.length, errors: 1 };
  }
  return { key: det.key, feature: det.feature, clients: scanned.length, ...persisted, errors: persisted.errors + collectErrors };
}

export interface RegisteredDealerDetector extends DealerDetectorDef {
  /** Standalone run (loads the enabled clients itself) — controls-nightly `Detector` shape. */
  run: (db: SupabaseClient, orgId: string, opts?: DealerScanOptions) => Promise<DetectorRunSummary>;
}

function register(det: DealerDetectorDef): RegisteredDealerDetector {
  return {
    ...det,
    run: async (db, orgId, opts = {}) => {
      let clients: DealerClient[];
      try {
        clients = await loadDealerClients(db, orgId, opts.locationId);
      } catch (e) {
        console.warn(`[controls/dealer] ${det.key}: client lookup failed:`, e instanceof Error ? e.message : String(e));
        return { key: det.key, feature: det.feature, clients: 0, ...emptyPersist(), errors: 1 };
      }
      return runDealerDetector(db, orgId, det, clients, opts);
    },
  };
}

/** Every dealer detector, in severity-first order. */
export const DEALER_DETECTORS: readonly RegisteredDealerDetector[] = [
  SOT_DETECTOR,
  FLOOR_MISMATCH_DETECTOR,
  DOUBLE_FLOORING_DETECTOR,
  STATEMENT_VARIANCE_DETECTOR,
  CURTAILMENT_DETECTOR,
  LINE_UTILIZATION_DETECTOR,
  AGED_UNIT_DETECTOR,
  WARRANTY_DETECTOR,
  INCENTIVE_DETECTOR,
  TRADE_RISK_DETECTOR,
  DEMO_ON_FLOOR_DETECTOR,
].map(register);

export interface DealerScanResult {
  clients: number;
  detected: number;
  queued: number;
  refreshed: number;
  expired: number;
  /** New exceptions queued per detector key. */
  byDetector: Record<string, number>;
  errors: number;
  detectors: DetectorRunSummary[];
}

export async function scanDealerControls(db: SupabaseClient, orgId: string, opts: DealerScanOptions = {}): Promise<DealerScanResult> {
  const result: DealerScanResult = { clients: 0, detected: 0, queued: 0, refreshed: 0, expired: 0, byDetector: {}, errors: 0, detectors: [] };
  let clients: DealerClient[];
  try {
    clients = await loadDealerClients(db, orgId, opts.locationId);
  } catch (e) {
    console.warn('[controls/dealer] client lookup failed:', e instanceof Error ? e.message : String(e));
    result.errors += 1;
    return result;
  }
  result.clients = clients.length;
  if (clients.length === 0) return result;
  for (const det of DEALER_DETECTORS) {
    if (opts.signal?.aborted) break;
    const s = await runDealerDetector(db, orgId, det, clients, opts);
    result.detectors.push(s);
    result.byDetector[det.key] = s.queued;
    result.detected += s.detected;
    result.queued += s.queued;
    result.refreshed += s.refreshed;
    result.expired += s.expired;
    result.errors += s.errors;
  }
  return result;
}
