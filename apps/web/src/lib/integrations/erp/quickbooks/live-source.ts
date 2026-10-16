/**
 * QboLiveSource — the live implementation behind `RealConnectorProvider`'s
 * liveFetch for QuickBooks. Pulls from the QBO API via QboClient and returns
 * FIXTURE-SHAPED raw records (transforms.ts) so the existing mapping profile in
 * providers/mapping.ts converts them unchanged.
 *
 * Every pull is cached for the lifetime of the instance (one request = one
 * instance), so asking for accounts, the TB, and the pre-flight in the same request
 * hits Intuit once per entity.
 */

import type { RawRecord } from '../providers/mapping';
import type { LiveRawSource } from '../providers/real';
import type { MigrationEntity } from '../providers/types';
import type { QboClient } from './client';
import { parseCompanyInfo, type QboCompanyProfile } from './company-info';
import { runQboPreflight, type PreflightFinding } from './preflight';
import {
  dollarsStrToCents,
  fiscalYearStartFor,
  flattenAccount,
  flattenBill,
  flattenInvoice,
  flattenParty,
  isOpen,
  parseTrialBalanceReport,
  tbLinesToRaw,
  toAccountSnapshot,
  type QboAccountSnapshot,
  type QboReport,
  type QboTbLine,
} from './transforms';

type Obj = Record<string, unknown>;

/** FPB default cutover: the last day of the prior month (UTC). */
export function defaultCutoverDate(now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  return d.toISOString().slice(0, 10);
}

export interface QboLiveSourceOptions {
  /** Opening-balance date (YYYY-MM-DD). Defaults to the last day of the prior month. */
  asOfDate?: string | null;
  /** Override; otherwise read from CompanyInfo (defaults to January). */
  fiscalYearStartMonth?: number | null;
}

export class QboLiveSource implements LiveRawSource {
  readonly asOfDate: string;
  private cache = new Map<string, Promise<unknown>>();

  constructor(
    private readonly client: QboClient,
    private readonly opts: QboLiveSourceOptions = {},
  ) {
    this.asOfDate = opts.asOfDate ?? defaultCutoverDate();
  }

  private once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let p = this.cache.get(key) as Promise<T> | undefined;
    if (!p) {
      p = fn();
      this.cache.set(key, p);
      // Don't cache failures — a retry in the same request should try again.
      p.catch(() => this.cache.delete(key));
    }
    return p;
  }

  companyProfile(): Promise<QboCompanyProfile> {
    return this.once('company', async () => parseCompanyInfo(await this.client.companyInfo()));
  }

  private rawAccounts(): Promise<Obj[]> {
    return this.once('accounts', () => this.client.queryAll('Account'));
  }

  async accountSnapshots(): Promise<QboAccountSnapshot[]> {
    return (await this.rawAccounts()).map(toAccountSnapshot);
  }

  /** Open docs: filter server-side when QBO allows it, and always client-side too. */
  private openDocs(entity: 'Invoice' | 'Bill'): Promise<Obj[]> {
    return this.once(`open:${entity}`, async () => {
      let rows: Obj[];
      try {
        rows = await this.client.queryAll(entity, "Balance > '0'");
      } catch {
        rows = await this.client.queryAll(entity);
      }
      return rows.filter(isOpen);
    });
  }

  trialBalanceLines(): Promise<QboTbLine[]> {
    return this.once('tb', async () => {
      const fyStart =
        this.opts.fiscalYearStartMonth ?? (await this.companyProfile()).fiscalYearStartMonth ?? 1;
      const [report, accounts] = await Promise.all([
        this.client.report<QboReport>('TrialBalance', {
          start_date: fiscalYearStartFor(this.asOfDate, fyStart),
          end_date: this.asOfDate,
          accounting_method: 'Accrual',
        }),
        this.accountSnapshots(),
      ]);
      return parseTrialBalanceReport(report, new Map(accounts.map((a) => [a.id, a])));
    });
  }

  /** LiveRawSource: raw fixture-shaped records for one migration entity. */
  async fetchRaw(entity: MigrationEntity): Promise<RawRecord[]> {
    switch (entity) {
      case 'accounts':
        return (await this.rawAccounts()).map(flattenAccount);
      case 'customers':
        return (await this.once('customers', () => this.client.queryAll('Customer'))).map(flattenParty);
      case 'vendors':
        return (await this.once('vendors', () => this.client.queryAll('Vendor'))).map(flattenParty);
      case 'open_ar':
        return (await this.openDocs('Invoice')).map(flattenInvoice);
      case 'open_ap':
        return (await this.openDocs('Bill')).map(flattenBill);
      case 'trial_balance':
        return tbLinesToRaw(await this.trialBalanceLines());
    }
  }

  /** T5 pre-flight over the pulled data. */
  async preflight(): Promise<PreflightFinding[]> {
    const [accounts, tb, inv, bills] = await Promise.all([
      this.accountSnapshots(),
      this.trialBalanceLines(),
      this.openDocs('Invoice'),
      this.openDocs('Bill'),
    ]);
    return runQboPreflight({
      accounts,
      trialBalance: tb,
      openInvoiceBalancesCents: inv.map((i) => dollarsStrToCents(i.Balance)),
      openBillBalancesCents: bills.map((b) => dollarsStrToCents(b.Balance)),
      asOfDate: this.asOfDate,
    });
  }
}
