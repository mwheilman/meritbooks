'use client';
/**
 * The bell (PLT-42) — A5 mounts it in the shell bar. Unread count (polled every 60 s and on
 * focus), the latest rows in a popover ("needs you" first), click → mark read + open the
 * record, "Mark all read", "Open inbox". The text is already masked per person by the database.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Popover, PopoverFoot, PopoverGroup, PopoverList, api } from '@meritbooks/merit-ui';
import type { BellPayload, InboxItem } from '@/lib/notify/types';
import { ago, hrefOf, needsYou, rankForBell } from '@/lib/notify/format';

const POLL_MS = 60_000;

function BellGlyph() {
  return (
    <svg className="ico" width={16} height={16} viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path d="M4 11.5V7a4 4 0 0 1 8 0v4.5l1 1H3l1-1Z" strokeLinejoin="round" />
      <path d="M6.5 14h3" />
    </svg>
  );
}

export interface NotificationBellProps {
  /** For tests / storybook: skip the network. */
  initial?: BellPayload | null;
  pollMs?: number;
}

export function NotificationBell({ initial = null, pollMs = POLL_MS }: NotificationBellProps) {
  const router = useRouter();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<BellPayload | null>(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await api.get<BellPayload>('/api/notifications');
    if (res.error) setError(res.error.error);
    else {
      setError(null);
      setData(res.data);
    }
  }, []);

  useEffect(() => {
    if (initial) return undefined;
    void load();
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, pollMs);
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener('focus', onFocus);
    };
  }, [initial, load, pollMs]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const mark = async (ids: string[], state: 'read' | 'read_all') => {
    setBusy(true);
    const res = await api.post<{ updated: number }>('/api/notifications/read', { ids, state });
    setBusy(false);
    if (res.error) {
      setError(res.error.error);
      return;
    }
    setData((d) => {
      if (!d) return d;
      const now = new Date().toISOString();
      const items = d.items.map((i) => (state === 'read_all' || ids.includes(i.id) ? { ...i, readAt: i.readAt ?? now } : i));
      const cleared = state === 'read_all' ? d.unread : d.items.filter((i) => ids.includes(i.id) && !i.readAt).length;
      return { unread: Math.max(0, d.unread - cleared), needsYou: state === 'read_all' ? 0 : items.filter(needsYou).length, items };
    });
  };

  const openItem = (i: InboxItem) => {
    setOpen(false);
    if (!i.readAt) void mark([i.id], 'read');
    router.push(hrefOf(i));
  };

  const unread = data?.unread ?? 0;
  const items = rankForBell(data?.items ?? []);
  const label = unread ? `Notifications, ${unread} unread` : 'Notifications';

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="btn btn--quiet btn--icon"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        style={{ position: 'relative' }}
      >
        <BellGlyph />
        {unread > 0 && (
          <span
            aria-hidden="true"
            style={{ fontVariantNumeric: 'tabular-nums',
              position: 'absolute', top: 2, right: 2, minWidth: 16, height: 16, padding: '0 4px', lineHeight: '16px', fontSize: 10, fontWeight: 700,
              background: data?.needsYou ? 'var(--neg)' : 'var(--electric)', color: '#FFFFFF', textAlign: 'center',
            }}
          >
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchor} width={400} placement="bottom-end" aria-label="Notifications">
        <PopoverList role="list" aria-busy={busy || undefined}>
          <PopoverGroup label="Notifications" meta={unread ? `${unread} unread` : 'All caught up'} />
          {error && !data ? (
            <li className="popover-item" role="alert" style={{ whiteSpace: 'normal' }}>
              <span>Notifications did not load. <button type="button" className="nlink" onClick={() => void load()}>Try again</button></span>
            </li>
          ) : !data ? (
            <li className="popover-item" role="status"><span className="t-cap">Loading notifications</span></li>
          ) : items.length === 0 ? (
            <li className="popover-item" style={{ whiteSpace: 'normal', height: 'auto', padding: '16px' }}>
              <span>
                <span className="t-head" style={{ display: 'block' }}>Nothing new</span>
                <span className="t-cap">Assignments, approvals, signatures and mentions land here.</span>
              </span>
            </li>
          ) : (
            items.map((i) => (
              <li key={i.id} role="listitem" style={{ listStyle: 'none' }}>
                <button
                  type="button"
                  className="popover-item"
                  onClick={() => openItem(i)}
                  style={{ width: '100%', height: 'auto', alignItems: 'flex-start', padding: '10px 16px', textAlign: 'left', whiteSpace: 'normal', background: i.readAt ? undefined : 'var(--sky)', border: 0 }}
                >
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span style={{ display: 'block', fontWeight: i.readAt ? 400 : 600, color: needsYou(i) ? 'var(--neg)' : undefined }}>
                      {i.title}{i.itemCount > 1 ? ` (${i.itemCount})` : ''}
                    </span>
                    {i.body && <span className="t-cap" style={{ display: 'block', marginTop: 2 }}>{i.body}</span>}
                  </span>
                  <span className="t-cap" style={{ marginLeft: 12, flex: 'none' }}>{ago(i.createdAt)}</span>
                </button>
              </li>
            ))
          )}
        </PopoverList>
        <PopoverFoot>
          <span style={{ display: 'flex', gap: 12, width: '100%', justifyContent: 'space-between' }}>
            <button type="button" className="nlink" disabled={busy || unread === 0} onClick={() => void mark([], 'read_all')}>Mark all read</button>
            <button type="button" className="nlink" onClick={() => { setOpen(false); router.push('/inbox'); }}>Open inbox</button>
          </span>
        </PopoverFoot>
      </Popover>
    </>
  );
}
