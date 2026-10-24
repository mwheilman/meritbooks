'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Eyebrow,
  Field,
  InlineNotice,
  Input,
  MoneyInput,
  Select,
  Switch,
  Textarea,
  api,
  toast,
  useQuery,
} from '@meritbooks/merit-ui';
import { CHECK_LAYOUTS } from '@/lib/ap/check-print/layout';
import { LayoutThumb } from './layout-thumb';
import {
  CHASE_STYLE_FIXED,
  GENERIC_CSV_MAPPING,
  POSITIVE_PAY_FORMATS,
  validateFixedMapping,
  type CsvMapping,
  type FixedMapping,
  type PpField,
} from '@/lib/ap/checks/positive-pay';
import { accountLabel, postForFile, shortDate, who, type CheckAccount, type CheckLayout, type PositivePayFormat, type StockResponse } from './checks-types';
import s from './checks.module.css';

interface Form {
  layout: CheckLayout;
  offsetXPt: string;
  offsetYPt: string;
  payerName: string;
  payerAddress: string;
  logoUrl: string;
  bankName: string;
  bankAddress: string;
  bankFraction: string;
  secondSignatureOverCents: number | null;
  maxCheckCents: number | null;
  voidAfterDays: string;
  staleAfterDays: string;
  oneCheckPerBill: boolean;
  auxOnUsDigits: string;
  positivePayFormat: PositivePayFormat;
  csv: CsvMapping;
  fixed: FixedMapping;
}

const PP_FIELDS: ReadonlyArray<{ value: PpField; label: string }> = [
  { value: 'account', label: 'Account number' },
  { value: 'routing', label: 'Routing number' },
  { value: 'check_number', label: 'Check number' },
  { value: 'amount', label: 'Amount' },
  { value: 'issue_date', label: 'Issue date' },
  { value: 'payee', label: 'Payee name' },
  { value: 'record_code', label: 'Issue / void code' },
  { value: 'constant', label: 'Fixed text' },
  { value: 'filler', label: 'Blank filler' },
];

function formFrom(d: StockResponse): Form {
  const p = d.profile;
  const m = p?.positive_pay_mapping as (Partial<CsvMapping> & Partial<FixedMapping>) | null;
  return {
    layout: p?.layout ?? 'VOUCHER_TOP',
    offsetXPt: String(Number(p?.offset_x_pt ?? 0)),
    offsetYPt: String(Number(p?.offset_y_pt ?? 0)),
    payerName: p?.payer_name ?? d.defaults.payerName ?? '',
    payerAddress: p?.payer_address ?? '',
    logoUrl: p?.logo_url ?? '',
    bankName: p?.bank_name ?? d.bankAccount.institution ?? '',
    bankAddress: p?.bank_address ?? '',
    bankFraction: p?.bank_fraction ?? '',
    secondSignatureOverCents: p?.second_signature_over_cents ?? null,
    maxCheckCents: p?.max_check_cents ?? null,
    voidAfterDays: String(p?.void_after_days ?? 90),
    staleAfterDays: String(p?.stale_after_days ?? 180),
    oneCheckPerBill: p?.one_check_per_bill ?? false,
    auxOnUsDigits: String(p?.aux_on_us_digits ?? 6),
    positivePayFormat: p?.positive_pay_format ?? 'GENERIC_CSV',
    csv: p?.positive_pay_format === 'CUSTOM_CSV' && m?.columns ? (m as CsvMapping) : GENERIC_CSV_MAPPING,
    fixed: p?.positive_pay_format === 'CUSTOM_FIXED' && m?.fields ? (m as FixedMapping) : CHASE_STYLE_FIXED,
  };
}

