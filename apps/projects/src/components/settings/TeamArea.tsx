'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Button, ButtonLink, ConfirmDialog, Field, InlineNotice, QueueTable, Select, Switch, Tag, WidgetState, api, count, toast,
  type QueueColumn, type QueueGroup,
} from '@meritbooks/merit-ui';
import type { PersonaKey } from '@/lib/access/types';

export interface TeamRow {
  membershipId: string;
  name: string | null;
  email: string | null;
  booksRole: string;
  status: string;
  isMe: boolean;
  /** Projects role titles at this company ("Project manager", "Technician"). */
  titles: string[];
  /** Owner / admin seat: always keeps Merit Books. */
  isAdminSeat: boolean;
  /** Projects-only seat (no Merit Books data); null when the flag can't be read yet. */
  projectsOnly: boolean | null;
}

export interface TeamAreaProps {
  companyName: string;
  rows: TeamRow[];
  error: string | null;
  /** Owners only (REAL projects.settings:configure): the "Preview as" picker. */
  preview: { personas: Array<{ key: PersonaKey; label: string }>; current: PersonaKey | null } | null;
  booksTeamUrl: string;
  /** Owners only: may flip a seat to "Projects only" (pm.set_projects_only checks the rest). */
  canSetProjectsOnly: boolean;
}

const BOOKS_ROLE: Readonly<Record<string, string>> = { owner: 'Owner', company_admin: 'Company admin', admin: 'Admin' };
const booksRole = (r: string) => BOOKS_ROLE[r] ?? r.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** Settings → Team (spec §5): each company's people and their Projects role, plus "Preview as". */
/** Why the switch is off-limits for this seat, or null when it can be changed. */
function lockedReason(r: TeamRow): string | null {
  if (r.isMe) return 'You can’t change your own seat.';
  if (r.isAdminSeat) return 'Owners and admins always keep Merit Books.';
  return null;
}

