'use client';

import { useEffect, useMemo, useState, type MutableRefObject } from 'react';
import { Button, ButtonLink, Check, InlineNotice, Input, PageHead, Select, Switch, Tag, WidgetState, count, toast } from '@meritbooks/merit-ui';
import type { CompanyBrief } from '@/lib/onboarding/types';
import type { CrewPerson, RoleChip } from '@/lib/imports/crew';
import { getJson, postJson } from '@/components/imports/api';
import '@/components/imports/imports.css';

interface CrewResponse {
  chips: RoleChip[];
  people: CrewPerson[];
  invites: { id: string; name: string; email: string | null; role_key: string; status: string }[];
}

interface Row extends CrewPerson { include: boolean }

/** The chip a row shows: its own title when the pack has it, else the role's first title. */
function chipValue(chips: RoleChip[], r: Row): string {
  if (!r.roleKey) return '';
  const c = chips.find((x) => x.roleKey === r.roleKey && x.title === r.title) ?? chips.find((x) => x.roleKey === r.roleKey);
  return c ? `${c.roleKey}:${c.title}` : '';
}

/**
 * Step 8 — "Bring your crew": people pre-filled from the imported employees and Books' team, a role
 * chip from the pack's own titles for each (Technician, Superintendent, Service writer…), and the
 * Projects-only switch (on for field roles: they get Projects, nothing in Books). Invites are
 * recorded here and applied the moment the person's seat exists; Books sends the sign-in invite.
 */