function num(v: string): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function validate(f: Form): Record<string, string> {
  const e: Record<string, string> = {};
  const x = num(f.offsetXPt);
  const y = num(f.offsetYPt);
  if (!(x >= -72 && x <= 72)) e.offsetXPt = 'Between −72 and 72 points';
  if (!(y >= -72 && y <= 72)) e.offsetYPt = 'Between −72 and 72 points';
  const v = num(f.voidAfterDays);
  if (!Number.isInteger(v) || v < 30 || v > 365) e.voidAfterDays = '30 to 365 days';
  const st = num(f.staleAfterDays);
  if (!Number.isInteger(st) || st < 30 || st > 730) e.staleAfterDays = '30 to 730 days';
  const a = num(f.auxOnUsDigits);
  if (!Number.isInteger(a) || a < 4 || a > 10) e.auxOnUsDigits = '4 to 10 digits';
  if (f.payerName.trim().length === 0) e.payerName = 'The company name prints on every check';
  if (f.positivePayFormat === 'CUSTOM_FIXED') {
    const p = validateFixedMapping(f.fixed);
    if (p) e.mapping = p;
  }
  if (f.positivePayFormat === 'CUSTOM_CSV' && f.csv.columns.length < 3) e.mapping = 'Add at least three columns';
  return e;
}

export interface StockTabProps {
  account: CheckAccount;
  userId: string | null;
  onChanged: () => void;
}

