'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button, InlineNotice, Status, Tabs, WidgetState, toast } from '@meritbooks/merit-ui';

interface GrantRow { id: string; audience: string; display_name: string; role: string; can_sign: boolean; can_pay: boolean; all_jobs: boolean; status: string; accepted_at: string | null; last_seen_at: string | null; job_ids: string[] }
interface RequestRow { id: string; job_id: string | null; kind: 'warranty' | 'service'; title: string; description: string | null; preferred_window: string | null; document_ids: string[]; status: string; created_at: string }

const AUD: Record<string, string> = { customer: 'Customers', vendor: 'Subs and vendors', lender: 'Lenders', investor: 'Investors' };
const NEXT: Record<string, { to: string; label: string }[]> = {
  new: [{ to: 'acknowledged', label: 'Acknowledge' }, { to: 'closed', label: 'Close' }],
  acknowledged: [{ to: 'scheduled', label: 'Mark scheduled' }, { to: 'closed', label: 'Close' }],
  scheduled: [{ to: 'closed', label: 'Close' }],
};

/** Staff home for the portals: requests customers sent, and who has access (by audience). */
export function PortalStaffView({ companyId }: { companyId: string | null }) {
  const [tab, setTab] = useState<'requests' | 'access'>('requests');
  const [requests, setRequests] = useState<RequestRow[] | null>(null);
  const [grants, setGrants] = useState<GrantRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const qs = companyId ? `?companyId=${companyId}` : '';
  const load = useCallback(async () => {
    try {
      const [a, b] = await Promise.all([fetch(`/api/portal/staff/requests${qs}`), fetch(`/api/portal/staff/grants${qs}`)]);
      const ra = (await a.json()) as { requests?: RequestRow[]; error?: string };
      const rb = (await b.json()) as { grants?: GrantRow[]; error?: string };
      if (!a.ok || !b.ok) { setError(ra.error ?? rb.error ?? 'That did not load.'); return; }
      setRequests(ra.requests ?? []);
      setGrants((rb.grants ?? []).filter((g) => g.status === 'active'));
    } catch {
      setError('No connection. Try again.');
    }
  }, [qs]);
  useEffect(() => { void load(); }, [load]);

  const move = async (id: string, status: string) => {
    const res = await fetch('/api/portal/staff/requests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, status }) });
    if (!res.ok) { toast.error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'That did not go through.'); return; }
    toast('Updated.');
    void load();
  };

  if (error) return <InlineNotice tone="neg" title={error}><Button onClick={() => { setError(null); void load(); }}>Try again</Button></InlineNotice>;
  if (!requests || !grants) return <WidgetState state={{ kind: 'loading', label: 'Loading the portals…', lines: 5 }} />;
  const open = requests.filter((r) => r.status !== 'closed' && r.status !== 'converted');
  return (
    <div>
      <Tabs aria-label="Portals" items={[{ value: 'requests', label: 'Requests', count: open.length }, { value: 'access', label: 'Who has access', count: grants.length }]} value={tab} onChange={setTab} />
      {tab === 'requests' ? (
        open.length === 0 ? <p className="t-cap" style={{ marginTop: 16 }}>No open portal requests. Warranty and service requests customers send from the portal land here.</p> : (
          <table className="tbl" style={{ marginTop: 16 }}>
            <thead><tr><th>Request</th><th>Kind</th><th>Window</th><th>Received</th><th>Status</th><th /></tr></thead>
            <tbody>
              {open.map((r) => (
                <tr key={r.id}>
                  <td>{r.job_id ? <a className="link" href={`/jobs/${r.job_id}`}>{r.title}</a> : r.title}{r.description ? <div className="t-cap">{r.description}</div> : null}{r.document_ids.length ? <div className="t-cap">{r.document_ids.length} photo(s) on the job</div> : null}</td>
                  <td>{r.kind === 'warranty' ? 'Warranty' : 'Service'}</td>
                  <td>{r.preferred_window ?? ''}</td>
                  <td>{new Date(r.created_at).toLocaleDateString()}</td>
                  <td><Status kind={r.status === 'new' ? 'risk' : 'track'} pip="open">{r.status}</Status></td>
                  <td><div className="btn-row">{(NEXT[r.status] ?? []).map((n) => <Button key={n.to} variant="quiet" onClick={() => void move(r.id, n.to)}>{n.label}</Button>)}</div></td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      ) : grants.length === 0 ? <p className="t-cap" style={{ marginTop: 16 }}>Nobody has portal access yet. Use “Invite to portal” on a job, customer or vendor.</p> : (
        Object.keys(AUD).filter((a) => grants.some((g) => g.audience === a)).map((a) => (
          <section key={a} style={{ marginTop: 16 }}>
            <h3 className="t-section">{AUD[a]}</h3>
            <table className="tbl">
              <thead><tr><th>Person</th><th>Rights</th><th>Jobs</th><th>Status</th></tr></thead>
              <tbody>
                {grants.filter((g) => g.audience === a).map((g) => (
                  <tr key={g.id}>
                    <td>{g.display_name}</td>
                    <td>{g.role === 'approver' ? 'Approves' : 'Views'}{g.can_sign ? ' · signs' : ''}{g.can_pay ? ' · pays' : ''}</td>
                    <td className="n">{g.all_jobs ? 'All' : g.job_ids.length}</td>
                    <td><Status kind={g.accepted_at ? 'ready' : 'track'} pip={g.accepted_at ? 'closed' : 'open'}>{g.accepted_at ? 'Active' : 'Invited'}</Status></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))
      )}
    </div>
  );
}
