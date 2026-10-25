'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { AiPaused, Button, Drawer, Icon, Panel, PanelSection, Tag } from '@meritbooks/merit-ui';
import { JobDetails, type JobDetailsProps } from './JobDetails';
import type { AttentionItem } from './job-attention';
import { SLOT_LABEL } from './team-slots';
import type { JobTeamMember } from './team-data';
import './job.css';

export interface RailContact {
  id: string;
  name: string;
  title: string | null;
  email: string | null;
  phone: string | null;
  primary: boolean;
}

export interface JobAiState {
  /** False today everywhere: no per-job Ask endpoint yet. The box says why. */
  available: boolean;
  reason: string;
}

export interface JobRailProps {
  jobId: string;
  details: JobDetailsProps;
  customer: { id: string | null; name: string } | null;
  contacts: RailContact[] | null;
  team: { members: JobTeamMember[]; error: string | null };
  ai: JobAiState;
  attention: AttentionItem[];
}

const KEY = 'mp.job.rail';

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(KEY) === 'collapsed';
  } catch {
    return false;
  }
}

function writeCollapsed(v: boolean): void {
  try {
    window.localStorage.setItem(KEY, v ? 'collapsed' : 'open');
  } catch {
    /* a convenience only */
  }
}

/**
 * The job's right rail (UX seat §3d): Details (edit in place), People (customer contacts and the
 * job team) and AI. 320 px, collapsible and remembered per browser; under 1280 px it becomes a
 * slide-over opened from the tab row.
 */
export function JobRail(p: JobRailProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [drawer, setDrawer] = useState(false);
  useEffect(() => setCollapsed(readCollapsed()), []);
  const toggle = () => {
    setCollapsed((c) => {
      writeCollapsed(!c);
      return !c;
    });
  };

  const body = <RailBody {...p} />;
  return (
    <div className="job-rail-wrap">
      <aside className={collapsed ? 'job-rail is-collapsed' : 'job-rail'} aria-label="Job details, people and AI">
        <div className="job-rail-h">
          <Button variant="quiet" onClick={toggle} aria-expanded={!collapsed} aria-label={collapsed ? 'Show the details rail' : 'Hide the details rail'}>
            <Icon name={collapsed ? 'left' : 'right'} />
            {collapsed ? null : <span>Hide</span>}
          </Button>
        </div>
        {!collapsed && body}
      </aside>
      <Button className="job-rail-open" variant="quiet" onClick={() => setDrawer(true)} aria-haspopup="dialog">
        Details and people
      </Button>
      <Drawer open={drawer} onClose={() => setDrawer(false)} width={360} title="Details and people" aria-label="Job details and people">
        {body}
      </Drawer>
    </div>
  );
}

function RailBody(p: JobRailProps) {
  const base = `/jobs/${p.jobId}`;
  return (
    <Panel aria-label="Job rail" className="job-rail-panel">
      <PanelSection title="Details">
        <JobDetails {...p.details} />
      </PanelSection>

      <PanelSection title="People" meta={<Link className="link t-cap" href={`${base}?tab=team`}>Manage</Link>}>
        <PeopleList customer={p.customer} contacts={p.contacts} team={p.team} />
      </PanelSection>

      <PanelSection title="AI" meta={p.ai.available ? <Tag tone="ai">Suggested</Tag> : <Tag>Paused</Tag>}>
        <JobAiBox ai={p.ai} attention={p.attention} />
      </PanelSection>
    </Panel>
  );
}

function PeopleList({ customer, contacts, team }: Pick<JobRailProps, 'customer' | 'contacts' | 'team'>) {
  const rows: ReactNode[] = [];
  if (customer) {
    for (const c of contacts ?? []) {
      rows.push(
        <li key={`c:${c.id}`}>
          <span className="l1">{c.name}{c.primary ? <> <Tag>Primary</Tag></> : null}</span>
          <span className="l2">
            {[c.title ?? customer.name].filter(Boolean).join(' · ')}
            {c.phone ? <> · <a className="link" href={`tel:${c.phone}`}>{c.phone}</a></> : null}
            {c.email ? <> · <a className="link" href={`mailto:${c.email}`}>{c.email}</a></> : null}
          </span>
        </li>,
      );
    }
  }
  for (const m of team.members) {
    rows.push(
      <li key={`t:${m.membershipId}`}>
        <span className="l1">{m.name ?? m.email ?? 'Team member'}</span>
        <span className="l2">{[SLOT_LABEL[m.slot], m.role].filter(Boolean).join(' · ')}</span>
      </li>,
    );
  }
  return (
    <>
      {team.error && <p className="t-cap neg">{team.error}</p>}
      {contacts === null && customer && <p className="t-cap ink-3">Customer contacts did not load.</p>}
      {rows.length ? <ul className="job-people-list">{rows}</ul> : <p className="t-cap ink-3">Nobody is on this job yet. Add the team from People.</p>}
    </>
  );
}

/**
 * The AI box. AI never pops up and never auto-applies (UX seat §3f): with no per-job Ask yet it
 * says it is paused, then shows what still works — the rule-based checks, each with its evidence.
 */
export function JobAiBox({ ai, attention }: { ai: JobAiState; attention: AttentionItem[] }) {
  return (
    <div className="job-ai">
      {!ai.available && <AiPaused>{ai.reason}</AiPaused>}
      <p className="t-cap ink-3" style={{ marginTop: 8 }}>
        {attention.length ? 'Checks on this job (rules, not AI):' : 'No checks are raising anything on this job.'}
      </p>
      {attention.length > 0 && (
        <ul className="job-ai-list">
          {attention.map((a) => (
            <li key={a.id} className={`is-${a.tone}`}>
              <span className="l1">{a.title}</span>
              <span className="l2">{a.evidence}</span>
              <Link className="link t-cap" href={a.action.href}>{a.action.label}</Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
