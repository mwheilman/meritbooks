'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { dollarsToCents } from '@meritbooks/shared';
import { useQuery } from '@/hooks';
import { api } from '@/lib/api-client';
import { addToast } from '@/hooks/use-toast';
import { Loader2, ShieldCheck, History } from 'lucide-react';

type Frequency = 'MONTHLY' | 'QUARTERLY' | 'SEMIANNUAL' | 'ANNUAL';
type RateType = 'FIXED' | 'VARIABLE';
type Method = 'AMORTIZING' | 'INTEREST_ONLY';
type CovType = 'DSCR' | 'FCCR' | 'LEVERAGE' | 'CURRENT_RATIO' | 'MIN_LIQUIDITY' | 'TNW' | 'CUSTOM';
type CovDir = 'MIN' | 'MAX';
type CovFreq = 'MONTHLY' | 'QUARTERLY' | 'ANNUAL';

/** A covenant proposed by the parser (numbers as parsed). */
export interface ProposedCovenantInit {
  covenant_type: CovType;
  threshold: number | null;
  direction: CovDir;
  test_frequency: CovFreq;
  label: string | null;
}

/** Covenant row as the form edits it (threshold kept as a string while typing). */
interface FormCovenant {
  covenant_type: CovType;
  threshold: string;
  direction: CovDir;
  test_frequency: CovFreq;
  label: string | null;
}

const COV_TYPES: CovType[] = ['DSCR', 'FCCR', 'LEVERAGE', 'CURRENT_RATIO', 'MIN_LIQUIDITY', 'TNW', 'CUSTOM'];
const COV_TYPE_LABEL: Record<CovType, string> = {
  DSCR: 'DSCR', FCCR: 'FCCR', LEVERAGE: 'Leverage', CURRENT_RATIO: 'Current ratio',
  MIN_LIQUIDITY: 'Min liquidity', TNW: 'Tangible net worth', CUSTOM: 'Custom',
};

/** Initial values, in the units the FORM uses (dollars for money). */
export interface DebtFormInitial {
  loan_name?: string;
  lender?: string | null;
  facility?: string | null;
  location_id?: string | null;
  principal_dollars?: number | null;
  interest_rate?: number | null;
  rate_type?: RateType;
  amortization_method?: Method;
  payment_frequency?: Frequency;
  term_periods?: number | null;
  payment_dollars?: number | null;
  origination_date?: string | null;
  maturity_date?: string | null;
  notes?: string | null;
  proposedCovenants?: ProposedCovenantInit[];
  lowConfidenceFields?: string[];
}

interface LocationOption { id: string; name: string }
interface AccountOption { id: string; accountNumber: string; name: string; accountType: string; isBankAccount?: boolean }

const FREQUENCIES: { value: Frequency; label: string }[] = [
  { value: 'MONTHLY', label: 'Monthly' },
  { value: 'QUARTERLY', label: 'Quarterly' },
  { value: 'SEMIANNUAL', label: 'Semiannual' },
  { value: 'ANNUAL', label: 'Annual' },
];

/** Onboarding hint served by GET /api/debt (`meta.onboarding`). */
interface DebtListMeta {
  meta?: { onboarding?: { defaultExistingLoan: boolean; openingBalancesPosted: boolean; cutoverDate: string | null } };
}

const MONTHS_PER: Record<Frequency, number> = { MONTHLY: 1, QUARTERLY: 3, SEMIANNUAL: 6, ANNUAL: 12 };

/** Last day of the prior month (the FPB default cutover), YYYY-MM-DD. */
function defaultCutover(): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  return d.toISOString().slice(0, 10);
}

/** Whole months from a to b (partial month not counted); null on bad input. Mirrors lib/debt/create.ts. */
function wholeMonths(a: string, b: string): number | null {
  const ma = /^(\d{4})-(\d{2})-(\d{2})$/.exec(a);
  const mb = /^(\d{4})-(\d{2})-(\d{2})$/.exec(b);
  if (!ma || !mb) return null;
  let m = (Number(mb[1]) - Number(ma[1])) * 12 + (Number(mb[2]) - Number(ma[2]));
  if (Number(mb[3]) < Number(ma[3])) m -= 1;
  return m;
}

