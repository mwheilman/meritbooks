'use client';

import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { AiPaused, Button, Field, Icon, InlineNotice, Input, PageHead, Tag } from '@meritbooks/merit-ui';
import type { CompanyBrief, PackTile } from '@/lib/onboarding/types';
import type { CompanyFlow } from './flow';

const PLACEHOLDER = "e.g., We install and service furnaces and AC, 12 trucks, moving off ServiceTitan";

/** Step 1 — tiles + one free-text line + an optional file. One decision. */
export function DescribeStep({
  company, tiles, flow, mode, aiConfigured, busy, error, onChange, onFile, onSubmit, onPick, onBack, primaryRef,
}: {
  company: CompanyBrief;
  tiles: PackTile[];
  flow: CompanyFlow;
  mode: 'first' | 'change';
  aiConfigured: boolean;
  busy: null | string;
  error: string | null;
  onChange: (p: Partial<CompanyFlow>) => void;
  onFile: (f: File) => void;
  onSubmit: () => void;
  onPick: (packKey: string) => void;
  onBack: (() => void) | null;
  primaryRef: MutableRefObject<(() => void) | null>;
}) {
  const [over, setOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const cls = flow.classification;
  const closest = new Map((cls?.abstain ? cls.candidates : []).map((c) => [c.packKey, c]));
  const guess = company.booksGuess;
  const submitting = busy === 'classify' || busy === 'plan';
  useEffect(() => { primaryRef.current = () => { if (!submitting) onSubmit(); }; });

  const drop = (files: FileList | null) => {
    const f = files?.[0];
    if (f) onFile(f);
  };

  const title = mode === 'change' ? `What kind of work does ${company.name} do now?` : `What kind of work does ${company.name} do?`;
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (!submitting) onSubmit(); }}>
      <PageHead eyebrow={[mode === 'change' ? 'Change setup' : 'Set up', company.name]} title={title}>
        <p className="ob-lede">
          {mode === 'change' && company.installed
            ? `Set up as ${company.installed.name} today. Pick again and we'll show you exactly what changes before anything moves. Nothing is deleted.`
            : 'Pick the closest. You can change it later, and nothing is set up until you say so.'}
        </p>
      </PageHead>

      {guess && !flow.tile && mode === 'first' && (
        <div className="ob-suggest" role="note">
          <span className="prov">From Merit Books</span>
          <span>Looks like <b>{guess.label}</b>: {guess.reasons.slice(0, 2).join('; ')}.</span>
          <Button variant="quiet" onClick={() => onChange({ tile: guess.packKey })}>Use {guess.label}</Button>
        </div>
      )}

      {cls?.abstain && (
        <div style={{ marginBottom: 16 }}>
          {cls.ai.outcome === 'unavailable' || cls.ai.outcome === 'blocked' ? (
            <AiPaused>We matched your words with the rules and couldn&apos;t tell for sure. Pick the closest; you can change it later.</AiPaused>
          ) : (
            <InlineNotice tone="info" title="Pick the closest. You can change it later.">
              {cls.candidates.length > 0
                ? `Closest matches are marked below: ${cls.candidates.map((c) => c.tileLabel).join(', ')}.`
                : "We couldn't tell from that alone."}
            </InlineNotice>
          )}
        </div>
      )}

      <div className="ob-tiles" role="group" aria-label="Kinds of work">
        {tiles.map((t) => {
          const pressed = flow.tile === t.key;
          const near = closest.get(t.key);
          return (
            <button
              key={t.key}
              type="button"
              className="ob-tile"
              aria-pressed={pressed}
              onClick={() => (pressed ? onChange({ tile: null }) : cls?.abstain ? onPick(t.key) : onChange({ tile: t.key }))}
              title={t.tagline}
            >
              {near && <Tag tone="ai">Close match</Tag>}
              {!near && guess?.packKey === t.key && !pressed && mode === 'first' && <Tag>From Books</Tag>}
              {mode === 'change' && company.installed?.packKey === t.key && <Tag>Today</Tag>}
              <span className="t-head">{t.label}</span>
              <span className="t-cap">{t.examples}</span>
            </button>
          );
        })}
      </div>

      <div className="ob-describe">
        <Field label="Or describe it in a sentence" help={aiConfigured ? 'We read it for the kind of work and a few settings, and show you where each came from.' : 'We match your words against every kind of work we know.'}>
          <Input
            value={flow.description}
            maxLength={600}
            placeholder={PLACEHOLDER}
            onChange={(e) => onChange({ description: e.currentTarget.value })}
            autoComplete="off"
          />
        </Field>
        <label
          className={`ob-drop${over ? ' is-over' : ''}${flow.file ? ' is-loaded' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); drop(e.dataTransfer.files); }}
        >
          <input ref={fileInput} type="file" accept=".csv,.xlsx,.xlsm,.txt,.tsv" onChange={(e) => drop(e.currentTarget.files)} aria-label="Drop a job list (optional)" />
          <Icon name={flow.file ? 'check' : 'upload'} />
          {busy === 'file' ? (
            <span className="t-cap" role="status">Reading the file…</span>
          ) : flow.file ? (
            <span>
              <span className="l1">{flow.file.fileName}</span>
              <span className="l2">
                {flow.file.rowCount.toLocaleString('en-US')} rows{flow.file.vendor ? ` · looks like a ${flow.file.vendor} export` : ''} · we&apos;ll use it again in step 3
              </span>
            </span>
          ) : (
            <span>
              <span className="l1">Have a job list? Drop it here</span>
              <span className="l2">CSV or Excel. Optional. We read the headers now and the jobs later.</span>
            </span>
          )}
        </label>
      </div>

      {error && <div style={{ marginTop: 16 }}><InlineNotice tone="neg" title={error} /></div>}

      <div className="ob-foot">
        {onBack && <Button variant="quiet" chord="escape" onClick={onBack}>Back</Button>}
        <span className="sp" />
        {submitting && (
          <span className="ob-busy" role="status">
            {busy === 'classify' && flow.description.trim() && aiConfigured ? 'Reading your description…' : 'Building your workspace…'}
          </span>
        )}
        <Button type="submit" variant="primary" size="lg" chord="enter" disabled={submitting || (!flow.tile && !flow.description.trim() && !flow.file)}>
          Show my workspace
        </Button>
      </div>
    </form>
  );
}
