'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Search, Select, Tag } from '@meritbooks/merit-ui';

export interface AreaLink {
  key: string;
  name: string;
  desc: string;
  status?: string;
  attn?: boolean;
  href: string;
}

export interface SettingsIndexProps {
  company: { id: string; name: string };
  companies: Array<{ id: string; name: string }>;
  orgName: string;
  current: string;
  companyAreas: AreaLink[];
  workspaceAreas: AreaLink[];
}

/** The S27 index: a scope per level, numbered areas, and "Find a setting". */
export function SettingsIndex(p: SettingsIndexProps) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const match = (a: AreaLink) => !q.trim() || `${a.name} ${a.desc}`.toLowerCase().includes(q.trim().toLowerCase());
  const ca = useMemo(() => p.companyAreas.filter(match), [p.companyAreas, q]); // eslint-disable-line react-hooks/exhaustive-deps
  const wa = useMemo(() => p.workspaceAreas.filter(match), [p.workspaceAreas, q]); // eslint-disable-line react-hooks/exhaustive-deps

  const list = (areas: AreaLink[], offset: number, label: string) => (
    <ol className="ar" aria-label={label}>
      {areas.map((a, i) => (
        <li key={a.key} className={a.attn ? 'is-attn' : undefined} aria-current={a.key === p.current ? true : undefined}>
          <span className="no" aria-hidden="true">{offset + i + 1}</span>
          <span style={{ minWidth: 0 }}>
            <span className="nm"><Link href={a.href}>{a.name}</Link></span>
            <span className="ds">{a.desc}</span>
          </span>
          <span className="st">{a.status ? <span className={a.attn ? 't-cap warn' : 't-cap'}>{a.status}</span> : null}</span>
        </li>
      ))}
    </ol>
  );

  return (
    <div>
      <Search aria-label="Find a setting" slashToFocus placeholder="Find a setting" value={q} onChange={(e) => setQ(e.target.value)} />
      <section className="scope" aria-labelledby="sc-company" style={{ marginTop: 24 }}>
        <div className="scope-h">
          <h2 className="t-section" id="sc-company">{p.company.name}</h2>
          <span className="sp" />
          {p.companies.length > 1 ? (
            <Select aria-label="Company" value={p.company.id} onChange={(e) => router.push(`/settings?company=${e.target.value}&area=${p.current}`)} style={{ width: 200 }}>
              {p.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          ) : (
            <Tag>Company</Tag>
          )}
        </div>
        {ca.length ? list(ca, 0, `Settings for ${p.company.name}`) : <p className="t-cap" style={{ padding: '12px 0' }}>No company setting matches “{q}”.</p>}
      </section>
      <section className="scope" aria-labelledby="sc-ws">
        <div className="scope-h">
          <h2 className="t-section" id="sc-ws">{p.orgName}</h2>
          <span className="sp" />
          <Tag>Workspace</Tag>
        </div>
        {wa.length ? list(wa, p.companyAreas.length, 'Workspace settings') : <p className="t-cap" style={{ padding: '12px 0' }}>No workspace setting matches “{q}”.</p>}
      </section>
    </div>
  );
}
