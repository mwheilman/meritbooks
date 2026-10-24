/**
 * HTTP to Merit Projects (field work) and Merit Books (pay, commissions, receipts), each with the
 * Clerk session token as Bearer. Base URLs come from EXPO_PUBLIC_PROJECTS_API / EXPO_PUBLIC_BOOKS_API.
 *
 * Failures are classified for the queue: offline (no connection / timeout), auth (session
 * expired: Clerk's middleware answers an unauthenticated API call with 401 or a 404 page), server
 * (5xx: back off and retry), client (refused as a whole: 403/422 with a reason).
 */
import { File, UploadType } from 'expo-file-system';
import type { CommandResult, FieldToday, JsonCommand, PhotoCommand } from '@/core/contract';
import { TransportError, type Transport } from '@/core/queue';

export const PROJECTS_API = (process.env.EXPO_PUBLIC_PROJECTS_API ?? '').replace(/\/+$/, '');
export const BOOKS_API = (process.env.EXPO_PUBLIC_BOOKS_API ?? '').replace(/\/+$/, '');

export type TokenGetter = (opts?: { skipCache?: boolean }) => Promise<string | null>;

const TIMEOUT_MS = 20_000;

function isCommandResult(v: unknown): v is CommandResult {
  return typeof v === 'object' && v !== null && typeof (v as CommandResult).outcome === 'string' && typeof (v as CommandResult).kind === 'string';
}

function errorText(body: unknown, fallback: string): string {
  const e = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined;
  return typeof e === 'string' && e ? e : fallback;
}

async function readJson(res: { headers: { get(name: string): string | null }; json(): Promise<unknown> }): Promise<unknown> {
  if (!(res.headers.get('content-type') ?? '').includes('application/json')) return undefined;
  return res.json().catch(() => undefined);
}

/** 401, or the 404 page Clerk's middleware returns for an API call without a valid session. */
function looksSignedOut(status: number, body: unknown): boolean {
  return status === 401 || (status === 404 && body === undefined);
}

export interface BooksReceipts {
  holderName: string;
  cards: Array<{ assignmentId: string; companyName: string; cardLabel: string; chaseOn: boolean; needed: Array<{ transactionId: string; merchant: string; chargeDate: string; amountCents: number }>; neededTotalCents: number }>;
}

/** Proposed Books contract (not built in Books yet): GET /api/w/me/pay. */
export interface BooksPay {
  provider: string | null;
  nextPayDate: string | null;
  lastPay: { payDate: string; netCents: number; grossCents: number } | null;
  stubUrl: string | null;
  portalUrl: string | null;
}

/** Proposed Books contract (not built in Books yet): GET /api/w/me/commissions. */
export interface BooksCommissions {
  periodLabel: string;
  earnedCents: number;
  clawbackCents: number;
  netCents: number;
  statementUrl: string | null;
}

export type BooksCard<T> = { state: 'ok'; value: T } | { state: 'off' } | { state: 'error'; message: string };

