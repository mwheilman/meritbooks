'use client';

import { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Search, Loader2, Check, Clock, AlertCircle, Plug, ArrowRight, Upload,
  PencilLine, Send, SkipForward, RefreshCw, Sparkles,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery, useDebounce, addToast } from '@/hooks';
import {
  ERP_VERTICALS, ERP_METHOD_LABELS, ERP_DATA_TYPE_LABELS, groupErpCatalogByVertical,
  type ErpConnector, type ErpVertical,
} from '@/lib/integrations/erp/catalog';
import type { ErpConnection } from '@/lib/integrations/erp/connection';
import { MigrationConnectors } from '@/components/integrations/migration-connectors';

interface ErpApiResponse {
  catalog: ErpConnector[];
  connections: ErpConnection[];
  provisioned: boolean;
  error?: string;
}

interface ConnectResponse {
  ok: boolean;
  action: 'redirect' | 'requested' | 'connected' | 'coming_soon';
  href: string | null;
  recorded: boolean;
  status: string;
  erpId: string;
  error?: string;
}

const STATUS_STYLES: Record<string, string> = {
  connected: 'text-brand-300 bg-brand-500/10 border-brand-500/30',
  pending: 'text-amber-300 bg-amber-500/10 border-amber-500/30',
  error: 'text-danger-fg bg-danger/10 border-danger/30',
};

function monogram(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9 ]/g, ' ').trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export interface ConnectErpStepProps {
  /** True when mounted inside the onboarding wizard (compact chrome + skip/done). */
  embedded?: boolean;
  /** Called when the user chooses to skip / do this later. */
  onSkip?: () => void;
  /** Called after a successful connect/request when embedded, to advance the wizard. */
  onDone?: () => void;
}

/**
 * ConnectErpStep — the reusable "Connect your existing system" surface.
 *
 * Standalone under Integrations, and embeddable as an onboarding step. Renders the
 * provider-agnostic connector catalog (searchable, grouped by vertical), this
 * tenant's live connection status, an always-available CSV path, and a prominent
 * SKIP. Per-ERP sync is future; this drives the framework's connect/request intents.
 */
