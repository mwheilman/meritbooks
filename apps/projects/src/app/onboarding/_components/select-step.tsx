'use client';

import { useEffect, useState, type MutableRefObject } from 'react';
import { Button, Check, InlineNotice, PageHead } from '@meritbooks/merit-ui';
import type { CompanyBrief } from '@/lib/onboarding/types';

/** Step 0 — "Which companies run jobs?" Prefilled from Books; the management company never appears. */
export function SelectStep({ companies, busy, error, onConfirm, primaryRef }: {
  companies: CompanyBrief[];
  busy: boolean;
  error: string | null;
  onConfirm: (ids: string[]) => void;
  primaryRef: MutableRefObject<(() => void) | null>;
}) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set(companies.filter((c) => c.preselect.selected).map((c) => c.id)));
  const n = picked.size;
  const submit = () => { if (n > 0 && !busy) onConfirm(companies.filter((c) => picked.has(c.id)).map((c) => c.id)); };
  useEffect(() => { primaryRef.current = submit; });

  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <PageHead eyebrow={['Set up', `${companies.length} companies`]} title="Which companies run jobs?">
        <p className="ob-lede">We checked the ones Merit Books says do work by the job. Uncheck any that don&apos;t; you can add them later.</p>
      </PageHead>
      <ul className="ob-cos">
        {companies.map((c) => (
          <li key={c.id}>
            <div>
              <Check
                label={<span className="l1">{c.name}{c.shortCode ? <span className="t-cap"> · {c.shortCode}</span> : null}</span>}
                checked={picked.has(c.id)}
                onChange={(e) => {
                  const next = new Set(picked);
                  if (e.currentTarget.checked) next.add(c.id); else next.delete(c.id);
                  setPicked(next);
                }}
              />
              <div className="ob-why">
                {c.preselect.reasons.map((r) => <span key={r} className="prov">{r}</span>)}
              </div>
            </div>
            <span className="t-cap">{c.installed ? `Set up as ${c.installed.name}` : c.jobCount > 0 ? `${c.jobCount} ${c.jobCount === 1 ? 'job' : 'jobs'} in Books` : 'No jobs yet'}</span>
          </li>
        ))}
      </ul>
      {error && <div style={{ marginTop: 16 }}><InlineNotice tone="neg" title={error} /></div>}
      <div className="ob-foot">
        <span className="t-cap">We&apos;ll set them up one at a time. Each takes about a minute.</span>
        <span className="sp" />
        <Button type="submit" variant="primary" size="lg" chord="enter" disabled={n === 0 || busy}>
          {busy ? 'Saving…' : n === 1 ? 'Set up 1 company' : `Set up ${n} companies`}
        </Button>
      </div>
    </form>
  );
}