export function TeamArea({ companyName, rows, error, preview, booksTeamUrl, canSetProjectsOnly }: TeamAreaProps) {
  const router = useRouter();
  const [confirming, setConfirming] = useState<TeamRow | null>(null);
  const [flipping, setFlipping] = useState<string | null>(null);
  const flagReadable = rows.some((r) => r.projectsOnly != null);
  const showSwitch = canSetProjectsOnly && flagReadable;

  const setProjectsOnly = async (r: TeamRow, on: boolean) => {
    setFlipping(r.membershipId);
    const res = await api.post<{ ok: true }>(`/api/team/members/${r.membershipId}/projects-only`, { on });
    setFlipping(null);
    const who = r.name ?? r.email ?? 'This person';
    if (res.error) {
      toast.error(res.error.error);
      throw new Error(res.error.error);
    }
    toast(on ? `Made ${who} Projects only` : `Gave ${who} back their Merit Books access`);
    setConfirming(null);
    router.refresh();
  };
  const [persona, setPersona] = useState<PersonaKey | ''>(preview?.current ?? '');
  const [busy, setBusy] = useState(false);

  const startPreview = async () => {
    if (!persona) return;
    setBusy(true);
    const res = await api.post<{ ok: true }>('/api/access/preview', { persona });
    setBusy(false);
    if (res.error) {
      toast.error(res.error.error);
      return;
    }
    const label = preview?.personas.find((p) => p.key === persona)?.label ?? 'that role';
    toast(`Previewing as ${label}`);
    router.push('/');
    router.refresh();
  };

  const columns: QueueColumn<TeamRow>[] = [
    {
      id: 'who',
      header: 'Person',
      cell: (r) => (
        <span style={{ display: 'block', minWidth: 0 }}>
          <span className="l1">
            {r.name ?? r.email ?? 'Team member'}
            {r.isMe ? <> <Tag>You</Tag></> : null}
            {r.projectsOnly ? <> <Tag tone="solid">Projects only</Tag></> : null}
          </span>
          <span className="l2">{r.name && r.email ? r.email : r.status === 'invited' ? 'Invited, not signed in yet' : 'Name shows once they join a job team'}</span>
        </span>
      ),
    },
    {
      id: 'role',
      header: 'Projects role',
      width: 240,
      cell: (r) => (r.titles.length ? <span className="row" style={{ gap: 4, flexWrap: 'wrap' }}>{r.titles.map((t) => <Tag key={t}>{t}</Tag>)}</span> : <span className="ink-3">None here</span>),
    },
    {
      id: 'books',
      header: 'Merit Books role',
      width: 160,
      cell: (r) => (r.projectsOnly ? <span className="ink-3">No Books access</span> : booksRole(r.booksRole)),
    },
    ...(showSwitch
      ? [{
          id: 'po',
          header: 'Projects only',
          width: 200,
          cell: (r: TeamRow) => {
            const why = lockedReason(r);
            return (
              // The row opens Merit Books on click; the switch must not.
              <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} style={{ display: 'block' }}>
                <Switch
                  label={r.projectsOnly ? 'On' : 'Off'}
                  aria-label={`Projects only for ${r.name ?? r.email ?? 'this person'}: no access to Merit Books`}
                  checked={!!r.projectsOnly}
                  disabled={!!why || flipping === r.membershipId}
                  title={why ?? undefined}
                  onChange={(e) => {
                    if (e.target.checked) setConfirming(r);
                    else void setProjectsOnly(r, false).catch(() => undefined);
                  }}
                />
                {why ? <span className="l2">{why}</span> : null}
              </span>
            );
          },
        } satisfies QueueColumn<TeamRow>]
      : []),
    { id: 'open', header: <span className="sr">Action</span>, width: 168, cell: () => <ButtonLink variant="quiet" href={booksTeamUrl}>Change in Books</ButtonLink> },
  ];
  const groups: QueueGroup<TeamRow>[] = [
    { id: 'with', title: 'With a Projects role', caption: `Use Merit Projects at ${companyName}`, rows: rows.filter((r) => r.titles.length > 0) },
    { id: 'without', title: 'No Projects role here', caption: 'Members of the workspace who don’t use Projects at this company', rows: rows.filter((r) => r.titles.length === 0) },
  ].filter((g) => g.rows.length > 0);

  return (
    <div className="stack">
      {preview && (
        <div className="surface" style={{ padding: 16 }}>
          <div className="row" style={{ gap: 16, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <Field label="Preview as" help="See the app the way this role sees it: its menu, home and money. It can only hide things, never show more than you can see.">
              <Select value={persona} onChange={(e) => setPersona(e.target.value as PersonaKey | '')} style={{ minWidth: 240 }}>
                <option value="">Pick a role…</option>
                {preview.personas.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
              </Select>
            </Field>
            <Button variant="primary" onClick={() => void startPreview()} disabled={!persona || busy || persona === preview.current}>
              {busy ? 'Starting…' : 'Preview'}
            </Button>
          </div>
        </div>
      )}

      {error ? (
        <WidgetState state={{ kind: 'error', title: 'The team didn’t load', body: error, onRetry: () => router.refresh(), retryLabel: 'Try again' }} />
      ) : rows.length === 0 ? (
        <WidgetState state={{ kind: 'empty', title: `No one is on the team at ${companyName} yet`, body: 'Invite people in Merit Books; they get a Projects role there.', action: <ButtonLink href={booksTeamUrl}>Open team in Merit Books</ButtonLink> }} />
      ) : (
        <>
          <QueueTable
            aria-label={`People at ${companyName} and their Projects role`}
            columns={columns}
            groups={groups}
            getRowId={(r) => r.membershipId}
            openOnClick
            onOpen={() => window.location.assign(booksTeamUrl)}
            compact
          />
          <p className="t-cap">
            {count(groups.find((g) => g.id === 'with')?.rows.length ?? 0)} of {count(rows.length)} people use Merit Projects here. Roles and invitations are shared across the suite, so they change in
            Merit Books; who works which job is set on each job’s team.
          </p>
        </>
      )}

      {showSwitch && (
        <InlineNotice title="Projects only — no access to Merit Books">
          Turn this on for crew, field and office people who should only use Merit Projects. They stop seeing anything in Merit Books — no
          bank feeds, bills, invoices, payroll, financial reports or other companies’ books — and in Merit Projects they see only their own jobs,
          with the money their Projects role allows. Turning it off gives back whatever Merit Books access they had. Owners and admins can’t be
          Projects only, and nobody changes their own seat.
        </InlineNotice>
      )}

      <ConfirmDialog
        open={!!confirming}
        onClose={() => setConfirming(null)}
        onConfirm={() => (confirming ? setProjectsOnly(confirming, true) : undefined)}
        title={`Make ${confirming?.name ?? confirming?.email ?? 'this person'} Projects only?`}
        confirmLabel="Make Projects only"
        tone="danger"
      >
        They lose all access to Merit Books right away: no bank feeds, bills, invoices, payroll, reports or company books. In Merit Projects they
        keep their role, see only their own jobs and only the money that role allows. You can turn it off later.
      </ConfirmDialog>

      <InlineNotice title="What each role sees">
        Owners and general managers see every job and all money. Project managers see full money on jobs where they are on the team. The office sees every job; only the roles that bill or buy see contract or cost amounts, and none see margin unless they hold both.
        Supervisors see hours and quantities; crew see only their own jobs and no money.
      </InlineNotice>
    </div>
  );
}