export function ConnectErpStep({ embedded = false, onSkip, onDone }: ConnectErpStepProps) {
  const router = useRouter();
  const { data, isLoading, error, refetch } = useQuery<ErpApiResponse>('/api/integrations/erp');

  const [rawSearch, setRawSearch] = useState('');
  const search = useDebounce(rawSearch, 200);
  const [vertical, setVertical] = useState<ErpVertical | 'all'>('all');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [requestFor, setRequestFor] = useState<string | null>(null);
  const [requestName, setRequestName] = useState('');

  const catalog = data?.catalog ?? [];
  const connections = data?.connections ?? [];
  const provisioned = data?.provisioned ?? false;

  const connByErp = useMemo(() => {
    const m = new Map<string, ErpConnection>();
    for (const c of connections) m.set(c.erpId, c);
    return m;
  }, [connections]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return catalog.filter((c) => {
      if (vertical !== 'all' && c.vertical !== vertical) return false;
      if (!q) return true;
      return (
        c.name.toLowerCase().includes(q) ||
        (c.description ?? '').toLowerCase().includes(q)
      );
    });
  }, [catalog, search, vertical]);

  const groups = useMemo(() => groupErpCatalogByVertical(filtered), [filtered]);

  const doConnect = useCallback(
    async (connector: ErpConnector, requestedName?: string) => {
      setBusyId(connector.id);
      try {
        const res = await fetch('/api/integrations/erp/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ erpId: connector.id, requestedName }),
        });
        const body = (await res.json().catch(() => ({}))) as ConnectResponse;
        if (!res.ok || !body.ok) {
          addToast('error', body.error ?? 'Could not start that connection.');
          return;
        }
        await refetch();
        switch (body.action) {
          case 'redirect':
            addToast('success', 'Opening the import flow — map your file to the ledger.');
            router.push(body.href ?? '/import');
            break;
          case 'connected':
            addToast('success', `${connector.name} set — you're working directly in the book of record.`);
            onDone?.();
            break;
          case 'requested':
            addToast('success', 'Request received — we’ll prioritize a connector and follow up.');
            setRequestFor(null);
            setRequestName('');
            break;
          case 'coming_soon':
          default:
            addToast(
              'success',
              body.recorded
                ? `Noted — we’ll enable the ${connector.name} sync for your tenant and reach out.`
                : `Interest in ${connector.name} noted.`,
            );
            break;
        }
      } catch {
        addToast('error', 'Network error starting that connection.');
      } finally {
        setBusyId(null);
      }
    },
    [refetch, router, onDone],
  );

  return (
    <div className="space-y-5">
      {/* Header (standalone only; the wizard supplies its own step header). */}
      {!embedded && (
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-white tracking-tight flex items-center gap-2">
              <Plug size={20} className="text-brand-400" /> Connect your existing system
            </h1>
            <p className="text-sm text-slate-400 mt-1 max-w-2xl">
              Link the operational system your team already uses so your accounting-relevant data —
              customers, jobs, invoices, bills, costs — flows into the book of record.
            </p>
          </div>
        </div>
      )}

      {/* Degrade-safe notice: connecting not yet provisioned for this tenant. */}
      {!isLoading && !error && !provisioned && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 px-4 py-2.5 text-xs text-amber-200">
          <AlertCircle size={14} className="shrink-0 mt-0.5" />
          <span>
            Live connections aren’t enabled for this tenant yet. You can still import by file today, or skip and set
            this up later — your book of record works either way.
          </span>
        </div>
      )}

      {/* Direct-API migration sources (QuickBooks / Xero / Sage) — one-time import
          of prior books straight into the historical-conversion pipeline. */}
      <MigrationConnectors />

      {/* Existing connections for this tenant. */}
      {connections.length > 0 && (
        <div className="card p-4 space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Connected systems</p>
          <div className="space-y-1.5">
            {connections.map((conn) => {
              const connector = catalog.find((c) => c.id === conn.erpId);
              return (
                <div
                  key={conn.id}
                  className="flex items-center justify-between rounded-lg bg-surface-900 border border-slate-800 px-3 py-2"
                >
                  <div className="flex items-center gap-2.5">
                    <div className="h-7 w-7 rounded-md bg-brand-500/10 flex items-center justify-center text-[10px] font-semibold font-mono text-brand-300">
                      {monogram(connector?.name ?? conn.erpId)}
                    </div>
                    <div>
                      <p className="text-sm text-white">{connector?.name ?? conn.erpId}</p>
                      <p className="text-[11px] text-slate-500">
                        {conn.externalAccountLabel ?? ERP_METHOD_LABELS[conn.method]}
                      </p>
                    </div>
                  </div>
                  <span
                    className={clsx(
                      'flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border',
                      STATUS_STYLES[conn.status] ?? STATUS_STYLES.pending,
                    )}
                  >
                    {conn.status === 'connected' ? <Check size={11} /> : conn.status === 'error' ? <AlertCircle size={11} /> : <Clock size={11} />}
                    {conn.status}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Search + vertical filter. */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            value={rawSearch}
            onChange={(e) => setRawSearch(e.target.value)}
            placeholder="Search ServiceTitan, RFMS, Procore, QuickBooks…"
            className="w-full pl-9 pr-3 py-2 bg-surface-900 border border-slate-700 rounded-lg text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-brand-500/50"
          />
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <FilterChip active={vertical === 'all'} onClick={() => setVertical('all')}>All</FilterChip>
          {ERP_VERTICALS.map((v) => (
            <FilterChip key={v.id} active={vertical === v.id} onClick={() => setVertical(v.id)}>
              {v.label}
            </FilterChip>
          ))}
        </div>
      </div>

      {/* Body states. */}
      {isLoading ? (
        <div className="card p-6 flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 text-brand-400 animate-spin" />
        </div>
      ) : error ? (
        <div className="card p-6 flex flex-col items-center gap-3 py-12 text-center">
          <AlertCircle size={22} className="text-danger-fg" />
          <p className="text-sm text-slate-400">Couldn’t load the connector catalog.</p>
          <button
            onClick={() => void refetch()}
            className="flex items-center gap-1.5 text-xs text-brand-400 hover:text-brand-300"
          >
            <RefreshCw size={13} /> Try again
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="card p-6 py-12 text-center space-y-2">
          <p className="text-sm text-slate-400">No systems match “{rawSearch}”.</p>
          <p className="text-xs text-slate-500">
            Don’t see yours? Clear the search and pick “My system isn’t listed” to request it.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {groups.map((g) => (
            <div key={g.vertical} className="space-y-2.5">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">{g.label}</p>
                <p className="text-[11px] text-slate-600">{g.blurb}</p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {g.connectors.map((c) => (
                  <ConnectorCard
                    key={c.id}
                    connector={c}
                    connection={connByErp.get(c.id)}
                    busy={busyId === c.id}
                    requesting={requestFor === c.id}
                    requestName={requestName}
                    onRequestNameChange={setRequestName}
                    onStartRequest={() => { setRequestFor(c.id); setRequestName(''); }}
                    onCancelRequest={() => { setRequestFor(null); setRequestName(''); }}
                    onConnect={() => void doConnect(c)}
                    onSubmitRequest={() => void doConnect(c, requestName.trim())}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Prominent skip / do-this-later. */}
      <div className="flex items-center justify-between gap-3 pt-1">
        <p className="text-[11px] text-slate-600 flex items-center gap-1.5">
          <Sparkles size={12} className="text-ai-fg" />
          You can connect or change systems any time under Integrations.
        </p>
        <button
          onClick={() => (onSkip ? onSkip() : router.push('/dashboard'))}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm text-slate-300 hover:text-white hover:bg-slate-800/50 transition-colors"
        >
          <SkipForward size={14} /> {embedded ? 'Skip for now' : 'Do this later'}
        </button>
      </div>
    </div>
  );
}

function FilterChip({
  active, onClick, children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'px-2.5 py-1 rounded-lg text-xs border transition-colors',
        active
          ? 'bg-brand-500/10 border-brand-500/30 text-brand-300'
          : 'bg-surface-900 border-slate-700 text-slate-500 hover:text-slate-300',
      )}
    >
      {children}
    </button>
  );
}

function ConnectorCard({
  connector, connection, busy, requesting, requestName,
  onRequestNameChange, onStartRequest, onCancelRequest, onConnect, onSubmitRequest,
}: {
  connector: ErpConnector;
  connection?: ErpConnection;
  busy: boolean;
  requesting: boolean;
  requestName: string;
  onRequestNameChange: (v: string) => void;
  onStartRequest: () => void;
  onCancelRequest: () => void;
  onConnect: () => void;
  onSubmitRequest: () => void;
}) {
  const isRequest = connector.status === 'REQUEST';
  const isCsv = connector.connectionMethod === 'CSV';
  const isManual = connector.connectionMethod === 'MANUAL' && !isRequest;
  const available = connector.status === 'AVAILABLE';

  return (
    <div className="card p-4 flex flex-col gap-3 h-full">
      <div className="flex items-start gap-3">
        <div className="h-9 w-9 shrink-0 rounded-lg bg-surface-950 border border-slate-800 flex items-center justify-center text-[11px] font-semibold font-mono text-slate-300">
          {monogram(connector.name)}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-white leading-tight">{connector.name}</p>
          {connector.description && (
            <p className="text-[11px] text-slate-500 mt-0.5 leading-snug">{connector.description}</p>
          )}
        </div>
        {connection && (
          <span
            className={clsx(
              'flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full border shrink-0',
              STATUS_STYLES[connection.status] ?? STATUS_STYLES.pending,
            )}
          >
            {connection.status === 'connected' ? <Check size={10} /> : <Clock size={10} />}
            {connection.status}
          </span>
        )}
      </div>

      {/* Method + data types. */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-950 border border-slate-800 text-slate-400">
          {ERP_METHOD_LABELS[connector.connectionMethod]}
        </span>
        {available && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-brand-500/10 border border-brand-500/25 text-brand-300">
            Available now
          </span>
        )}
        {connector.status === 'PLANNED' && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-400">
            Planned
          </span>
        )}
      </div>

      {connector.dataTypes.length > 0 && (
        <div className="flex items-center gap-1 flex-wrap">
          {connector.dataTypes.map((d) => (
            <span key={d} className="text-[10px] text-slate-500">
              {ERP_DATA_TYPE_LABELS[d]}
            </span>
          )).reduce<React.ReactNode[]>((acc, el, i) => {
            if (i > 0) acc.push(<span key={`dot-${i}`} className="text-slate-700 text-[10px]">·</span>);
            acc.push(el);
            return acc;
          }, [])}
        </div>
      )}

      {/* Action. */}
      <div className="mt-auto pt-1">
        {requesting ? (
          <div className="space-y-2">
            <input
              value={requestName}
              onChange={(e) => onRequestNameChange(e.target.value)}
              autoFocus
              placeholder="Which system do you use?"
              className="w-full px-2.5 py-1.5 bg-surface-900 border border-slate-700 rounded-lg text-xs text-white placeholder:text-slate-600 focus:outline-none focus:border-brand-500/50"
            />
            <div className="flex items-center gap-2">
              <button
                onClick={onSubmitRequest}
                disabled={busy || requestName.trim().length === 0}
                className={clsx(
                  'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
                  busy || requestName.trim().length === 0
                    ? 'bg-slate-700 text-slate-500 cursor-not-allowed'
                    : 'bg-brand-500 text-slate-900 hover:bg-brand-400',
                )}
              >
                {busy ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />} Send request
              </button>
              <button onClick={onCancelRequest} className="text-[11px] text-slate-500 hover:text-slate-300">
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={isRequest ? onStartRequest : onConnect}
            disabled={busy}
            className={clsx(
              'w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
              busy
                ? 'bg-slate-700 text-slate-500 cursor-not-allowed'
                : available || isRequest
                  ? 'bg-brand-500 text-slate-900 hover:bg-brand-400'
                  : 'bg-surface-950 border border-slate-700 text-slate-200 hover:border-brand-500/40 hover:text-white',
            )}
          >
            {busy ? (
              <Loader2 size={12} className="animate-spin" />
            ) : isRequest ? (
              <><Send size={12} /> Request a connector</>
            ) : isCsv ? (
              <><Upload size={12} /> Import by file</>
            ) : isManual ? (
              <><PencilLine size={12} /> Enter manually</>
            ) : (
              <><Plug size={12} /> Connect <ArrowRight size={11} /></>
            )}
          </button>
        )}
      </div>
    </div>
  );
}
