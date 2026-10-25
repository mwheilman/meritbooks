/**
 * HTTP to Merit Projects (field work) and Merit Books (pay, commissions, receipts), each with the
 * Clerk session token as Bearer. Base URLs come from EXPO_PUBLIC_PROJECTS_API / EXPO_PUBLIC_BOOKS_API.
 *
 * Failures are classified for the queue: offline (no connection / timeout), auth (session
 * expired: Clerk's middleware answers an unauthenticated API call with 401 or a 404 page), server
 * (5xx: back off and retry), client (refused as a whole: 403/422 with a reason).
 */
import { File, UploadType } from 'expo-file-system';
import type {
  ApprovalInbox, CommandResult, FieldExtras, FieldSiteCard, FlooringCommand, FsTools, InstallerDay, ResReceiptCommand, RoLineStoryCommand, FieldToday, InboxPage, JsonCommand, KioskSession, PayWeek, PhoneSheet, PhotoCommand, RoBundle, SellBundle,
  SignableFile, StartedSigning,
} from '@/core/contract';
import { isApprovalInbox } from '@/core/approvals';
import { isInboxPage } from '@/core/inbox';
import { isKioskSession } from '@/core/kiosk';
import { isRoBundle } from '@/core/ro';
import { endpointOf, flooringBody, flooringResult, receiptBody, singleResult, storyBody, wire, type Endpoint } from '@/core/routing';
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

export type KioskIdentify = { ok: true; session: KioskSession } | { ok: false; code: string; message: string };

const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
export const isExtras = (v: unknown): v is FieldExtras => obj(v) && obj(v.visits) && obj(v.homes) && obj(v.features);
export const isSheets = (v: unknown): v is { sheets: PhoneSheet[]; serverTime: string } => obj(v) && Array.isArray(v.sheets);
export const isSell = (v: unknown): v is SellBundle => obj(v) && Array.isArray(v.options) && Array.isArray(v.plans) && typeof v.workOrderId === 'string';
export const isPay = (v: unknown): v is PayWeek => obj(v) && typeof v.installer === 'boolean' && Array.isArray(v.tickets) && obj(v.totals);
export const isFsTools = (v: unknown): v is FsTools => obj(v) && Array.isArray(v.willCalls);
export const isSiteCards = (v: unknown): v is { cards: FieldSiteCard[] } => obj(v) && Array.isArray(v.cards);
export const isInstallerDay = (v: unknown): v is InstallerDay => obj(v) && Array.isArray(v.bookings) && typeof v.my_pay_this_week_cents === 'number';


