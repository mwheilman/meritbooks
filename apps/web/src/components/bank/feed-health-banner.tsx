'use client';

import { useState } from 'react';
import { Button, InlineNotice, Tag } from '@meritbooks/merit-ui';
import { useQuery, addToast } from '@/hooks';
import { api } from '@/lib/api-client';

interface FeedItem {
  id: string;
  institutionName: string | null;
  status: string;
  problem: string | null;
  lastSyncedAt: string | null;
}

interface BankFeedHealth {
  plaid: { label: string; isLive: boolean; configured: boolean; warning: string | null };
  verdict: 'not_connected' | 'healthy' | 'stale' | 'attention';
  lastSyncedAt: string | null;
  hoursSinceSync: number | null;
  items: FeedItem[];
  message: string;
}

/**
 * Bank-feed freshness (FPB-payments-fees §17.5, audit BF-02/BF-03): Plaid environment
 * (Sandbox shows a TEST tag), last successful sync, and a warning when the feed is stale
 * (no sync in 48 h) or a bank connection needs attention. Kit classes only — it renders
 * inside bridged (legacy) pages too. Scoped to the active company automatically.
 */
export function FeedHealthBanner() {
  const { data, error, isLoading, refetch } = useQuery<BankFeedHealth>('/api/integrations/plaid/health');
  const [syncing, setSyncing] = useState(false);

  if (isLoading || error || !data || data.verdict === 'not_connected') return null;

  async function syncNow() {
    setSyncing(true);
    const res = await api.post<{ ok: boolean; summary?: { transactionsAdded: number } }>('/api/integrations/plaid/sync', {});
    setSyncing(false);
    if (res.error) {
      addToast('error', res.status === 403 ? 'You do not have permission to sync the bank feed.' : res.error.error || 'Sync failed.');
      return;
    }
    const added = res.data?.summary?.transactionsAdded ?? 0;
    addToast('success', `Synced · ${added} new transaction${added === 1 ? '' : 's'}`);
    await refetch();
  }

  const envTag = data.plaid.isLive ? null : <Tag tone="warn" title={data.plaid.warning ?? undefined}>TEST</Tag>;
  const problems = data.items.filter((i) => i.problem);

  if (data.verdict === 'healthy') {
    return (
      <p className="t-cap row" role="status" style={{ margin: '0 0 12px' }}>
        {envTag}
        <span>{data.message} Plaid {data.plaid.label}.</span>
      </p>
    );
  }

  return (
    <div style={{ margin: '0 0 16px' }}>
      <InlineNotice tone={data.verdict === 'attention' ? 'neg' : 'warn'} title={data.message}>
        {problems.length > 0 && (
          <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>
            {problems.map((p) => (
              <li key={p.id}>{p.institutionName ?? 'Bank'}: {p.problem}</li>
            ))}
          </ul>
        )}
        <span className="row" style={{ marginTop: 8 }}>
          {envTag}
          <span className="t-cap">Plaid {data.plaid.label}</span>
          <Button variant="quiet" onClick={() => void syncNow()} disabled={syncing}>
            {syncing ? 'Syncing…' : 'Sync now'}
          </Button>
        </span>
      </InlineNotice>
    </div>
  );
}
