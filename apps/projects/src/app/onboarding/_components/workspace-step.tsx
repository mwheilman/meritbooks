'use client';

import { useEffect, useState, type MutableRefObject } from 'react';
import {
  AiPaused, Button, Check, Evidence, InlineNotice, Input, Meter, Note, PageHead, Seg, Select, Switch, Tag, Why,
} from '@meritbooks/merit-ui';
import type { AnswerValue, ClassifyResponse, CompanyBrief, PlanInputs, PlanPreview, QuestionDTO } from '@/lib/onboarding/types';
import type { CompanyFlow } from './flow';

const SOURCE_WORDS: Record<ClassifyResponse['source'], string> = {
  tile: 'Your pick',
  rules: 'Rules: your words, the Books industry and how Books recognizes revenue',
  ai: 'AI, checked against your own words',
  merged: 'Rules and AI agree',
};

function ClassificationNote({ company, cls, preview, onPick, onBack }: {
  company: CompanyBrief;
  cls: ClassifyResponse | null;
  preview: PlanPreview;
  onPick: (k: string) => void;
  onBack: () => void;
}) {
  const top = cls?.candidates.find((c) => c.packKey === preview.packKey) ?? null;
  const others = (cls?.candidates ?? []).filter((c) => c.packKey !== preview.packKey).slice(0, 2);
  const picked = cls?.source === 'tile' && cls.candidates[0]?.packKey === preview.packKey;
  const aiDown = cls && (cls.ai.outcome === 'unavailable' || cls.ai.outcome === 'blocked');
  const quotes = cls?.evidence ?? [];
  return (
    <>
      {aiDown && (
        <div style={{ marginBottom: 16 }}>
          <AiPaused>We matched your description with the rules instead. Everything below works the same; the questions just start at their defaults.</AiPaused>
        </div>
      )}
      <Note
        n={1}
        kind="Kind of work"
        headingLevel={3}
        title={picked ? `You picked ${preview.packName}` : `${company.name} looks like ${preview.packName}`}
        evidence={quotes.length > 0 ? { rows: quotes.map((q) => ({ label: `“${q}”`, value: 1 })), total: { label: 'Phrases of yours we matched' }, unit: 'count' } : undefined}
        basis={{
          confidence: top ? top.confidence : undefined,
          items: [
            cls ? SOURCE_WORDS[cls.source] : 'Your pick',
            ...(cls && cls.rejected > 0 ? [`Dropped ${cls.rejected} AI ${cls.rejected === 1 ? 'claim' : 'claims'} we couldn't find in your words`] : []),
          ],
        }}
        actions={
          <>
            {others.map((o) => (
              <Button key={o.packKey} variant="quiet" onClick={() => onPick(o.packKey)}>Use {o.tileLabel} instead</Button>
            ))}
            <Button variant="quiet" onClick={onBack}>Pick something else</Button>
          </>
        }
      >
        {preview.vocabularyHeadline} {preview.jobTypes.length} kinds of {preview.jobsWord.toLowerCase()}, {preview.costCodes.count} cost codes, and the tools on the right. Turn anything off before you set it up.
      </Note>
      {top && quotes.length === 0 && top.reasons.length > 0 && !picked && <Why items={top.reasons.slice(0, 4).map((r) => ({ text: r }))} />}
    </>
  );
}