export function CrewStep({ company, booksTeamUrl, busy, error, onFinish, onBack, primaryRef }: {
  company: CompanyBrief;
  booksTeamUrl: string;
  busy: boolean;
  error: string | null;
  onFinish: () => void;
  onBack: () => void;
  primaryRef: MutableRefObject<(() => void) | null>;
}) {
  const [data, setData] = useState<CrewResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<{ accepted: number; pending: number } | null>(null);
  useEffect(() => { primaryRef.current = () => { if (!busy) onFinish(); }; });

  useEffect(() => {
    let live = true;
    void (async () => {
      const r = await getJson<CrewResponse>(`/api/onboarding/crew?companyId=${company.id}`);
      if (!live) return;
      if (!r.ok) { setLoadError(r.code === 'FORBIDDEN' ? 'Inviting the crew needs the team permission. An owner can do this step later from Settings → Team.' : r.error); return; }
      setData(r.data);
      const invited = new Set(r.data.invites.map((i) => (i.email ?? '').toLowerCase()));
      setRows(r.data.people.map((p) => ({ ...p, include: Boolean(p.roleKey) && !invited.has((p.email ?? '').toLowerCase()) && Boolean(p.email || p.phone) })));
    })();
    return () => { live = false; };
  }, [company.id]);

  const chipFor = useMemo(() => new Map((data?.chips ?? []).map((c) => [`${c.roleKey}:${c.title}`, c])), [data]);
  const set = (key: string, p: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)));
  const add = () => setRows((rs) => [...rs, { key: `manual:${rs.length}:${Date.now()}`, name: '', email: null, phone: null, title: null, roleKey: data?.chips.find((c) => c.roleKey === 'projects_labor')?.roleKey ?? null, projectsOnly: true, source: 'manual', importRowId: null, employeeId: null, include: true }]);
  const chosen = rows.filter((r) => r.include && r.roleKey && r.name.trim() && (r.email || r.phone));

  const send = async () => {
    if (chosen.length === 0) return;
    setSending(true);
    const r = await postJson<{ accepted: number; pending: number }>('/api/onboarding/crew', {
      companyId: company.id,
      people: chosen.map((p) => ({ name: p.name.trim(), email: p.email?.trim() || null, phone: p.phone?.trim() || null, title: p.title, roleKey: p.roleKey, projectsOnly: p.projectsOnly, source: p.source, importRowId: p.importRowId, employeeId: p.employeeId })),
    });
    setSending(false);
    if (!r.ok) { toast(r.error, { tone: 'neg' }); return; }
    setSent(r.data);
    setRows((rs) => rs.map((x) => (chosen.some((c) => c.key === x.key) ? { ...x, include: false } : x)));
    toast(`${count(r.data.accepted + r.data.pending)} ${r.data.accepted + r.data.pending === 1 ? 'person' : 'people'} set up · ${count(r.data.accepted)} already in the workspace`);
  };

  return (
    <>
      <PageHead eyebrow={['Set up', company.name, 'Optional']} title="Bring your crew">
        <p className="ob-lede">Each person lands on their own home: techs and crews on Today, office staff on the inbox. Field roles get Projects only.</p>
      </PageHead>

      {loadError ? <InlineNotice tone="warn" title={loadError} /> : !data ? (
        <div className="ob-skel" aria-busy="true"><span className="t-cap">Loading your people…</span></div>
      ) : (
        <section className="ob-card imp-crew" aria-labelledby="crew-h">
          <div className="ob-card-h">
            <h3 id="crew-h">People</h3>
            <span className="t-cap tnum">{count(rows.length)}</span>
            <span className="sp" />
            <Button variant="quiet" icon="plus" onClick={add}>Add someone</Button>
          </div>
          {rows.length === 0 ? (
            <WidgetState state={{ kind: 'empty', title: 'No one to invite yet', body: 'Bring in an employee list from your old system, add people in Merit Books under Team, or add someone here.' }} />
          ) : (
            <div className="ob-tbl">
              <table className="tbl tbl-q tbl-q--flush tbl-q--compact" aria-label="Crew to invite">
                <thead><tr><th style={{ width: 40 }} /><th>Name</th><th>Email</th><th>Mobile</th><th>Role</th><th>Projects only</th><th>From</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.key}>
                      <td><Check aria-label={`Invite ${r.name || 'this person'}`} checked={r.include} onChange={(e) => set(r.key, { include: e.currentTarget.checked })} /></td>
                      <td><Input aria-label="Name" value={r.name} onChange={(e) => set(r.key, { name: e.currentTarget.value })} /></td>
                      <td><Input aria-label="Email" type="email" value={r.email ?? ''} onChange={(e) => set(r.key, { email: e.currentTarget.value || null })} /></td>
                      <td><Input aria-label="Mobile" type="tel" value={r.phone ?? ''} onChange={(e) => set(r.key, { phone: e.currentTarget.value || null })} /></td>
                      <td>
                        <Select aria-label="Role" value={chipValue(data.chips, r)}
                          onChange={(e) => { const c = chipFor.get(e.currentTarget.value); set(r.key, { roleKey: c?.roleKey ?? null, title: c?.title ?? r.title, projectsOnly: c?.projectsOnly ?? r.projectsOnly }); }}>
                          <option value="">Pick a role</option>
                          {data.chips.map((c) => <option key={`${c.roleKey}:${c.title}`} value={`${c.roleKey}:${c.title}`}>{c.title}</option>)}
                        </Select>
                      </td>
                      <td><Switch aria-label="Projects only" checked={r.projectsOnly} onChange={(e) => set(r.key, { projectsOnly: e.currentTarget.checked })} /></td>
                      <td>{r.source === 'import' ? <Tag>Import</Tag> : r.source === 'books_team' ? <Tag>Books</Tag> : <Tag>Added</Tag>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="ob-card-f">
            <span>{sent ? `${count(sent.accepted)} have their role now; ${count(sent.pending)} get it the moment they sign in.` : 'Already in the workspace? They get the role right away.'}</span>
            <span className="sp" />
            <ButtonLink variant="quiet" href={booksTeamUrl} target="_blank" rel="noreferrer" iconAfter="right">Send sign-in invites from Books</ButtonLink>
            <Button variant="primary" disabled={sending || chosen.length === 0} onClick={send}>{sending ? 'Setting up…' : `Set up ${count(chosen.length)} ${chosen.length === 1 ? 'person' : 'people'}`}</Button>
          </div>
        </section>
      )}
      {error && <div style={{ marginTop: 16 }}><InlineNotice tone="neg" title={error} /></div>}

      <div className="ob-foot">
        <Button variant="quiet" chord="escape" onClick={onBack}>Back</Button>
        <span className="sp" />
        <Button variant="primary" size="lg" chord="enter" disabled={busy} onClick={onFinish}>Continue</Button>
      </div>
    </>
  );
}