export function DebtForm({
  initial,
  onSaved,
  onClose,
  existingDefault,
  cutoverDate,
}: {
  initial: DebtFormInitial | null;
  /** Called after a successful save with the new instrument's id (document-intelligence linking). */
  onSaved: (id?: string) => void;
  onClose: () => void;
  /**
   * B9: start in "This loan already exists" mode. Leave undefined to let the form
   * decide from the org's onboarding state (GET /api/debt meta): ON while onboarding or
   * once opening balances are posted — unless the loan originated after the cutover.
   */
  existingDefault?: boolean;
  /** The cutover (as-of) date for an existing loan's balance; defaults to the org's, else last month-end. */
  cutoverDate?: string | null;
}) {
  const [loanName, setLoanName] = useState(initial?.loan_name ?? '');
  const [lender, setLender] = useState(initial?.lender ?? '');
  const [facility, setFacility] = useState(initial?.facility ?? '');
  const [locationId, setLocationId] = useState(initial?.location_id ?? '');
  const [principal, setPrincipal] = useState<string>(initial?.principal_dollars != null ? String(initial.principal_dollars) : '');
  const [rate, setRate] = useState<string>(initial?.interest_rate != null ? String(initial.interest_rate) : '');
  const [rateType, setRateType] = useState<RateType>(initial?.rate_type ?? 'FIXED');
  const [method, setMethod] = useState<Method>(initial?.amortization_method ?? 'AMORTIZING');
  const [frequency, setFrequency] = useState<Frequency>(initial?.payment_frequency ?? 'MONTHLY');
  const [term, setTerm] = useState<string>(initial?.term_periods != null ? String(initial.term_periods) : '');
  const [payment, setPayment] = useState<string>(initial?.payment_dollars != null ? String(initial.payment_dollars) : '');
  const [origination, setOrigination] = useState(initial?.origination_date ?? '');
  const [maturity, setMaturity] = useState(initial?.maturity_date ?? '');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [covenants, setCovenants] = useState<FormCovenant[]>(() =>
    (initial?.proposedCovenants ?? [])
      .filter((c) => c.threshold != null)
      .map((c) => ({
        covenant_type: c.covenant_type,
        threshold: c.threshold != null ? String(c.threshold) : '',
        direction: c.direction,
        test_frequency: c.test_frequency,
        label: c.label ?? null,
      })),
  );
  const updateCov = (i: number, patch: Partial<FormCovenant>) =>
    setCovenants((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const removeCov = (i: number) => setCovenants((cs) => cs.filter((_, j) => j !== i));
  const addCov = () =>
    setCovenants((cs) => [...cs, { covenant_type: 'DSCR', threshold: '', direction: 'MIN', test_frequency: 'QUARTERLY', label: null }]);
  const [liabilityAcct, setLiabilityAcct] = useState('');
  const [cashAcct, setCashAcct] = useState('');
  const [interestExpAcct, setInterestExpAcct] = useState('');
  const [interestPayAcct, setInterestPayAcct] = useState('');
  const [saving, setSaving] = useState(false);

  // ── B9 existing-loan mode ────────────────────────────────────────────────
  const needHint = existingDefault === undefined || cutoverDate === undefined;
  const { data: hintData } = useQuery<DebtListMeta>(needHint ? '/api/debt' : null, undefined, { scope: false });
  const hint = hintData?.meta?.onboarding ?? null;
  const [existing, setExisting] = useState<boolean>(existingDefault ?? false);
  const [asOf, setAsOf] = useState<string>(cutoverDate ?? defaultCutover());
  const [balance, setBalance] = useState<string>('');
  const [remaining, setRemaining] = useState<string>('');
  const touched = useRef(false);
  useEffect(() => {
    if (touched.current) return;
    const cut = cutoverDate ?? hint?.cutoverDate ?? null;
    if (cut) setAsOf(cut);
    const wanted = existingDefault ?? hint?.defaultExistingLoan ?? false;
    // A loan that originated AFTER the cutover is new money, not an opening balance.
    const originatedAfterCutover = !!(cut && initial?.origination_date && initial.origination_date > cut);
    setExisting(wanted && !originatedAfterCutover);
  }, [existingDefault, cutoverDate, hint, initial?.origination_date]);

  /** Preview of payments left, derived the same way the server does. */
  const derivedRemaining = useMemo<number | null>(() => {
    if (!existing) return null;
    if (remaining && Number(remaining) > 0) return Number(remaining);
    const mpp = MONTHS_PER[frequency];
    if (term && Number(term) > 0 && origination) {
      const m = wholeMonths(origination, asOf);
      return m == null ? null : Number(term) - Math.max(0, Math.floor(m / mpp));
    }
    if (maturity) {
      const m = wholeMonths(asOf, maturity);
      return m == null ? null : Math.ceil(m / mpp);
    }
    return null;
  }, [existing, remaining, frequency, term, origination, asOf, maturity]);

  const { data: locData } = useQuery<LocationOption[]>('/api/locations');
  const locations = locData ?? [];
  const { data: acctData } = useQuery<{ data: AccountOption[] }>('/api/accounts');
  const accounts = acctData?.data ?? [];

  const liabilityAccts = useMemo(() => accounts.filter((a) => a.accountType === 'LIABILITY'), [accounts]);
  const cashAccts = useMemo(() => accounts.filter((a) => a.isBankAccount || a.accountType === 'ASSET'), [accounts]);
  const expenseAccts = useMemo(() => accounts.filter((a) => a.accountType === 'OTHER' || a.accountType === 'OPEX'), [accounts]);

  const lowFlag = (f: string) => (initial?.lowConfidenceFields?.includes(f) ? 'border-amber-500/60 ring-1 ring-amber-500/30' : '');

  async function submit() {
    if (!loanName.trim()) { addToast('error', 'Loan name is required'); return; }
    const balanceNum = balance ? Number(balance) : NaN;
    const remainingNum = remaining ? Number(remaining) : null;
    if (existing) {
      if (!Number.isFinite(balanceNum) || balanceNum <= 0) { addToast('error', 'Enter the balance you still owe on this loan'); return; }
      if (!asOf) { addToast('error', 'Enter the date that balance is as of'); return; }
    }
    // Existing mode: the original amount is optional (defaults to the balance still owed).
    const principalNum = principal ? Number(principal) : (existing ? balanceNum : NaN);
    if (!Number.isFinite(principalNum) || principalNum <= 0) { addToast('error', 'Enter the original principal'); return; }
    const rateNum = Number(rate);
    if (!Number.isFinite(rateNum) || rateNum < 0) { addToast('error', 'Enter a valid interest rate'); return; }
    const termNum = term ? Number(term) : null;
    const paymentNum = payment ? Number(payment) : null;
    if (existing) {
      if (!remainingNum && !termNum && !paymentNum && !maturity) {
        addToast('error', 'Enter the payments left, the maturity date, or the regular payment'); return;
      }
      if (derivedRemaining != null && derivedRemaining <= 0) {
        addToast('error', 'By the as-of date this loan’s term has ended — enter the payments left'); return;
      }
    } else {
      if (!termNum && !paymentNum) { addToast('error', 'Enter a term (number of periods) or a fixed payment'); return; }
      if (method === 'INTEREST_ONLY' && !termNum) { addToast('error', 'Interest-only loans need a term'); return; }
    }

    setSaving(true);
    const payload = {
      loan_name: loanName.trim(),
      lender: lender.trim() || null,
      facility: facility.trim() || null,
      location_id: locationId || null,
      principal_cents: dollarsToCents(principalNum),
      interest_rate: rateNum,
      rate_type: rateType,
      amortization_method: method,
      payment_frequency: frequency,
      compounding: frequency,
      term_periods: termNum,
      payment_cents: paymentNum ? dollarsToCents(paymentNum) : null,
      origination_date: origination || null,
      maturity_date: maturity || null,
      status: 'ACTIVE',
      loan_covenant_id: null,
      covenants: covenants
        .filter((c) => c.threshold.trim() !== '' && Number.isFinite(Number(c.threshold)))
        .map((c) => ({
          covenant_type: c.covenant_type,
          threshold: Number(c.threshold),
          direction: c.direction,
          test_frequency: c.test_frequency,
          label: c.label,
        })),
      liability_account_id: liabilityAcct || null,
      cash_account_id: cashAcct || null,
      interest_expense_account_id: interestExpAcct || null,
      interest_payable_account_id: interestPayAcct || null,
      notes: notes.trim() || null,
      existing_loan: existing,
      current_balance_cents: existing ? dollarsToCents(balanceNum) : null,
      balance_as_of_date: existing ? asOf : null,
      remaining_periods: existing && remainingNum ? remainingNum : null,
    };
    const res = await api.post<{ id: string; existing_loan?: boolean; schedule: { periods: number } }>('/api/debt', payload);
    setSaving(false);
    if (res.error) {
      addToast('error', res.error.error);
      return;
    }
    addToast(
      'success',
      existing
        ? `Loan brought over · ${res.data?.schedule.periods ?? 0} payments scheduled · nothing posted (your opening balances already include it)`
        : `Loan added · ${res.data?.schedule.periods ?? 0}-period schedule generated`,
    );
    onSaved(res.data?.id);
  }

  const inputCls = 'w-full px-2.5 py-1.5 bg-slate-900 border border-slate-700 rounded-md text-xs text-white focus:border-emerald-500 focus:outline-none';
  const label = 'block text-[10px] text-slate-500 mb-1 uppercase tracking-wide';

  return (
    <div className="space-y-4">
      <div className={clsx('rounded-lg border p-3', existing ? 'border-sky-500/30 bg-sky-500/[0.05]' : 'border-slate-800 bg-slate-950/40')}>
        <label className="flex items-start gap-2.5 cursor-pointer">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 rounded border-slate-600 bg-slate-900 text-sky-500 focus:ring-sky-500/50"
            checked={existing}
            onChange={(e) => { touched.current = true; setExisting(e.target.checked); }}
          />
          <span>
            <span className="flex items-center gap-1.5 text-xs font-medium text-slate-200">
              <History size={13} className="text-sky-400" /> This loan already exists — I&rsquo;m bringing over its current balance
            </span>
            <span className="block text-[11px] text-slate-500 mt-0.5">
              {existing
                ? <>We start from what you still owe and build the remaining payments from there. Nothing is posted — your opening balances already include this loan.</>
                : <>Leave off for new money you just borrowed — we&rsquo;ll record the loan proceeds (cash in, loan payable).</>}
            </span>
          </span>
        </label>
        {existing && (
          <div className="grid grid-cols-12 gap-3 mt-3">
            <div className="col-span-4">
              <label className={label}>Balance still owed ($)</label>
              <input className={inputCls} type="number" step="0.01" min="0" value={balance} onChange={(e) => setBalance(e.target.value)} placeholder="e.g. 3,412,950.18" aria-required />
            </div>
            <div className="col-span-4">
              <label className={label}>As of</label>
              <input className={inputCls} type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} aria-required />
            </div>
            <div className="col-span-4">
              <label className={label}>Payments left (optional)</label>
              <input className={inputCls} type="number" step="1" min="1" value={remaining} onChange={(e) => setRemaining(e.target.value)}
                placeholder={derivedRemaining != null && derivedRemaining > 0 ? `${derivedRemaining} (from the term)` : 'from term or maturity'} />
            </div>
            <p className="col-span-12 text-[11px] text-slate-500">
              {derivedRemaining != null && derivedRemaining > 0
                ? <>{derivedRemaining} {frequency.toLowerCase()} payments left after {asOf || 'the as-of date'}.</>
                : derivedRemaining != null
                  ? <span className="text-amber-400">The term has already run out by {asOf} — enter the payments left.</span>
                  : <>Tip: the as-of date is your cutover — the day before MeritBooks takes over.</>}
            </p>
          </div>
        )}
      </div>

      <div className="grid grid-cols-12 gap-3">
        <div className="col-span-6">
          <label className={label}>Loan name</label>
          <input className={clsx(inputCls, lowFlag('loan_name'))} value={loanName} onChange={(e) => setLoanName(e.target.value)} placeholder="e.g. Term Loan A" />
        </div>
        <div className="col-span-3">
          <label className={label}>Lender</label>
          <input className={inputCls} value={lender ?? ''} onChange={(e) => setLender(e.target.value)} placeholder="e.g. Northwest Bank" />
        </div>
        <div className="col-span-3">
          <label className={label}>Facility</label>
          <input className={inputCls} value={facility ?? ''} onChange={(e) => setFacility(e.target.value)} placeholder="e.g. $5M Senior Secured" />
        </div>

        <div className="col-span-3">
          <label className={label}>{existing ? 'Original amount ($, optional)' : 'Principal ($)'}</label>
          <input className={clsx(inputCls, lowFlag('principal'))} type="number" step="0.01" value={principal} onChange={(e) => setPrincipal(e.target.value)} placeholder="e.g. 5,000,000" />
        </div>
        <div className="col-span-2">
          <label className={label}>Rate (% / yr)</label>
          <input className={clsx(inputCls, lowFlag('interest_rate'))} type="number" step="0.001" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="e.g. 7.5" />
        </div>
        <div className="col-span-2">
          <label className={label}>Rate type</label>
          <select className={inputCls} value={rateType} onChange={(e) => setRateType(e.target.value as RateType)}>
            <option value="FIXED">Fixed</option>
            <option value="VARIABLE">Variable</option>
          </select>
        </div>
        <div className="col-span-2">
          <label className={label}>Method</label>
          <select className={inputCls} value={method} onChange={(e) => setMethod(e.target.value as Method)}>
            <option value="AMORTIZING">Amortizing</option>
            <option value="INTEREST_ONLY">Interest-only</option>
          </select>
        </div>
        <div className="col-span-3">
          <label className={label}>Payment frequency</label>
          <select className={inputCls} value={frequency} onChange={(e) => setFrequency(e.target.value as Frequency)}>
            {FREQUENCIES.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        </div>

        <div className="col-span-3">
          <label className={label}>{existing ? 'Original term (# periods)' : 'Term (# periods)'}</label>
          <input className={clsx(inputCls, lowFlag('term_periods'))} type="number" step="1" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="e.g. 60" />
        </div>
        <div className="col-span-3">
          <label className={label}>Fixed payment ($, optional)</label>
          <input className={clsx(inputCls, lowFlag('payment'))} type="number" step="0.01" value={payment} onChange={(e) => setPayment(e.target.value)} placeholder="auto if blank" />
        </div>
        <div className="col-span-3">
          <label className={label}>Origination</label>
          <input className={inputCls} type="date" value={origination ?? ''} onChange={(e) => setOrigination(e.target.value)} />
        </div>
        <div className="col-span-3">
          <label className={label}>Maturity</label>
          <input className={inputCls} type="date" value={maturity ?? ''} onChange={(e) => setMaturity(e.target.value)} />
        </div>

        <div className="col-span-6">
          <label className={label}>Company / location</label>
          <select className={inputCls} value={locationId ?? ''} onChange={(e) => setLocationId(e.target.value)}>
            <option value="">Consolidated (set to post to the ledger)</option>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </div>
        <div className="col-span-6 flex items-end">
          <p className="text-[11px] text-slate-400 pb-1.5 flex items-center gap-1.5">
            <ShieldCheck size={13} className="text-indigo-400 shrink-0" />
            {covenants.length > 0
              ? <>The covenant{covenants.length > 1 ? 's' : ''} below will be created and linked to this loan automatically.</>
              : <>Add any financial covenant in the Covenants section below — it&rsquo;s created and linked when you save.</>}
          </p>
        </div>
      </div>

      <div className="rounded-lg border border-indigo-500/25 bg-indigo-500/[0.04] p-3">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <ShieldCheck size={14} className="text-indigo-400" />
            <span className="text-xs font-medium text-slate-200">
              Covenants{covenants.length > 0 ? ` · ${covenants.length}` : ''}
            </span>
          </div>
          <button type="button" onClick={addCov} className="text-[11px] text-indigo-400 hover:text-indigo-300">
            + Add covenant
          </button>
        </div>
        {covenants.length === 0 ? (
          <p className="text-[11px] text-slate-500">
            No covenants detected. Add one if this loan carries a financial covenant (DSCR, leverage, liquidity…).
          </p>
        ) : (
          <>
            <p className="text-[11px] text-slate-500 mb-2">
              Detected in the document — review, then they&rsquo;re created and linked to this loan when you save. No second upload.
            </p>
            <div className="space-y-2">
              {covenants.map((c, i) => (
                <div key={i} className="grid grid-cols-12 gap-2 items-end">
                  <div className="col-span-3">
                    <label className={label}>Type</label>
                    <select className={inputCls} value={c.covenant_type} onChange={(e) => updateCov(i, { covenant_type: e.target.value as CovType })}>
                      {COV_TYPES.map((t) => <option key={t} value={t}>{COV_TYPE_LABEL[t]}</option>)}
                    </select>
                  </div>
                  <div className="col-span-2">
                    <label className={label}>Direction</label>
                    <select className={inputCls} value={c.direction} onChange={(e) => updateCov(i, { direction: e.target.value as CovDir })}>
                      <option value="MIN">Min (≥)</option>
                      <option value="MAX">Max (≤)</option>
                    </select>
                  </div>
                  <div className="col-span-2">
                    <label className={label}>Threshold</label>
                    <input className={inputCls} type="number" step="0.01" value={c.threshold} onChange={(e) => updateCov(i, { threshold: e.target.value })} placeholder="1.10" />
                  </div>
                  <div className="col-span-3">
                    <label className={label}>Tested</label>
                    <select className={inputCls} value={c.test_frequency} onChange={(e) => updateCov(i, { test_frequency: e.target.value as CovFreq })}>
                      <option value="MONTHLY">Monthly</option>
                      <option value="QUARTERLY">Quarterly</option>
                      <option value="ANNUAL">Annual</option>
                    </select>
                  </div>
                  <div className="col-span-2 flex justify-end">
                    <button type="button" onClick={() => removeCov(i)} className="text-[11px] text-slate-500 hover:text-red-400 px-2 py-1.5" aria-label="Remove covenant">
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <details className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
        <summary className="cursor-pointer text-xs text-slate-400">GL accounts (optional — resolved by role if left blank)</summary>
        <div className="grid grid-cols-2 gap-3 mt-3">
          <div>
            <label className={label}>Notes payable / debt liability</label>
            <select className={inputCls} value={liabilityAcct} onChange={(e) => setLiabilityAcct(e.target.value)}>
              <option value="">Auto / required for payment posting</option>
              {liabilityAccts.map((a) => <option key={a.id} value={a.id}>{a.accountNumber} · {a.name}</option>)}
            </select>
          </div>
          <div>
            <label className={label}>Cash account</label>
            <select className={inputCls} value={cashAcct} onChange={(e) => setCashAcct(e.target.value)}>
              <option value="">Auto (operating bank)</option>
              {cashAccts.map((a) => <option key={a.id} value={a.id}>{a.accountNumber} · {a.name}</option>)}
            </select>
          </div>
          <div>
            <label className={label}>Interest expense</label>
            <select className={inputCls} value={interestExpAcct} onChange={(e) => setInterestExpAcct(e.target.value)}>
              <option value="">Auto (Interest Expense)</option>
              {expenseAccts.map((a) => <option key={a.id} value={a.id}>{a.accountNumber} · {a.name}</option>)}
            </select>
          </div>
          <div>
            <label className={label}>Interest payable</label>
            <select className={inputCls} value={interestPayAcct} onChange={(e) => setInterestPayAcct(e.target.value)}>
              <option value="">Auto (Accrued Expenses)</option>
              {liabilityAccts.map((a) => <option key={a.id} value={a.id}>{a.accountNumber} · {a.name}</option>)}
            </select>
          </div>
        </div>
      </details>

      <div>
        <label className={label}>Notes</label>
        <textarea className={clsx(inputCls, 'min-h-[52px]')} value={notes ?? ''} onChange={(e) => setNotes(e.target.value)} placeholder="Collateral, prepayment penalty, rate index…" />
      </div>

      <div className="flex items-center justify-end gap-2">
        <button onClick={onClose} className="px-4 py-2 text-sm text-slate-400 hover:text-white">Cancel</button>
        <button onClick={submit} disabled={saving} className="px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg disabled:opacity-50 flex items-center gap-2">
          {saving && <Loader2 size={14} className="animate-spin" />}
          {existing ? <>Bring over loan &amp; build schedule</> : <>Create loan &amp; generate schedule</>}
        </button>
      </div>
    </div>
  );
}
