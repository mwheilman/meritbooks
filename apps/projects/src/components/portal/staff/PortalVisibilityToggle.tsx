'use client';

import { useEffect, useState } from 'react';
import { Switch, api, toast } from '@meritbooks/merit-ui';

/**
 * "Show on portal" for one schedule task or daily-log entry (1118 client_visible). Reads its own
 * state; the switch writes through POST /api/portal/staff/visibility (projects.jobs:edit).
 */
export function PortalVisibilityToggle({ table, id, canEdit, label = 'Show on the customer portal' }: { table: 'tasks' | 'field_logs'; id: string; canEdit: boolean; label?: string }) {
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    setOn(null);
    void api.get<{ visible: Record<string, boolean> }>('/api/portal/staff/visibility', { table, ids: id }).then((r) => {
      if (live) setOn(r.data ? r.data.visible[id] === true : null);
    });
    return () => { live = false; };
  }, [table, id]);
  if (on === null && !canEdit) return null;
  return (
    <Switch
      checked={on === true}
      disabled={!canEdit || busy || on === null}
      onChange={async (e) => {
        const next = e.target.checked;
        setBusy(true);
        const r = await api.post<{ visible: boolean }>('/api/portal/staff/visibility', { table, id, visible: next });
        setBusy(false);
        if (r.error) return void toast.error(r.error.error);
        setOn(r.data?.visible ?? next);
        toast(next ? 'Shown on the customer portal' : 'Hidden from the customer portal');
      }}
      label={label}
    />
  );
}

/** Portal visibility for many rows at once (one GET), for lists like a job's daily logs. */
export function usePortalVisibility(table: 'tasks' | 'field_logs', ids: ReadonlyArray<string>, enabled = true) {
  const key = ids.slice(0, 200).join(',');
  const [map, setMap] = useState<Record<string, boolean> | null>(null);
  useEffect(() => {
    if (!enabled || !key) { setMap(null); return; }
    let live = true;
    void api.get<{ visible: Record<string, boolean> }>('/api/portal/staff/visibility', { table, ids: key }).then((r) => {
      if (live) setMap(r.data ? r.data.visible : null);
    });
    return () => { live = false; };
  }, [table, key, enabled]);
  const set = async (id: string, visible: boolean): Promise<void> => {
    const r = await api.post<{ visible: boolean }>('/api/portal/staff/visibility', { table, id, visible });
    if (r.error) return void toast.error(r.error.error);
    setMap((m) => ({ ...(m ?? {}), [id]: r.data?.visible ?? visible }));
    toast(visible ? 'Shown on the customer portal' : 'Hidden from the customer portal');
  };
  return { map, set };
}
