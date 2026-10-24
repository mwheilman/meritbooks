'use client';

import { useMemo, useState } from 'react';
import { Button, Drawer, InlineNotice, PanelSection, Pip, Switch, Tag, api, toast, useQuery } from '@meritbooks/merit-ui';
import { useActiveCompany } from '@/lib/hooks/use-active-company';
import { QuietHoursNote } from '@/components/requests/quiet-hours-note';
import type { ActionResponse, ChaseItem, ChaseResponse } from './vc-types';
import s from './vendor-compliance.module.css';

type Key = 'w9' | 'coi' | 'coi_renewal';
const KEYS: Array<{ key: Key; sw: 'w9' | 'coi' | 'renewal'; label: string; cadence: string }> = [
  { key: 'w9', sw: 'w9', label: 'Missing W-9', cadence: 'Day 0, 3, 7, then weekly' },
  { key: 'coi', sw: 'coi', label: 'Missing or deficient COI', cadence: 'Day 0, 3, 7, then weekly' },
  { key: 'coi_renewal', sw: 'renewal', label: 'COI renewal', cadence: 'T-30, T-15, T-0 (the set’s lead time), then weekly' },
];

const STATUS_WORD: Record<ChaseItem['status'], string> = {
  would_send: 'Would be emailed',
  no_email: 'No email address',
  already_open: 'Already being asked',
  cooling: 'Asked recently',
  switch_off: 'Switch off',
};

/**
 * Automatic W-9 / COI chase (FPB §19 A8): one switch per kind, firm-wide and per company,
 * default OFF; and the preview — exactly who would be emailed, and why not for the rest —
 * so turning it on is never a surprise.
 */
export function ChaseDrawer({ open, onClose, locationId, companyName }: { open: boolean; onClose: () => void; locationId: string | null; companyName: string | null }) {
  const { companies } = useActiveCompany();
  const [key, setKey] = useState(0);
  const { data, error, isLoading, refetch } = useQuery<ChaseResponse>(open ? '/api/vendor-compliance/chase' : null, { location_id: locationId ?? undefined }, { key: String(key), scope: false });
  const [busy, setBusy] = useState<string | null>(null);

  const flip = async (loc: string | null, k: Key, on: boolean) => {
    setBusy(`${loc ?? 'org'}:${k}`);
    const res = await api.post<ActionResponse>('/api/vendor-compliance/chase', { action: 'switch', location_id: loc, key: k, on });
    setBusy(null);
    if (res.error) {
      toast.error(res.error.error);
      return;
    }
    toast(res.data?.message ?? 'Saved.');
    setKey((x) => x + 1);
  };

  const items = data?.items ?? [];
  const would = items.filter((i) => i.status === 'would_send');
  const grouped = useMemo(() => {
    const order: ChaseItem['status'][] = ['would_send', 'no_email', 'already_open', 'cooling'];
    return order.map((st) => ({ st, rows: items.filter((i) => i.status === st) })).filter((g) => g.rows.length);
  }, [items]);
  const rows = locationId ? companies.filter((c) => c.id === locationId) : companies;

  return (
    <Drawer open={open} onClose={onClose} width={560} eyebrow={['Vendor compliance', 'Automatic chase']} title="Ask vendors automatically" meta={companyName ?? 'All companies'}>
      <PanelSection title="Switches">
        <p className="t-cap" style={{ marginBottom: 8 }}>
          Off by default. When on, the reminder run (every 15 minutes) opens one request per vendor and kind, emails the vendor portal link on the cadence, and stops when the document is accepted.{' '}
          {data ? <QuietHoursNote summary={data.quietHours} primary="vendor" /> : null}
        </p>
        {error && <InlineNotice tone="neg" title="Couldn’t load the switches.">{error}</InlineNotice>}
        {data && (
          <>
            <div className={s.switchRow}>
              <span className="t-ui">Every company (firm-wide)</span>
              {KEYS.map((k) => (
                <Switch
                  key={k.key}
                  label={k.label}
                  checked={data.switches.org[k.sw]}
                  disabled={busy !== null}
                  onChange={(e) => void flip(null, k.key, e.target.checked)}
                />
              ))}
            </div>
            {rows.map((c) => {
              const v = data.switches.byCompany[c.id] ?? {};
              return (
                <div key={c.id} className={s.switchRow}>
                  <span className="t-ui">{c.name}</span>
                  {KEYS.map((k) => (
                    <Switch
                      key={k.key}
                      label={k.label}
                      checked={v[k.sw] ?? data.switches.org[k.sw]}
                      disabled={busy !== null}
                      onChange={(e) => void flip(c.id, k.key, e.target.checked)}
                    />
                  ))}
                </div>
              );
            })}
            <p className="t-cap" style={{ marginTop: 8 }}>{KEYS.map((k) => `${k.label}: ${k.cadence}`).join(' · ')}</p>
          </>
        )}
      </PanelSection>

      <PanelSection title="Who would be emailed" meta={data ? <span className="t-cap tnum">{would.length}</span> : undefined}>
        {isLoading && !data ? (
          <p className="t-cap" role="status">Working out who owes what…</p>
        ) : items.length === 0 ? (
          <p className="ink-2">Nobody — every vendor in scope has what it needs{data && data.requirementSets === 0 ? ' (no requirement sets yet; only vendors with tracked documents are checked)' : ''}.</p>
        ) : (
          grouped.map((g) => (
            <div key={g.st} style={{ marginBottom: 12 }}>
              <h4 className="eyebrow">{STATUS_WORD[g.st]} · <span className="tnum">{g.rows.length}</span></h4>
              <ul className={s.previewList}>
                {g.rows.slice(0, 50).map((i) => (
                  <li key={`${i.vendorId}:${i.kind}:${i.renewal}`}>
                    <span className="mb-sev">
                      <Pip kind={g.st === 'would_send' ? 'open' : g.st === 'no_email' ? 'blocked' : 'closed'} />
                      <span className="t-ui">{i.vendorName}</span>
                    </span>{' '}
                    <Tag>{i.kind === 'w9' ? 'W-9' : i.renewal ? `Renewal ${i.dueDate ?? ''}` : 'COI'}</Tag>
                    {i.status === 'would_send' && i.liveStatus === 'would_send' && <Tag tone="ai">Goes out next run</Tag>}
                    <div className="t-cap">{i.why}</div>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
        <Button variant="quiet" onClick={() => void refetch()} style={{ marginTop: 8 }}>
          Refresh preview
        </Button>
      </PanelSection>
    </Drawer>
  );
}