export function createApi(getToken: TokenGetter) {
  async function request(base: string, path: string, init: RequestInit, retried = false): Promise<{ status: number; body: unknown }> {
    if (!base) throw new TransportError('The app is not set up with a server address. Ask your office.', 'client');
    const token = await getToken(retried ? { skipCache: true } : undefined);
    if (!token) throw new TransportError('Sign in again to send.', 'auth');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, { ...init, signal: ctl.signal, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    } catch {
      throw new TransportError('No connection.', 'offline');
    } finally {
      clearTimeout(timer);
    }
    const body = await readJson(res);
    if (looksSignedOut(res.status, body)) {
      if (!retried) return request(base, path, init, true);
      throw new TransportError('Your sign-in expired. Sign in again to send.', 'auth');
    }
    return { status: res.status, body };
  }

  async function uploadPhoto(command: PhotoCommand, fileUri: string, retried: boolean): Promise<CommandResult> {
    if (!PROJECTS_API) throw new TransportError('The app is not set up with a server address. Ask your office.', 'client');
    const token = await getToken(retried ? { skipCache: true } : undefined);
    if (!token) throw new TransportError('Sign in again to send.', 'auth');
    const file = new File(fileUri);
    if (!file.exists) return { id: command.id, kind: command.kind, outcome: 'rejected', code: 'PHOTO_MISSING', reason: 'The photo file is no longer on this phone. Take it again.' };
    let status: number;
    let text: string;
    try {
      const r = await file.upload(`${PROJECTS_API}/api/field/photos`, {
        httpMethod: 'POST', uploadType: UploadType.MULTIPART, fieldName: 'file', mimeType: 'image/jpeg',
        parameters: { meta: JSON.stringify(command) }, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
      status = r.status;
      text = r.body;
    } catch {
      throw new TransportError('No connection.', 'offline');
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    if (looksSignedOut(status, body)) {
      if (!retried) return uploadPhoto(command, fileUri, true);
      throw new TransportError('Your sign-in expired. Sign in again to send.', 'auth');
    }
    if (isCommandResult(body)) return { ...body, id: body.id || command.id };
    if (status >= 500 || status === 429) throw new TransportError(`The server is busy (${status}).`, 'server');
    throw new TransportError(errorText(body, `The server refused the photo (${status}).`), 'client');
  }

  const transport: Transport = {
    async sendBatch(commands: JsonCommand[]): Promise<CommandResult[]> {
      const { status, body } = await request(PROJECTS_API, '/api/field/sync', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ commands }),
      });
      if (status >= 500 || status === 429) throw new TransportError(`The server is busy (${status}).`, 'server');
      if (status !== 200) throw new TransportError(errorText(body, `The server refused this (${status}).`), 'client');
      const results = typeof body === 'object' && body !== null ? (body as { results?: unknown }).results : undefined;
      if (!Array.isArray(results)) throw new TransportError('The server answered in a way this app does not understand.', 'server');
      return results.filter(isCommandResult);
    },

    sendPhoto: (command: PhotoCommand, fileUri: string) => uploadPhoto(command, fileUri, false),
  };

  async function booksCard<T>(path: string, guard: (v: unknown) => v is T): Promise<BooksCard<T>> {
    if (!BOOKS_API) return { state: 'off' };
    try {
      const { status, body } = await request(BOOKS_API, path, { method: 'GET' });
      if (status === 404 || status === 400 || status === 403) return { state: 'off' };
      if (status !== 200 || !guard(body)) return { state: 'error', message: errorText(body, 'Not available right now.') };
      return { state: 'ok', value: body };
    } catch (e) {
      return { state: 'error', message: e instanceof Error ? e.message : 'Not available right now.' };
    }
  }

  return {
    transport,

    async today(): Promise<FieldToday> {
      const { status, body } = await request(PROJECTS_API, '/api/field/today', { method: 'GET' });
      if (status !== 200) throw new TransportError(errorText(body, `Could not load your work (${status}).`), status >= 500 ? 'server' : 'client');
      if (!isFieldToday(body)) throw new TransportError('The server answered in a way this app does not understand. Update Merit Workforce.', 'server');
      return body;
    },

    receipts: () => booksCard<BooksReceipts>('/api/w/me', (v): v is BooksReceipts => typeof v === 'object' && v !== null && Array.isArray((v as BooksReceipts).cards)),
    pay: () => booksCard<BooksPay>('/api/w/me/pay', (v): v is BooksPay => typeof v === 'object' && v !== null && 'nextPayDate' in v),
    commissions: () => booksCard<BooksCommissions>('/api/w/me/commissions', (v): v is BooksCommissions => typeof v === 'object' && v !== null && typeof (v as BooksCommissions).netCents === 'number'),
  };
}

export type Api = ReturnType<typeof createApi>;

export function isFieldToday(v: unknown): v is FieldToday {
  if (typeof v !== 'object' || v === null) return false;
  const t = v as Partial<FieldToday>;
  return typeof t.today === 'string' && Array.isArray(t.jobs) && Array.isArray(t.assignments) && Array.isArray(t.week) && typeof t.can === 'object';
}
