/**
 * Minimal, read-only QuickBooks Online Accounting API client.
 *
 *   • Every request carries `minorversion=75` (Intuit's floor since 2025-08-01).
 *   • 401 → force one token refresh (rotating the refresh token) and retry once.
 *   • 429 → back off and retry. Intuit's limits are 500 req/min and 10 req/s per
 *     realm per app; their guidance is to wait before retrying. We honor
 *     `Retry-After` when sent, otherwise exponential backoff, capped so a request
 *     stays inside the serverless budget.
 *   • 5xx → one retry with backoff.
 *   • Hard timeout per request (AbortController) AND an overall deadline for the
 *     client, so a slow Intuit can never hang a route.
 *   • Query API pagination via STARTPOSITION / MAXRESULTS (max page 1000).
 *
 * Read-only by construction: only GET to /query, /reports/*, /companyinfo/*.
 * Error messages are plain English and never contain a token.
 */

import { QBO_MINOR_VERSION, qboApiBaseUrl, type QboEnvironment } from './config';
import { QboAuthRevokedError, type FetchLike } from './oauth';

export interface QboAccessTokenSource {
  getAccessToken(opts?: { forceRefresh?: boolean }): Promise<{ accessToken: string; realmId: string }>;
}

export class QboApiError extends Error {
  readonly code = 'QBO_API_ERROR';
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'QboApiError';
  }
}

/** Entities we are allowed to query (closed list — no caller-supplied SQL). */
export type QboQueryEntity = 'Account' | 'Customer' | 'Vendor' | 'Invoice' | 'Bill';

export interface QboClientOptions {
  environment: QboEnvironment;
  tokens: QboAccessTokenSource;
  fetchImpl?: FetchLike;
  /** Per-request timeout. */
  requestTimeoutMs?: number;
  /** Whole-client budget (all pages, retries, backoff). */
  deadlineMs?: number;
  /** Max retries on 429 per request. */
  maxThrottleRetries?: number;
  /** Max wait for a single backoff (ms). */
  maxBackoffMs?: number;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export const QBO_PAGE_SIZE = 1000;
/** Safety valve: 50 pages × 1000 = 50k records per entity. */
export const QBO_MAX_PAGES = 50;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class QboClient {
  private readonly fetchImpl: FetchLike;
  private readonly requestTimeoutMs: number;
  private readonly deadline: number;
  private readonly maxThrottleRetries: number;
  private readonly maxBackoffMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly baseUrl: string;

  constructor(private readonly opts: QboClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 20_000;
    this.maxThrottleRetries = opts.maxThrottleRetries ?? 3;
    this.maxBackoffMs = opts.maxBackoffMs ?? 15_000;
    this.sleep = opts.sleep ?? defaultSleep;
    this.now = opts.now ?? Date.now;
    this.deadline = this.now() + (opts.deadlineMs ?? 55_000);
    this.baseUrl = qboApiBaseUrl(opts.environment);
  }

  /** GET a company-scoped path (e.g. "/query?query=…"), returning parsed JSON. */
  async get<T = unknown>(pathWithQuery: string): Promise<T> {
    let refreshedAfter401 = false;
    let refreshNext = false;
    let throttleTries = 0;
    let serverTries = 0;

    for (;;) {
      if (this.now() > this.deadline) {
        throw new QboApiError('QuickBooks is taking too long to respond. Please try again in a minute.');
      }
      const { accessToken, realmId } = await this.opts.tokens.getAccessToken(
        refreshNext ? { forceRefresh: true } : undefined,
      );
      refreshNext = false;
      const sep = pathWithQuery.includes('?') ? '&' : '?';
      const url = `${this.baseUrl}/v3/company/${encodeURIComponent(realmId)}${pathWithQuery}${sep}minorversion=${QBO_MINOR_VERSION}`;

      const ctrl = new AbortController();
      const remaining = Math.max(1, this.deadline - this.now());
      const timer = setTimeout(() => ctrl.abort(), Math.min(this.requestTimeoutMs, remaining));
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
          signal: ctrl.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        if (err instanceof Error && err.name === 'AbortError') {
          throw new QboApiError('QuickBooks is taking too long to respond. Please try again in a minute.');
        }
        throw new QboApiError('Could not reach QuickBooks. Check your connection and try again.');
      }
      clearTimeout(timer);

      if (res.ok) return (await res.json()) as T;

      if (res.status === 401) {
        // One forced refresh per request; a second 401 means the grant is dead.
        if (refreshedAfter401) throw new QboAuthRevokedError();
        refreshedAfter401 = true;
        refreshNext = true;
        continue;
      }

      if (res.status === 429) {
        if (throttleTries >= this.maxThrottleRetries) {
          throw new QboApiError('QuickBooks is busy (too many requests). Please try again in a minute.', 429);
        }
        await this.sleep(this.backoffMs(res, throttleTries));
        throttleTries += 1;
        continue;
      }
      if (res.status >= 500 && serverTries < 1) {
        await this.sleep(this.backoffMs(res, serverTries));
        serverTries += 1;
        continue;
      }
      throw new QboApiError(await faultMessage(res), res.status);
    }
  }

  private backoffMs(res: Response, attempt: number): number {
    const ra = res.headers.get('retry-after');
    const raSec = ra ? Number(ra) : NaN;
    const base = Number.isFinite(raSec) && raSec >= 0 ? raSec * 1000 : 1000 * 2 ** attempt;
    const capped = Math.min(base, this.maxBackoffMs);
    return Math.max(0, Math.min(capped, this.deadline - this.now() - 1000));
  }

  /** Query API, all pages. `where` is built only by this module's callers (no user input). */
  async queryAll(entity: QboQueryEntity, where = ''): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    for (let page = 0; page < QBO_MAX_PAGES; page++) {
      const start = page * QBO_PAGE_SIZE + 1;
      const q = `select * from ${entity}${where ? ` where ${where}` : ''} STARTPOSITION ${start} MAXRESULTS ${QBO_PAGE_SIZE}`;
      const json = await this.get<{ QueryResponse?: Record<string, unknown> }>(
        `/query?query=${encodeURIComponent(q)}`,
      );
      const rows = json.QueryResponse?.[entity];
      const batch = Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
      out.push(...batch);
      if (batch.length < QBO_PAGE_SIZE) return out;
    }
    throw new QboApiError(
      `This QuickBooks company has more ${entity} records than we can bring over in one pass. Contact support.`,
    );
  }

  async report<T = unknown>(name: 'TrialBalance', params: Record<string, string>): Promise<T> {
    const qs = new URLSearchParams(params).toString();
    return this.get<T>(`/reports/${name}${qs ? `?${qs}` : ''}`);
  }

  async companyInfo<T = unknown>(): Promise<T> {
    const { realmId } = await this.opts.tokens.getAccessToken();
    return this.get<T>(`/companyinfo/${encodeURIComponent(realmId)}`);
  }
}

async function faultMessage(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { Fault?: { Error?: { Message?: string; Detail?: string }[] } };
    const e = j.Fault?.Error?.[0];
    if (e?.Message) return `QuickBooks returned an error: ${e.Message}${e.Detail ? ` — ${e.Detail}` : ''}`.slice(0, 400);
  } catch {
    /* fall through */
  }
  return `QuickBooks returned an error (HTTP ${res.status}).`;
}