function QuestionControl({ q, onAnswer }: { q: QuestionDTO; onAnswer: (v: AnswerValue) => void }) {
  if (q.type === 'bool') {
    return (
      <Seg aria-label={q.prompt} value={q.value === true ? 'yes' : 'no'} items={[{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]} onChange={(v) => onAnswer(v === 'yes')} />
    );
  }
  if (q.type === 'choice') {
    if (q.options.length <= 3 && q.options.every((o) => o.label.length <= 28)) {
      return <Seg aria-label={q.prompt} value={String(q.value)} items={q.options} onChange={(v) => onAnswer(v)} />;
    }
    return (
      <Select aria-label={q.prompt} value={String(q.value)} onChange={(e) => onAnswer(e.currentTarget.value)}>
        {q.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </Select>
    );
  }
  if (q.type === 'multi') {
    const set = new Set(Array.isArray(q.value) ? q.value : []);
    return (
      <>
        {q.options.map((o) => (
          <Check
            key={o.value}
            label={o.label}
            checked={set.has(o.value)}
            onChange={(e) => {
              const next = new Set(set);
              if (e.currentTarget.checked) next.add(o.value); else next.delete(o.value);
              onAnswer(q.options.map((x) => x.value).filter((v) => next.has(v)));
            }}
          />
        ))}
      </>
    );
  }
  const pct = typeof q.value === 'number' ? Math.round(q.value * 1000) / 10 : 0;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <Input
        aria-label={q.prompt}
        type="number"
        inputMode="decimal"
        style={{ width: 96, textAlign: 'right' }}
        min={(q.min ?? 0) * 100}
        max={(q.max ?? 1) * 100}
        step={0.5}
        defaultValue={pct}
        onBlur={(e) => {
          const n = Number(e.currentTarget.value);
          if (Number.isFinite(n)) onAnswer(Math.min(q.max ?? 1, Math.max(q.min ?? 0, n / 100)));
        }}
      />
      <span className="t-cap">percent</span>
    </span>
  );
}

function Skeleton() {
  return (
    <div className="ob-card wg-loading">
      <div className="ob-skel" aria-busy="true">
        {['80%', '60%', '72%', '64%', '52%'].map((w) => <span key={w} className="bar-l" style={{ width: w }} aria-hidden="true" />)}
        <span className="t-cap" role="status">Building your workspace…</span>
      </div>
    </div>
  );
}

/** Step 2 — the compiled plan as cards, the pack's questions and switches on the right, one CTA. */
export function WorkspaceStep({ company, flow, mode, busy, error, onInputs, onPick, onApply, onBack, primaryRef }: {
  company: CompanyBrief;
  flow: CompanyFlow;
  mode: 'first' | 'change';
  busy: null | string;
  error: string | null;
  onInputs: (inputs: PlanInputs) => void;
  onPick: (packKey: string) => void;
  onApply: () => void;
  onBack: () => void;
  primaryRef: MutableRefObject<(() => void) | null>;
}) {
  const [allCodes, setAllCodes] = useState(false);
  const [allModules, setAllModules] = useState(false);
  const pv = flow.preview;
  const inputs = flow.plan;
  const canApply = Boolean(pv && inputs) && busy !== 'plan' && busy !== 'apply';
  useEffect(() => { primaryRef.current = () => { if (canApply) onApply(); }; });

  if (!inputs) return null;
  if (!pv) {
    return (
      <>
        <PageHead eyebrow={['Set up', company.name]} title="Here's your workspace" />
        {error ? (
          <InlineNotice tone="neg" title={error}>
            <Button variant="quiet" onClick={() => onInputs({ ...inputs })}>Try again</Button>
            <Button variant="quiet" onClick={onBack}>Back</Button>
          </InlineNotice>
        ) : <Skeleton />}
      </>
    );
  }

  const answer = (key: string, v: AnswerValue) => onInputs({ ...inputs, answers: { ...(inputs.answers ?? {}), [key]: v } });
  const toggleModule = (m: string, on: boolean) => onInputs({ ...inputs, moduleOverrides: { ...(inputs.moduleOverrides ?? {}), [m]: on } });
  const setAddons = (addons: string[]) => {
    const keep = Object.fromEntries(Object.entries(inputs.answers ?? {}).filter(([k]) => !k.includes('.') || addons.includes(k.split('.')[0]!)));
    onInputs({ ...inputs, addons, answers: keep });
  };
  const suggestedAddons = pv.addonOptions.filter((a) => a.suggested);
  const otherAddons = pv.addonOptions.filter((a) => !a.suggested && !inputs.addons.includes(a.key));
  const onMods = pv.modules.filter((m) => m.on);
  const offMods = pv.modules.filter((m) => !m.on);
  const codes = allCodes ? pv.costCodes.items : pv.costCodes.items.slice(0, 8);
  const generic = pv.cards.filter((c) => ['billing', 'stages', 'vocabulary', 'kpis', 'books', 'price_book'].includes(c.section));
  const updating = busy === 'plan';

  return (
    <>
      <PageHead eyebrow={[mode === 'change' ? 'Change setup' : 'Set up', company.name]} title="Here's your workspace">
        <p className="ob-lede">Everything below comes from the {pv.packName} pack. Change anything on the right; the preview updates as you go.</p>
      </PageHead>

      <div className="ob-cx">
        <div className="ob-stack">
          <ClassificationNote company={company} cls={flow.classification} preview={pv} onPick={onPick} onBack={onBack} />

          {pv.diff && (
            <InlineNotice tone="info" title={pv.diff.identical ? 'Nothing changes. This is the setup you have today.' : 'What changes when you apply'}>
              {!pv.diff.identical && (
                <ul className="ob-list">
                  {pv.diff.lines.map((l) => (
                    <li key={l.section}>
                      <b>{l.section}</b>
                      {l.added.length > 0 && ` · adds ${l.added.join(', ')}`}
                      {l.removed.length > 0 && ` · switches off ${l.removed.join(', ')}`}
                      {l.changed.length > 0 && ` · changes ${l.changed.join(', ')}`}
                    </li>
                  ))}
                </ul>
              )}
              <p className="t-cap" style={{ marginTop: 8 }}>Nothing is deleted. Anything removed is switched off and stays in your history.</p>
            </InlineNotice>
          )}

          <section className="ob-card" aria-labelledby="ob-jt">
            <div className="ob-card-h"><h2 id="ob-jt">Kinds of {pv.jobsWord.toLowerCase()}</h2><span className="sp" /><span className="t-cap tnum">{pv.jobTypes.length}</span></div>
            <div className="ob-card-b">
              {pv.jobTypes.map((j) => (
                <div key={j.key} className="ob-jt">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
                    <span className="l1">{j.label}</span>
                    <Meter strokes={j.stages.map(() => 'on' as const)} label={`${j.stages.length} stages: ${j.stages.join(', ')}`} />
                  </div>
                  <div className="ob-path" aria-hidden="true">{j.stages.map((s) => <span key={s}>{s}</span>)}</div>
                  <span className="l2" style={{ whiteSpace: 'normal', marginTop: 4 }}>
                    {j.billing}{j.exits.length > 0 ? `. Can also end ${j.exits.join(' or ')}.` : '.'}
                  </span>
                </div>
              ))}
            </div>
          </section>

          <section className="ob-card" aria-labelledby="ob-cc">
            <div className="ob-card-h"><h2 id="ob-cc">Cost codes</h2><span className="sp" /><span className="t-cap tnum">{pv.costCodes.count}</span></div>
            <div className="ob-card-b">
              <p>{pv.cards.find((c) => c.section === 'cost_codes')?.summary}</p>
              <ul className="ob-codes">
                {codes.map((c) => <li key={c.code}><span className="code">{c.code}</span><span className="nm">{c.name}</span></li>)}
              </ul>
            </div>
            {pv.costCodes.count > 8 && (
              <div className="ob-card-f">
                <span>{allCodes ? `All ${pv.costCodes.count}` : `First 8 of ${pv.costCodes.count}`}</span>
                <span className="sp" />
                <Button variant="quiet" aria-expanded={allCodes} onClick={() => setAllCodes((v) => !v)}>{allCodes ? 'Show fewer' : `Show all ${pv.costCodes.count}`}</Button>
              </div>
            )}
          </section>

          <div className="ob-grid2">
            {generic.map((c) => (
              <section key={c.section} className="ob-card" aria-label={c.title}>
                <div className="ob-card-h"><h3>{c.title}</h3></div>
                <div className="ob-card-b">
                  <p>{c.summary}</p>
                  {c.items.length > 0 && <ul className="ob-list">{c.items.slice(0, 8).map((it) => <li key={it}>{it}</li>)}</ul>}
                </div>
              </section>
            ))}
          </div>
        </div>

        <aside className="ob-side" aria-label="Choices">
          {pv.questions.length > 0 && (
            <div className="ob-sec">
              <div className="ob-sec-h"><h3>A few questions</h3><span className="t-cap">{pv.questions.length}</span></div>
              {pv.questions.map((q) => (
                <div key={q.key} className="ob-q">
                  <div className="ob-q-p">{q.prompt}</div>
                  {q.help && <div className="t-cap ob-q-help">{q.help}</div>}
                  <div className="ob-q-c"><QuestionControl key={`${q.key}:${String(q.value)}`} q={q} onAnswer={(v) => answer(q.key, v)} /></div>
                  {q.suggestedFrom && (
                    <div className="ob-sugg"><Tag tone="ai">Suggested from your description</Tag><span>“{q.suggestedFrom}”</span></div>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="ob-sec">
            <div className="ob-sec-h"><h3>Also do</h3></div>
            {suggestedAddons.map((a) => (
              <div key={a.key}>
                <Check
                  label={<span>{a.label}{a.reason ? <span className="t-cap"> · {a.reason}</span> : null}</span>}
                  checked={inputs.addons.includes(a.key)}
                  onChange={(e) => setAddons(e.currentTarget.checked ? [...inputs.addons, a.key] : inputs.addons.filter((x) => x !== a.key))}
                />
              </div>
            ))}
            {inputs.addons.filter((k) => !suggestedAddons.some((a) => a.key === k)).map((k) => (
              <div key={k}>
                <Check label={pv.addonOptions.find((a) => a.key === k)?.label ?? k} checked onChange={() => setAddons(inputs.addons.filter((x) => x !== k))} />
              </div>
            ))}
            {otherAddons.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <Select aria-label="Add another kind of work" value="" onChange={(e) => { const v = e.currentTarget.value; if (v) setAddons([...inputs.addons, v]); }}>
                  <option value="">Add another kind of work…</option>
                  {otherAddons.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
                </Select>
              </div>
            )}
          </div>

          <div className="ob-sec">
            <div className="ob-sec-h"><h3>Tools</h3><span className="t-cap tnum">{onMods.length} on</span></div>
            <ul className="ob-mods">
              {[...onMods, ...(allModules ? offMods : [])].map((m) => (
                <li key={m.key}>
                  <span>{m.label}{m.overridden ? <span className="t-cap"> · changed</span> : null}</span>
                  <Switch aria-label={m.label} checked={m.on} onChange={(e) => toggleModule(m.key, e.currentTarget.checked)} />
                </li>
              ))}
            </ul>
            {offMods.length > 0 && (
              <Button variant="quiet" aria-expanded={allModules} onClick={() => setAllModules((v) => !v)}>
                {allModules ? 'Hide the ones that are off' : `Show ${offMods.length} more you can turn on`}
              </Button>
            )}
          </div>

          <div className="ob-sec">
            {error && <div style={{ marginBottom: 12 }}><InlineNotice tone="neg" title={error} /></div>}
            <Button variant="primary" size="lg" chord="enter" style={{ width: '100%' }} disabled={!canApply} onClick={onApply}>
              {busy === 'apply' ? `Setting up ${company.name}…` : mode === 'change' ? `Apply to ${company.name}` : `Set up ${company.name}`}
            </Button>
            <div className="t-cap" style={{ marginTop: 8 }} role="status">
              {updating ? 'Updating the preview…' : 'You can change any of this later in Settings.'}
            </div>
            <div style={{ marginTop: 8 }}><Button variant="quiet" chord="escape" onClick={onBack}>Back</Button></div>
          </div>
        </aside>
      </div>
    </>
  );
}