export const isFiles = (v: unknown): v is { files: SignableFile[] } => obj(v) && Array.isArray(v.files);
const isStarted = (v: unknown): v is StartedSigning => obj(v) && typeof v.token === 'string' && typeof v.fileUrl === 'string' && obj(v.state);
const ids = (xs: ReadonlyArray<string>) => [...new Set(xs)].slice(0, 60).map(encodeURIComponent).join(',');

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
        httpMethod: 'POST', uploadType: UploadType.MULTIPART, fieldName: 'file', mimeType: fileUri.endsWith('.png') ? 'image/png' : 'image/jpeg',
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
    /**
     * One queue, three endpoints (core/routing.ts): the field sync batch, the field-service tool batch,
     * and the flooring installer calls. Offline / signed-out stops the whole send (everything is
     * re-sent later and deduped by id); a refusal or a busy server on one endpoint answers only its
     * own commands.
     */
    async sendBatch(commands: JsonCommand[]): Promise<CommandResult[]> {
      const groups: Record<Endpoint, JsonCommand[]> = { sync: [], fs: [], flooring: [], receipt: [], story: [] };
      for (const c of commands) groups[endpointOf(c)].push(c);
      const out: CommandResult[] = [];
      const each = (cs: JsonCommand[], e: unknown): CommandResult[] => {
        if (e instanceof TransportError && (e.failure === 'offline' || e.failure === 'auth')) throw e;
        const outcome = e instanceof TransportError && e.failure === 'client' ? 'rejected' : 'retry';
        return cs.map((c) => ({ id: c.id, kind: c.kind, outcome, code: 'REFUSED', reason: e instanceof Error ? e.message : 'Not sent yet.' }));
      };
      const batch = async (path: string, cs: JsonCommand[]) => {
        if (!cs.length) return;
        try {
          const { status, body } = await request(PROJECTS_API, path, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ commands: cs.map(wire) }),
          });
          if (status >= 500 || status === 429) throw new TransportError(`The server is busy (${status}).`, 'server');
          if (status === 404 && path !== '/api/field/sync') throw new TransportError('The office server does not take this from the phone yet. It is kept and sent after the update.', 'server');
          if (status !== 200) throw new TransportError(errorText(body, `The server refused this (${status}).`), 'client');
          const results = typeof body === 'object' && body !== null ? (body as { results?: unknown }).results : undefined;
          if (!Array.isArray(results)) throw new TransportError('The server answered in a way this app does not understand.', 'server');
          out.push(...results.filter(isCommandResult));
        } catch (e) {
          out.push(...each(cs, e));
        }
      };
      await batch('/api/field/sync', groups.sync);
      await batch('/api/field/fs-commands', groups.fs);
      const single = async (c: JsonCommand, path: string, payload: Record<string, unknown>, answer: (status: number, body: unknown) => CommandResult) => {
        try {
          const { status, body } = await request(PROJECTS_API, path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
          out.push(answer(status, body));
        } catch (e) {
          out.push(...each([c], e));
        }
      };
      for (const c of groups.flooring as FlooringCommand[]) await single(c, '/api/field/flooring', flooringBody(c), (st, b) => flooringResult(c, st, b));
      for (const c of groups.receipt as ResReceiptCommand[]) await single(c, '/api/field/receipts', receiptBody(c), (st, b) => singleResult(c, st, b));
      for (const c of groups.story as RoLineStoryCommand[]) await single(c, '/api/field/ro/story', storyBody(c), (st, b) => singleResult(c, st, b));
      return out;
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

  /** A phone read: 200 + the expected shape, else a TransportError the screen shows (and keeps its saved copy). */
  async function read<T>(base: string, path: string, guard: (v: unknown) => v is T, init: RequestInit = { method: 'GET' }): Promise<T> {
    const { status, body } = await request(base, path, init);
    if (status !== 200) throw new TransportError(errorText(body, `Not available right now (${status}).`), status >= 500 || status === 429 ? 'server' : 'client');
    if (!guard(body)) throw new TransportError('The server answered in a way this app does not understand. Update Merit Workforce.', 'server');
    return body;
  }

  return {
    transport,

    approvals: () => read(PROJECTS_API, '/api/approvals?mine=1&limit=200', isApprovalInbox) as Promise<ApprovalInbox>,
    inbox: () => read(PROJECTS_API, '/api/notifications?view=inbox&filter=all&limit=60', isInboxPage),
    extras: (workOrderIds: ReadonlyArray<string>, jobIds: ReadonlyArray<string>) => read(PROJECTS_API, `/api/field/extras?wo=${ids(workOrderIds)}&jobs=${ids(jobIds)}`, isExtras),
    drawings: (jobIds: ReadonlyArray<string>) => read(PROJECTS_API, `/api/field/drawings?jobIds=${ids(jobIds.slice(0, 30))}`, isSheets),
    service: (workOrderId: string) => read(PROJECTS_API, `/api/field/sell?workOrderId=${encodeURIComponent(workOrderId)}`, isSell),
    ro: () => read(PROJECTS_API, '/api/field/ro', isRoBundle),
    payWeek: (week?: string) => read(PROJECTS_API, `/api/field/pay${week ? `?week=${encodeURIComponent(week)}` : ''}`, isPay),
    signFiles: (jobId: string) => read(PROJECTS_API, `/api/field/sign?jobId=${encodeURIComponent(jobId)}`, isFiles),
    signStart: (b: { documentId: string; signerName: string; title?: string | null }) =>
      read(PROJECTS_API, '/api/field/sign', isStarted, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }),

    fsTools: (workOrderId?: string) => read(PROJECTS_API, `/api/field/fs-tools${workOrderId ? `?workOrderId=${encodeURIComponent(workOrderId)}` : ''}`, isFsTools),
    siteCards: (jobIds: ReadonlyArray<string>, lang: 'en' | 'es') => read(PROJECTS_API, `/api/field/site?jobs=${ids(jobIds.slice(0, 50))}&lang=${lang}`, isSiteCards),
    installerDay: (day?: string) => read(PROJECTS_API, `/api/field/flooring${day ? `?day=${encodeURIComponent(day)}` : ''}`, isInstallerDay),
    /** Station sign-in (online only: the badge + PIN check and lockout counters live in the database). */
    async kioskIdentify(companyId: string, badge: string, pin: string): Promise<KioskIdentify> {
      try {
        const { status, body } = await request(PROJECTS_API, '/api/mfg/kiosk', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'identify', companyId, badge, pin }),
        });
        if (status === 200 && isKioskSession(body)) return { ok: true, session: body };
        const code = obj(body) && typeof body.code === 'string' ? body.code : `HTTP_${status}`;
        return { ok: false, code, message: errorText(body, `Not signed in (${status}).`) };
      } catch (e) {
        if (e instanceof TransportError && e.failure === 'offline') return { ok: false, code: 'OFFLINE', message: e.message };
        return { ok: false, code: 'ERROR', message: e instanceof Error ? e.message : 'Not signed in.' };
      }
    },

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
