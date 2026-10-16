/**
 * QBO token manager — hands out a valid access token, refreshing (and ROTATING the
 * refresh token) when the access token is within the skew window of expiry.
 *
 * Storage is abstracted behind `QboTokenStore` so the logic is unit-testable with an
 * in-memory store; production uses the Vault-backed store (connection-store.ts).
 *
 * Rules:
 *   • Refresh when < 5 minutes of access-token life remain (or on a forced refresh
 *     after a 401 from the API).
 *   • Persist the new token set (incl. the rotated refresh token) BEFORE returning
 *     the access token — if the save fails we must not proceed on a token we can't
 *     reproduce next time.
 *   • invalid_grant on refresh = the grant is dead → flip the connection to 'error'
 *     with a plain-English message and throw QboAuthRevokedError.
 *   • Single-flight per org within this process: concurrent callers share one
 *     refresh, so we never burn a refresh token twice in parallel.
 */

import type { QboConfig } from './config';
import {
  QboAuthRevokedError,
  refreshTokens,
  type FetchLike,
  type QboTokenSet,
} from './oauth';

export const QBO_REFRESH_SKEW_MS = 5 * 60 * 1000;

export const QBO_RECONNECT_MESSAGE =
  'QuickBooks ended this connection (it was disconnected or expired). Click “Connect QuickBooks” to link it again — nothing you imported is lost.';

export interface QboTokenStore {
  /** Load the current token set; null when the org has no stored QBO tokens. */
  load(): Promise<QboTokenSet | null>;
  /** Persist a (rotated) token set. Must throw if it could not be saved. */
  save(tokens: QboTokenSet): Promise<void>;
  /** Mark the connection unusable with a user-facing message. Best-effort. */
  markError(message: string): Promise<void>;
}

const inflight = new Map<string, Promise<QboTokenSet>>();

export class QboTokenManager {
  constructor(
    private readonly key: string,
    private readonly config: QboConfig,
    private readonly store: QboTokenStore,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns the current token set, refreshed if needed. Throws QboAuthRevokedError. */
  async getTokens(opts: { forceRefresh?: boolean } = {}): Promise<QboTokenSet> {
    const current = await this.store.load();
    if (!current) throw new QboAuthRevokedError('QuickBooks isn’t connected for this company yet.');

    if (current.refreshExpiresAt !== null && this.now() >= current.refreshExpiresAt) {
      await this.store.markError(QBO_RECONNECT_MESSAGE);
      throw new QboAuthRevokedError(QBO_RECONNECT_MESSAGE);
    }

    const fresh = current.accessExpiresAt - this.now() > QBO_REFRESH_SKEW_MS;
    if (fresh && !opts.forceRefresh) return current;

    const existing = inflight.get(this.key);
    if (existing) return existing;

    const p = this.doRefresh(current).finally(() => inflight.delete(this.key));
    inflight.set(this.key, p);
    return p;
  }

  async getAccessToken(opts: { forceRefresh?: boolean } = {}): Promise<{ accessToken: string; realmId: string }> {
    const t = await this.getTokens(opts);
    return { accessToken: t.accessToken, realmId: t.realmId };
  }

  private async doRefresh(current: QboTokenSet): Promise<QboTokenSet> {
    let next: QboTokenSet;
    try {
      next = await refreshTokens(this.config, current, this.fetchImpl, { now: this.now() });
    } catch (err) {
      if (err instanceof QboAuthRevokedError) {
        await this.store.markError(QBO_RECONNECT_MESSAGE);
        throw new QboAuthRevokedError(QBO_RECONNECT_MESSAGE);
      }
      throw err;
    }
    await this.store.save(next);
    return next;
  }
}

/** Test hook: clear the single-flight map between tests. */
export function __resetQboInflight(): void {
  inflight.clear();
}