/** Check stock settings (FPB §4.4). Bank numbers and signatures are write-only from here. */
export function StockTab({ account, userId, onChanged }: StockTabProps) {
  const [refresh, setRefresh] = useState(0);
  const { data, error, isLoading, refetch } = useQuery<StockResponse>('/api/ap/checks/stock', { bank_account_id: account.id }, { key: String(refresh), scope: false });
  const [form, setForm] = useState<Form | null>(null);
  const [saving, setSaving] = useState(false);
  const [micrOpen, setMicrOpen] = useState(false);
  const [routing, setRouting] = useState('');
  const [acct, setAcct] = useState('');
  const [nextNo, setNextNo] = useState('');
  const [nextReason, setNextReason] = useState('');

  useEffect(() => { if (data) { setForm(formFrom(data)); setNextNo(String(data.nextNumber)); } }, [data]);

  const errors = useMemo(() => (form ? validate(form) : {}), [form]);
  const dirty = useMemo(() => !!form && !!data && JSON.stringify(form) !== JSON.stringify(formFrom(data)), [form, data]);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const reload = () => { setRefresh((n) => n + 1); onChanged(); };

  if (isLoading && !data) return <div className="wg-loading" style={{ height: 320 }} aria-busy="true"><span className="bar-l" style={{ width: '45%' }} /></div>;
  if (error || !data) {
    return (
      <InlineNotice tone="neg" title="Couldn't load the check stock settings.">
        {error} <Button variant="quiet" onClick={() => void refetch()}>Try again</Button>
      </InlineNotice>
    );
  }
  if (!form) return null;
  const names = data.names ?? {};

  const save = async () => {
    if (Object.keys(errors).length || saving) return;
    setSaving(true);
    const body = {
      bankAccountId: account.id,
      layout: form.layout,
      offsetXPt: num(form.offsetXPt),
      offsetYPt: num(form.offsetYPt),
      payerName: form.payerName.trim() || null,
      payerAddress: form.payerAddress.trim() || null,
      logoUrl: form.logoUrl.trim() || null,
      bankName: form.bankName.trim() || null,
      bankAddress: form.bankAddress.trim() || null,
      bankFraction: form.bankFraction.trim() || null,
      secondSignatureOverCents: form.secondSignatureOverCents,
      maxCheckCents: form.maxCheckCents,
      voidAfterDays: num(form.voidAfterDays),
      staleAfterDays: num(form.staleAfterDays),
      oneCheckPerBill: form.oneCheckPerBill,
      auxOnUsDigits: num(form.auxOnUsDigits),
      positivePayFormat: form.positivePayFormat,
      positivePayMapping: form.positivePayFormat === 'CUSTOM_CSV' ? form.csv : form.positivePayFormat === 'CUSTOM_FIXED' ? form.fixed : null,
    };
    const res = await api.put<{ ok: boolean }>('/api/ap/checks/stock', body);
    setSaving(false);
    if (res.error) { toast.error(res.error.error); return; }
    toast('Check stock settings saved.');
    reload();
  };

  const saveMicr = async () => {
    const res = await api.post<{ routingMask: string; accountMask: string }>('/api/ap/checks/stock/micr', { bankAccountId: account.id, routing: routing.trim(), account: acct.trim() });
    if (res.error) { toast.error(res.error.error); return; }
    toast(`Bank numbers saved (routing ${res.data?.routingMask}, account ${res.data?.accountMask}).`);
    setRouting(''); setAcct(''); setMicrOpen(false);
    reload();
  };

  const uploadSig = async (slot: 1 | 2, file: File | null) => {
    if (!file) return;
    const fd = new FormData();
    fd.set('bankAccountId', account.id);
    fd.set('slot', String(slot));
    fd.set('file', file);
    const res = await fetch('/api/ap/checks/stock/signature', { method: 'POST', body: fd });
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) { toast.error(j.error ?? 'Could not save the signature.'); return; }
    toast(`Signature ${slot} saved. It only appears on printed checks.`);
    reload();
  };

  const removeSig = async (slot: 1 | 2) => {
    const res = await api.delete<{ ok: boolean }>(`/api/ap/checks/stock/signature?bank_account_id=${account.id}&slot=${slot}`);
    if (res.error) { toast.error(res.error.error); return; }
    toast(`Signature ${slot} removed.`);
    reload();
  };

  const moveSequence = async () => {
    const n = Number(nextNo);
    if (!Number.isInteger(n) || n < 1) { toast.error('Enter a whole check number.'); return; }
    const res = await api.post<{ status: string; next_number: number }>('/api/ap/checks/stock/sequence', { bankAccountId: account.id, nextNumber: n, reason: nextReason.trim() });
    if (res.error) { toast.error(res.error.error); return; }
    toast(res.data?.status === 'unchanged' ? 'The next number is unchanged.' : `The next check number is now ${res.data?.next_number}.`);
    setNextReason('');
    reload();
  };

  const testAlignment = async () => {
    const tab = window.open('', '_blank');
    try {
      await postForFile('/api/ap/checks/alignment', { bankAccountId: account.id, layout: form.layout, offsetXPt: num(form.offsetXPt) || 0, offsetYPt: num(form.offsetYPt) || 0 }, 'check-alignment-test.pdf', tab);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not build the alignment test.');
    }
  };

  const confirmChange = async (id: string) => {
    const res = await api.post<{ ok: boolean }>('/api/ap/checks/stock/confirm', { changeId: id });
    if (res.error) { toast.error(res.error.error); return; }
    toast('Change confirmed. The print hold on that person is lifted.');
    reload();
  };

  const p = data.profile;
  const changes = data.securityChanges ?? [];
  return (
    <div>
      {changes.length > 0 && (
        <InlineNotice tone="warn" title={`${changes.length} security change${changes.length === 1 ? '' : 's'} waiting for a second admin`}>
          <p style={{ margin: '0 0 8px' }}>
            Whoever changes a signature, the bank numbers or a check limit can&apos;t print checks on this account for 24 hours unless a different admin confirms the change. Every admin was notified.
          </p>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {changes.map((c) => (
              <li key={c.id} style={{ marginBottom: 6 }}>
                {c.summary} — {who(names, c.changed_by, userId)}, {shortDate(c.changed_at)} (hold ends {shortDate(c.hold_until)})
                {c.changed_by !== userId && data.canConfirmSecurity && (
                  <> <Button variant="quiet" onClick={() => void confirmChange(c.id)}>I recognise this change — confirm</Button></>
                )}
                {c.changed_by === userId && <span className="t-cap"> · you made this change, so another admin has to confirm it</span>}
              </li>
            ))}
          </ul>
        </InlineNotice>
      )}
      <div className={s.cols}>
        <div>
          <section className={s.sec}>
            <Eyebrow>01 // Layout</Eyebrow>
            <div className={s.layouts} role="group" aria-label="Check stock layout">
              {CHECK_LAYOUTS.map((l) => (
                <button key={l.value} type="button" className={s.layout} aria-pressed={form.layout === l.value} onClick={() => set('layout', l.value)}>
                  <LayoutThumb layout={l.value} className={s.thumb} />
                  <b>{l.label}</b>
                  <span>{l.help}</span>
                </button>
              ))}
            </div>
            <div className={s.grid3} style={{ marginTop: 12 }}>
              <Field label="Nudge right (pt)" error={errors.offsetXPt} help="72 pt = 1 inch; negative moves left">
                <Input type="number" step="0.5" value={form.offsetXPt} onChange={(e) => set('offsetXPt', e.target.value)} />
              </Field>
              <Field label="Nudge down (pt)" error={errors.offsetYPt} help="Negative moves up">
                <Input type="number" step="0.5" value={form.offsetYPt} onChange={(e) => set('offsetYPt', e.target.value)} />
              </Field>
              <Field label="Alignment">
                <Button onClick={() => void testAlignment()} icon="file-text">Test these values</Button>
              </Field>
            </div>
          </section>

          <section className={s.sec}>
            <Eyebrow>02 // What prints</Eyebrow>
            <div className={s.grid2}>
              <Field label="Company name" error={errors.payerName}>
                <Input value={form.payerName} onChange={(e) => set('payerName', e.target.value)} maxLength={200} />
              </Field>
              <Field label="Bank name">
                <Input value={form.bankName} onChange={(e) => set('bankName', e.target.value)} maxLength={200} />
              </Field>
              <Field label="Company address">
                <Textarea rows={3} value={form.payerAddress} onChange={(e) => set('payerAddress', e.target.value)} maxLength={500} />
              </Field>
              <Field label="Bank city / address">
                <Textarea rows={3} value={form.bankAddress} onChange={(e) => set('bankAddress', e.target.value)} maxLength={500} />
              </Field>
              <Field label="Fraction code" help="The small number from your bank, e.g. 12-3456/1234">
                <Input value={form.bankFraction} onChange={(e) => set('bankFraction', e.target.value)} maxLength={40} />
              </Field>
              <Field label="Logo" help="Uses a logo uploaded in Invoice design">
                <div className={s.onFile}>
                  <span className="t-cap">{form.logoUrl ? 'Logo set' : 'No logo — the company name prints'}</span>
                  {data.defaults.logoUrl && form.logoUrl !== data.defaults.logoUrl && <Button variant="quiet" onClick={() => set('logoUrl', data.defaults.logoUrl ?? '')}>Use the invoice logo</Button>}
                  {form.logoUrl && <Button variant="quiet" onClick={() => set('logoUrl', '')}>Remove</Button>}
                </div>
              </Field>
            </div>
          </section>

          <section className={s.sec}>
            <Eyebrow>03 // Controls</Eyebrow>
            <div className={s.grid2}>
              <Field label="Second signature over" help="Leave empty for one signature on every check">
                <MoneyInput valueCents={form.secondSignatureOverCents} onChangeCents={(c) => set('secondSignatureOverCents', c && c > 0 ? c : null)} />
              </Field>
              <Field label="Don't print checks over" help="Optional ceiling for this account">
                <MoneyInput valueCents={form.maxCheckCents} onChangeCents={(c) => set('maxCheckCents', c && c > 0 ? c : null)} />
              </Field>
              <Field label="Print “void after” (days)" error={errors.voidAfterDays}>
                <Input type="number" value={form.voidAfterDays} onChange={(e) => set('voidAfterDays', e.target.value)} />
              </Field>
              <Field label="Flag as stale after (days)" error={errors.staleAfterDays}>
                <Input type="number" value={form.staleAfterDays} onChange={(e) => set('staleAfterDays', e.target.value)} />
              </Field>
              <Field label="Check-number digits on the MICR line" error={errors.auxOnUsDigits} help="Zero-padded; most banks use 6">
                <Input type="number" value={form.auxOnUsDigits} onChange={(e) => set('auxOnUsDigits', e.target.value)} />
              </Field>
              <Field label="Grouping">
                <Switch label="One check per bill (instead of one per vendor)" checked={form.oneCheckPerBill} onChange={(e) => set('oneCheckPerBill', e.target.checked)} />
              </Field>
            </div>
          </section>

          <section className={s.sec}>
            <Eyebrow>04 // Positive pay</Eyebrow>
            <Field label="File format" help={POSITIVE_PAY_FORMATS.find((f) => f.value === form.positivePayFormat)?.help}>
              <Select value={form.positivePayFormat} onChange={(e) => set('positivePayFormat', e.target.value as PositivePayFormat)}>
                {POSITIVE_PAY_FORMATS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
              </Select>
            </Field>
            {form.positivePayFormat === 'CUSTOM_CSV' && <CsvMappingEditor value={form.csv} onChange={(v) => set('csv', v)} />}
            {form.positivePayFormat === 'CUSTOM_FIXED' && <FixedMappingEditor value={form.fixed} onChange={(v) => set('fixed', v)} />}
            {errors.mapping && <p className={s.blocked} role="alert">{errors.mapping}</p>}
          </section>

          <div className={s.savebar}>
            <Button variant="primary" onClick={() => void save()} disabled={!dirty || saving || Object.keys(errors).length > 0}>{saving ? 'Saving…' : 'Save settings'}</Button>
            <Button onClick={() => setForm(formFrom(data))} disabled={!dirty || saving}>Discard changes</Button>
            <span className="t-cap">{p?.updated_at ? `Last changed ${shortDate(p.updated_at)} by ${who(names, p.updated_by, userId)}` : 'Not set up yet'}</span>
          </div>
        </div>

        <div>
          <section className={s.sec}>
            <Eyebrow>Bank numbers (MICR line)</Eyebrow>
            {data.hasMicr ? (
              <p className={s.onFile}>
                Routing <b className="tnum">{p?.routing_mask}</b> · account <b className="tnum">{p?.account_mask}</b>
                <span className="t-cap">set {shortDate(p?.micr_set_at ?? null)} by {who(names, p?.micr_set_by, userId)}</span>
              </p>
            ) : (
              <p className="t-cap">Not set. Checks can&apos;t print without them.</p>
            )}
            {micrOpen || !data.hasMicr ? (
              <>
                <div className={s.grid2}>
                  <Field label="Routing number" help="9 digits, from the bottom-left of a printed check">
                    <Input inputMode="numeric" autoComplete="off" value={routing} onChange={(e) => setRouting(e.target.value.replace(/[^\d]/g, '').slice(0, 9))} />
                  </Field>
                  <Field label="Account number" help={account.mask ? `Must end in ${account.mask.replace(/\D/g, '').slice(-4)}` : '4 to 17 digits'}>
                    <Input inputMode="numeric" autoComplete="off" value={acct} onChange={(e) => setAcct(e.target.value.replace(/[^\d]/g, '').slice(0, 17))} />
                  </Field>
                </div>
                <div className="btn-row">
                  <Button variant="primary" onClick={() => void saveMicr()} disabled={routing.length !== 9 || acct.length < 4}>Save bank numbers</Button>
                  {data.hasMicr && <Button variant="quiet" onClick={() => { setMicrOpen(false); setRouting(''); setAcct(''); }}>Cancel</Button>}
                </div>
                <p className="t-cap" style={{ marginTop: 8 }}>Stored encrypted. Only the last four digits are ever shown again; replacing them is logged.</p>
              </>
            ) : (
              <Button onClick={() => setMicrOpen(true)}>Replace bank numbers</Button>
            )}
          </section>

          <section className={s.sec}>
            <Eyebrow>Signatures</Eyebrow>
            {[1, 2].map((slot) => {
              const has = slot === 1 ? data.hasSignature : data.hasSignature2;
              const at = slot === 1 ? p?.signature_set_at : p?.signature2_set_at;
              const by = slot === 1 ? p?.signature_set_by : p?.signature2_set_by;
              return (
                <Field key={slot} label={slot === 1 ? 'Signature' : 'Second signature (over the threshold)'} help="PNG or JPEG, up to 512 KB, signed in dark ink on white">
                  <div className={s.onFile}>
                    <span className="t-cap">{has ? `On file — uploaded ${shortDate(at ?? null)} by ${who(names, by, userId)}` : 'None — a blank line prints to sign by hand'}</span>
                    <input type="file" accept="image/png,image/jpeg" aria-label={`Upload signature ${slot}`} onChange={(e) => { void uploadSig(slot as 1 | 2, e.target.files?.[0] ?? null); e.currentTarget.value = ''; }} />
                    {has && <Button variant="quiet" onClick={() => void removeSig(slot as 1 | 2)}>Remove</Button>}
                  </div>
                </Field>
              );
            })}
            <p className="t-cap">Signature images are kept in private storage and are never shown on screen — they appear only on printed checks.</p>
          </section>

          <section className={s.sec}>
            <Eyebrow>Check numbers</Eyebrow>
            <p className="t-ui">Next check number on {accountLabel(account)}: <b className="tnum">{data.nextNumber}</b></p>
            <div className={s.grid2}>
              <Field label="Start the next check at" help="Must be above every number already printed">
                <Input type="number" value={nextNo} onChange={(e) => setNextNo(e.target.value)} />
              </Field>
              <Field label="Reason">
                <Input value={nextReason} onChange={(e) => setNextReason(e.target.value)} placeholder="New box of stock starts at 5001" maxLength={500} />
              </Field>
            </div>
            <Button onClick={() => void moveSequence()} disabled={nextReason.trim().length < 3 || Number(nextNo) === data.nextNumber}>Change next number</Button>
          </section>

          <InlineNotice tone="info" title="MICR printing">
            The MICR line prints at the bank-standard positions with built-in E-13B shapes. Use MICR toner, and ask your bank to test a printed
            sample (or install a licensed E-13B font) before you issue live checks.
          </InlineNotice>
        </div>
      </div>
    </div>
  );
}

