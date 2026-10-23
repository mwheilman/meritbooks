'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The signed-in member's in-app notifications (GET /api/notifications — RLS returns only
 * their own rows). Polls every 60 s and on window focus, like the rail's inbox count.
 * Fails quiet: on error the rail shows no count, the panel shows its error state.
 */
const POLL_MS = 60_000;

export interface NotificationItem {
  id: string;
  kind: string;
  severity: 'info' | 'attention' | 'critical';
  title: string;
  body: string | null;
  deep_link: string | null;
  request_id: string | null;
  read_at: string | null;
  created_at: string;
}

interface Payload {
  items: NotificationItem[];
  unread: number;
  attention: number;
}

export interface UseNotifications {
  items: NotificationItem[];
  unread: number;
  /** Unread attention / critical (escalations, bounces) → brick count. */
  attention: number;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  markRead: (ids: string[] | 'all') => Promise<void>;
}

export function useNotifications(enabled: boolean): UseNotifications {
  const [state, setState] = useState<Payload>({ items: [], unread: 0, attention: 0 });
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      const res = await fetch('/api/notifications?limit=30', { headers: { Accept: 'application/json' } });
      if (!res.ok) {
        if (alive.current) setError(res.status === 401 ? 'Signed out.' : 'Couldn’t load notifications.');
        return;
      }
      const body = (await res.json()) as Payload;
      if (!alive.current) return;
      setState({ items: body.items ?? [], unread: body.unread ?? 0, attention: body.attention ?? 0 });
      setError(null);
    } catch {
      if (alive.current) setError('Couldn’t load notifications.');
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    alive.current = true;
    if (!enabled) return;
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      alive.current = false;
      clearInterval(t);
      window.removeEventListener('focus', onFocus);
    };
  }, [enabled, refresh]);

  const markRead = useCallback(
    async (ids: string[] | 'all') => {
      const now = new Date().toISOString();
      // optimistic
      setState((s) => {
        const hit = (n: NotificationItem) => ids === 'all' || ids.includes(n.id);
        const items = s.items.map((n) => (hit(n) && !n.read_at ? { ...n, read_at: now } : n));
        const cleared = s.items.filter((n) => hit(n) && !n.read_at);
        return {
          items,
          unread: ids === 'all' ? 0 : Math.max(0, s.unread - cleared.length),
          attention: ids === 'all' ? 0 : Math.max(0, s.attention - cleared.filter((n) => n.severity !== 'info').length),
        };
      });
      try {
        await fetch('/api/notifications', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(ids === 'all' ? { all: true } : { ids }),
        });
      } finally {
        void refresh();
      }
    },
    [refresh],
  );

  return { ...state, loading, error, refresh, markRead };
}
