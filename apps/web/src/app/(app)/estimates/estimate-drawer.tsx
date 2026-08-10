'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { formatMoney } from '@meritbooks/shared';
import { useQuery } from '@/hooks/use-query';
import {
  X, Loader2, Send, Check, Ban, Clock, FileDown, ArrowRightCircle,
  Pencil, AlertCircle, ExternalLink,
} from 'lucide-react';
import { EstimateStatusBadge } from './estimate-status-badge';
import type { EstimateDetail } from './types';

const fmtDate = (d: string | null) =>
  d ? new Date(d + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '—';

/**
 * Estimate detail drawer: header + lines, lifecycle actions (Send / Accept /
 * Decline / Expire — all with an accessible confirm), Convert-to-invoice, a PDF
 * download, and a link to the resulting invoice once converted.
 */
export function EstimateDrawer({
  estimateId,
  onClose,
  onChanged,
  onEdit,
}: {
  estimateId: string | null;
  onClose: () => void;
  onChanged: () => void;
  onEdit: (detail: EstimateDetail) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState<{ label: string; run: () => void } | null>(null);

  const { data, isLoading, refetch } = useQuery<EstimateDetail>(
    estimateId ? `/api/estimates/${estimateId}` : null,
    undefined,
    { scope: false },
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (confirm) setConfirm(null);
        else if (estimateId) onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [estimateId, onClose, confirm]);

  if (!estimateId) return null;

  const est = data ?? null;
  const isConverted = est?.status === 'CONVERTED' || !!est?.convertedInvoiceId;
  const canConvert = est && !isConverted && ['DRAFT', 'SENT', 'ACCEPTED'].includes(est.status);
  const canEdit = est && !isConverted;

  const setStatus = async (status: string) => {
    if (!est) return;
    setBusy(status);
    setError('');
    try {
      const res = await fetch(`/api/estimates/${est.id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(j.error ?? 'Could not update status');
        return;
      }
      await refetch();
      onChanged();
    } catch {
      setError('Network error');
    } finally {
      setBusy(null);
    }
  };

  const convert = async () => {
    if (!est) return;
    setBusy('convert');
    setError('');
    try {
      const res = await fetch(`/api/estimates/${est.id}/convert`, { method: 'POST' });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(j.error ?? 'Could not convert estimate');
        return;
      }
      await refetch();
      onChanged();
    } catch {
      setError('Network error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true" aria-label="Estimate detail">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden="true" />
      <div className="relative w-full max-w-xl bg-gray-900 border-l border-gray-700 h-full overflow-y-auto">
        <div className="sticky top-0 z-10 flex items-center justify-between p-5 border-b border-gray-700/50 bg-gray-900">
          <div className="flex items-center gap-3">
            <h2 className="text-base font-semibold text-white font-mono">
              {est?.estimateNumber ?? 'Estimate'}
            </h2>
            {est && <EstimateStatusBadge status={est.status} />}
          </div>
          <button onClick={onClose} aria-label="Close" className="p-1 text-gray-400 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        {isLoading || !est ? (
          <div className="flex items-center justify-center py-24">
            <Loader2 className="w-6 h-6 text-emerald-400 animate-spin" />
          </div>
        ) : (
          <div className="p-5 space-y-5">
            {error && (
              <div className="flex items-start gap-2 p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-sm text-red-400">
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {isConverted && est.convertedInvoice && (
              <Link
                href={`/invoices?invoice=${est.convertedInvoice.id}`}
                className="flex items-center justify-between gap-2 p-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-sm"
              >
                <span className="text-emerald-300">
                  Converted to invoice{' '}
                  <span className="font-mono font-semibold">{est.convertedInvoice.invoiceNumber}</span>
                  {est.convertedAt ? ` on ${fmtDate(est.convertedAt.slice(0, 10))}` : ''}
                </span>
                <ExternalLink className="w-4 h-4 text-emerald-400 shrink-0" />
              </Link>
            )}

            {/* Meta */}
            <div className="grid grid-cols-2 gap-4 text-sm">
              <Meta label="Customer" value={est.customer?.name ?? '—'} />
              <Meta label="Company" value={est.location?.name ?? '—'} />
              <Meta label="Estimate date" value={fmtDate(est.estimateDate)} />
              <Meta label="Valid until" value={fmtDate(est.expirationDate)} />
              {est.job && <Meta label="Job" value={`${est.job.jobNumber} · ${est.job.name}`} />}
            </div>

            {/* Lines */}
            <div className="rounded-lg border border-gray-800 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500 uppercase tracking-wider bg-gray-800/50">
                    <th className="py-2 px-3">Description</th>
                    <th className="py-2 px-3 text-right">Qty</th>
                    <th className="py-2 px-3 text-right">Rate</th>
                    <th className="py-2 px-3 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {est.lines.map((l) => (
                    <tr key={l.id} className="border-t border-gray-800/50">
                      <td className="py-2 px-3">
                        <div className="text-gray-200">{l.description}</div>
                        {l.account && (
                          <div className="text-[11px] text-gray-500 font-mono">
                            {l.account.accountNumber} · {l.account.name}
                          </div>
                        )}
                      </td>
                      <td className="py-2 px-3 text-right font-mono text-gray-400 tabular-nums">{l.quantity}</td>
                      <td className="py-2 px-3 text-right font-mono text-gray-400 tabular-nums">
                        {formatMoney(l.unitPriceCents, { currency: est.currency })}
                      </td>
                      <td className="py-2 px-3 text-right font-mono text-white tabular-nums">
                        {formatMoney(l.amountCents, { currency: est.currency })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Totals */}
            <div className="space-y-1.5 text-sm max-w-xs ml-auto">
              <Row label="Subtotal" value={formatMoney(est.subtotalCents, { currency: est.currency })} muted />
              {est.taxCents > 0 && (
                <Row label="Tax" value={formatMoney(est.taxCents, { currency: est.currency })} muted />
              )}
              <div className="flex justify-between border-t border-gray-700/50 pt-2 font-semibold">
                <span className="text-white">Total</span>
                <span className="font-mono text-emerald-400 tabular-nums">
                  {formatMoney(est.totalCents, { currency: est.currency })}
                </span>
              </div>
            </div>

            {est.notes && (
              <div className="rounded-lg bg-gray-800/50 border border-gray-700/50 p-3 text-sm text-gray-300 whitespace-pre-wrap">
                {est.notes}
              </div>
            )}

            {/* Actions */}
            <div className="border-t border-gray-700/50 pt-4 space-y-3">
              {!isConverted && (
                <div className="flex flex-wrap gap-2">
                  {est.status !== 'SENT' && (
                    <ActionBtn icon={Send} label="Mark sent" busy={busy === 'SENT'} onClick={() => setStatus('SENT')} />
                  )}
                  {est.status !== 'ACCEPTED' && (
                    <ActionBtn
                      icon={Check}
                      label="Mark accepted"
                      tone="emerald"
                      busy={busy === 'ACCEPTED'}
                      onClick={() =>
                        setConfirm({ label: 'Mark this estimate as accepted by the customer?', run: () => setStatus('ACCEPTED') })
                      }
                    />
                  )}
                  {est.status !== 'DECLINED' && (
                    <ActionBtn
                      icon={Ban}
                      label="Decline"
                      tone="red"
                      busy={busy === 'DECLINED'}
                      onClick={() =>
                        setConfirm({ label: 'Mark this estimate as declined?', run: () => setStatus('DECLINED') })
                      }
                    />
                  )}
                  {est.status !== 'EXPIRED' && (
                    <ActionBtn icon={Clock} label="Expire" busy={busy === 'EXPIRED'} onClick={() => setStatus('EXPIRED')} />
                  )}
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                {canEdit && (
                  <ActionBtn icon={Pencil} label="Edit" onClick={() => onEdit(est)} />
                )}
                <a
                  href={`/api/estimates/${est.id}/pdf`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200"
                >
                  <FileDown className="w-4 h-4" /> Download PDF
                </a>
                {canConvert && (
                  <button
                    onClick={() =>
                      setConfirm({
                        label:
                          'Convert this estimate to a real invoice? This creates and posts an invoice from these lines. The estimate will be locked and cannot be converted again.',
                        run: convert,
                      })
                    }
                    disabled={busy === 'convert'}
                    className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-medium"
                  >
                    {busy === 'convert' ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <ArrowRightCircle className="w-4 h-4" />
                    )}
                    Convert to invoice
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Accessible confirm */}
      {confirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div
            role="alertdialog"
            aria-modal="true"
            aria-label="Confirm action"
            className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-sm p-5"
          >
            <p className="text-sm text-gray-200">{confirm.label}</p>
            <div className="flex justify-end gap-3 mt-5">
              <button onClick={() => setConfirm(null)} className="px-4 py-2 text-sm text-gray-400 hover:text-white">
                Cancel
              </button>
              <button
                onClick={() => {
                  const run = confirm.run;
                  setConfirm(null);
                  run();
                }}
                className="px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-medium"
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] text-gray-500 uppercase tracking-wider">{label}</div>
      <div className="text-gray-200 mt-0.5">{value}</div>
    </div>
  );
}

function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex justify-between">
      <span className={muted ? 'text-gray-400' : 'text-white'}>{label}</span>
      <span className="font-mono text-gray-200 tabular-nums">{value}</span>
    </div>
  );
}

function ActionBtn({
  icon: Icon,
  label,
  onClick,
  busy,
  tone = 'gray',
}: {
  icon: typeof Send;
  label: string;
  onClick: () => void;
  busy?: boolean;
  tone?: 'gray' | 'emerald' | 'red';
}) {
  const toneCls =
    tone === 'emerald'
      ? 'text-emerald-300 hover:bg-emerald-500/10 border-emerald-500/30'
      : tone === 'red'
        ? 'text-red-300 hover:bg-red-500/10 border-red-500/30'
        : 'text-gray-200 hover:bg-gray-700 border-gray-700';
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className={`inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm bg-gray-800 border disabled:opacity-50 ${toneCls}`}
    >
      {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Icon className="w-4 h-4" />}
      {label}
    </button>
  );
}
