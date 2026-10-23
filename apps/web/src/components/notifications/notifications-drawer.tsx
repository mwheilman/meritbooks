'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Drawer, Field, InlineNotice, PanelSection, Pip, Select, type PipKind } from '@meritbooks/merit-ui';
import type { NotificationItem, UseNotifications } from './use-notifications';

const SEVERITY_PIP: Record<NotificationItem['severity'], PipKind> = { info: 'track', attention: 'risk', critical: 'overdue' };
const SEVERITY_WORD: Record<NotificationItem['severity'], string> = { info: 'Update', attention: 'Needs you', critical: 'Urgent' };

function ago(iso: string): string {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

type Digest = 'instant' | 'daily' | 'weekly' | 'off';

/**
 * The notification panel (opened from the rail — kit rule: no bell in the bar). Unread
 * first; each row says what happened in a line, how long ago, and goes where you act on
 * it. Mark one or all read; choose how email copies arrive (preference saved per member;
 * the daily / weekly digest sender is the next scheduler job, notifications.digest).
 */
export function NotificationsDrawer({ open, onClose, n }: { open: boolean; onClose: () => void; n: UseNotifications }) {
  const router = useRouter();
  const [digest, setDigest] = useState<Digest | null>(null);
  const [savingDigest, setSavingDigest] = useState(false);

  useEffect(() => {
    if (!open || digest !== null) return;
    void fetch('/api/notifications/prefs')
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { prefs?: { digest?: Digest } } | null) => setDigest(b?.prefs?.digest ?? 'instant'))
      .catch(() => setDigest('instant'));
  }, [open, digest]);

  const unread = n.items.filter((i) => !i.read_at);
  const read = n.items.filter((i) => i.read_at);

  function go(item: NotificationItem) {
    if (!item.read_at) void n.markRead([item.id]);
    if (item.deep_link && item.deep_link.startsWith('/') && !item.deep_link.startsWith('//')) {
      onClose();
      router.push(item.deep_link);
    }
  }

  async function saveDigest(v: Digest) {
    setDigest(v);
    setSavingDigest(true);
    await fetch('/api/notifications/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ digest: v }) }).catch(() => undefined);
    setSavingDigest(false);
  }

  const row = (item: NotificationItem) => (
    <li key={item.id} style={{ borderBottom: '1px solid var(--line)' }}>
      <button
        type="button"
        onClick={() => go(item)}
        style={{ display: 'grid', gridTemplateColumns: '16px minmax(0,1fr)', gap: 10, width: '100%', textAlign: 'left', padding: '10px 0', background: 'none', border: 0, cursor: item.deep_link ? 'pointer' : 'default' }}
        aria-label={`${SEVERITY_WORD[item.severity]}: ${item.title}${item.read_at ? '' : ' (unread)'}`}
      >
        <span style={{ paddingTop: 4 }}>
          <Pip kind={item.read_at ? 'closed' : SEVERITY_PIP[item.severity]} />
        </span>
        <span>
          <span className="l1" style={{ display: 'block', fontWeight: item.read_at ? 400 : 600 }}>
            {item.title}
          </span>
          {item.body && (
            <span className="ink-2" style={{ display: 'block' }}>
              {item.body}
            </span>
          )}
          <span className="t-cap">
            {SEVERITY_WORD[item.severity]} · {ago(item.created_at)}
          </span>
        </span>
      </button>
    </li>
  );

  return (
    <Drawer
      open={open}
      onClose={onClose}
      eyebrow={['Notifications', n.unread > 0 ? `${n.unread} unread` : 'All read']}
      title="Notifications"
      foot={
        <div className="row row--between" style={{ width: '100%', alignItems: 'flex-end', gap: 12 }}>
          <Field label="Email me a copy">
            <Select value={digest ?? 'instant'} disabled={digest === null || savingDigest} onChange={(e) => void saveDigest(e.target.value as Digest)}>
              <option value="instant">Right away</option>
              <option value="daily">Daily summary</option>
              <option value="weekly">Weekly summary</option>
              <option value="off">Never (in-app only)</option>
            </Select>
          </Field>
          <Button onClick={() => void n.markRead('all')} disabled={n.unread === 0}>
            Mark all read
          </Button>
        </div>
      }
    >
      {n.error && n.items.length === 0 ? (
        <PanelSection>
          <InlineNotice tone="neg" title={n.error}>
            <Button variant="quiet" onClick={() => void n.refresh()}>
              Try again
            </Button>
          </InlineNotice>
        </PanelSection>
      ) : n.loading && n.items.length === 0 ? (
        <PanelSection>
          <p className="t-cap" role="status">
            Loading…
          </p>
        </PanelSection>
      ) : n.items.length === 0 ? (
        <PanelSection>
          <p className="t-head">You’re all caught up.</p>
          <p className="ink-2">Escalations, answered requests, bounced emails and anything else that needs you will show here.</p>
        </PanelSection>
      ) : (
        <>
          {unread.length > 0 && (
            <PanelSection title="New" meta={<span className="t-cap tnum">{unread.length}</span>}>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>{unread.map(row)}</ul>
            </PanelSection>
          )}
          {read.length > 0 && (
            <PanelSection title="Earlier">
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>{read.map(row)}</ul>
            </PanelSection>
          )}
        </>
      )}
    </Drawer>
  );
}