function CsvMappingEditor({ value, onChange }: { value: CsvMapping; onChange: (v: CsvMapping) => void }) {
  const upd = (i: number, patch: Partial<CsvMapping['columns'][number]>) => onChange({ ...value, columns: value.columns.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  return (
    <div>
      {value.columns.map((c, i) => (
        <div key={i} className={`${s.mapRow} ${s.mapRowCsv}`}>
          <Select aria-label={`Column ${i + 1} field`} value={c.field} onChange={(e) => upd(i, { field: e.target.value as PpField })}>
            {PP_FIELDS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </Select>
          <Input aria-label={`Column ${i + 1} header`} value={c.header} onChange={(e) => upd(i, { header: e.target.value })} maxLength={60} />
          <Input aria-label={`Column ${i + 1} fixed text`} value={c.value ?? ''} disabled={c.field !== 'constant'} onChange={(e) => upd(i, { value: e.target.value })} maxLength={60} />
          <Button iconOnly icon="x" aria-label={`Remove column ${i + 1}`} onClick={() => onChange({ ...value, columns: value.columns.filter((_, j) => j !== i) })} />
        </div>
      ))}
      <div className="btn-row" style={{ marginBottom: 12 }}>
        <Button variant="quiet" icon="plus" onClick={() => onChange({ ...value, columns: [...value.columns, { field: 'filler', header: 'Column' }] })} disabled={value.columns.length >= 20}>Add column</Button>
      </div>
      <MappingCodes value={value} onChange={(v) => onChange({ ...value, ...v })} />
      <Switch label="First row is a header" checked={value.includeHeader} onChange={(e) => onChange({ ...value, includeHeader: e.target.checked })} />
    </div>
  );
}

function FixedMappingEditor({ value, onChange }: { value: FixedMapping; onChange: (v: FixedMapping) => void }) {
  const upd = (i: number, patch: Partial<FixedMapping['fields'][number]>) => onChange({ ...value, fields: value.fields.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  return (
    <div>
      <div className={s.mapRow} aria-hidden="true">
        <span className="t-cap">Field</span><span className="t-cap">Fixed text</span><span className="t-cap">Start</span><span className="t-cap">Length</span><span className="t-cap">Align</span><span className="t-cap">Pad</span><span />
      </div>
      {value.fields.map((c, i) => (
        <div key={i} className={s.mapRow}>
          <Select aria-label={`Field ${i + 1}`} value={c.field} onChange={(e) => upd(i, { field: e.target.value as PpField })}>
            {PP_FIELDS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </Select>
          <Input aria-label={`Field ${i + 1} fixed text`} value={c.value ?? ''} disabled={c.field !== 'constant'} onChange={(e) => upd(i, { value: e.target.value })} />
          <Input aria-label={`Field ${i + 1} start column`} type="number" value={c.start} onChange={(e) => upd(i, { start: Number(e.target.value) })} />
          <Input aria-label={`Field ${i + 1} length`} type="number" value={c.length} onChange={(e) => upd(i, { length: Number(e.target.value) })} />
          <Select aria-label={`Field ${i + 1} align`} value={c.align} onChange={(e) => upd(i, { align: e.target.value as 'left' | 'right' })}>
            <option value="left">Left</option><option value="right">Right</option>
          </Select>
          <Select aria-label={`Field ${i + 1} pad`} value={c.pad} onChange={(e) => upd(i, { pad: e.target.value as '0' | ' ' })}>
            <option value=" ">Spaces</option><option value="0">Zeros</option>
          </Select>
          <Button iconOnly icon="x" aria-label={`Remove field ${i + 1}`} onClick={() => onChange({ ...value, fields: value.fields.filter((_, j) => j !== i) })} />
        </div>
      ))}
      <div className="btn-row" style={{ marginBottom: 12 }}>
        <Button variant="quiet" icon="plus" onClick={() => onChange({ ...value, fields: [...value.fields, { field: 'filler', start: value.recordLength, length: 1, align: 'left', pad: ' ' }] })} disabled={value.fields.length >= 30}>Add field</Button>
      </div>
      <Field label="Record length (characters)">
        <Input type="number" value={value.recordLength} onChange={(e) => onChange({ ...value, recordLength: Number(e.target.value) })} />
      </Field>
      <MappingCodes value={value} onChange={(v) => onChange({ ...value, ...v })} />
    </div>
  );
}

function MappingCodes({ value, onChange }: { value: Pick<CsvMapping, 'dateFormat' | 'amountFormat' | 'issueCode' | 'voidCode'>; onChange: (v: Partial<CsvMapping>) => void }) {
  return (
    <div className={s.grid2}>
      <Field label="Date format">
        <Select value={value.dateFormat} onChange={(e) => onChange({ dateFormat: e.target.value as CsvMapping['dateFormat'] })}>
          {['MMDDYYYY', 'YYYYMMDD', 'MMDDYY', 'YYYY-MM-DD', 'MM/DD/YYYY'].map((d) => <option key={d} value={d}>{d}</option>)}
        </Select>
      </Field>
      <Field label="Amount">
        <Select value={value.amountFormat} onChange={(e) => onChange({ amountFormat: e.target.value as CsvMapping['amountFormat'] })}>
          <option value="DOLLARS">Dollars and cents (1234.56)</option>
          <option value="CENTS">Cents, no decimal (123456)</option>
        </Select>
      </Field>
      <Field label="Issue code"><Input value={value.issueCode} maxLength={4} onChange={(e) => onChange({ issueCode: e.target.value })} /></Field>
      <Field label="Void code"><Input value={value.voidCode} maxLength={4} onChange={(e) => onChange({ voidCode: e.target.value })} /></Field>
    </div>
  );
}
