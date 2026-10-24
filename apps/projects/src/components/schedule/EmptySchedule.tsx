'use client';

/**
 * An empty schedule: start from the template made for this job type ("Start from the Kitchen
 * remodel template"), pick another, or add the first task by hand.
 */
import { useState } from 'react';
import { Button, Field, Input, Select, WidgetState } from '@meritbooks/merit-ui';
import { parseDayInput } from '@/lib/pm/schedule/dates';
import { suggestTemplate, templatePhrase } from '@/lib/pm/schedule/views';
import type { TemplateOption } from '@/lib/pm/schedule/types';

export interface EmptyScheduleProps {
  templates: ReadonlyArray<TemplateOption>;
  jobTypeKey: string | null;
  jobTypeLabel: string | null;
  defaultStart: string;
  today: string;
  canEdit: boolean;
  engine: boolean;
  busy: boolean;
  onApply: (templateId: string, start: string, name: string) => void;
  onAdd: () => void;
}

export function EmptySchedule(p: EmptyScheduleProps) {
  const first = suggestTemplate(p.templates, p.jobTypeKey, p.jobTypeLabel);
  const [pick, setPick] = useState(first?.id ?? '');
  const [start, setStart] = useState(p.defaultStart);
  const [err, setErr] = useState<string | null>(null);
  const chosen = p.templates.find((t) => t.id === pick) ?? first;

  if (!p.canEdit) {
    return (
      <div className="surface">
        <WidgetState state={{ kind: 'empty', title: 'No schedule yet', body: 'The project manager builds this job’s schedule. It shows here, read-only, once there are tasks.' }} />
      </div>
    );
  }
  if (!p.engine) {
    return (
      <div className="surface">
        <WidgetState state={{ kind: 'empty', title: 'No schedule yet', body: 'Scheduling with templates, links and the critical path switches on when your administrator applies the schedule update.' }} />
      </div>
    );
  }
  const apply = () => {
    if (!chosen) return;
    const s = parseDayInput(start, p.today);
    if (!s) return setErr('Type the start as a date, like 11/18.');
    setErr(null);
    p.onApply(chosen.id, s, chosen.name);
  };
  return (
    <div className="surface">
      <WidgetState
        state={{
          kind: 'empty',
          title: 'No schedule yet',
          body: chosen
            ? `Start from ${templatePhrase(chosen.name)}${chosen.task_count ? ` (${chosen.task_count} tasks, linked and sequenced)` : ''} and adjust from there, or add tasks one at a time.`
            : 'Add the first task, then press Enter for the next. Tab makes a phase.',
          action: (
            <div className="stack" style={{ gap: 16, alignItems: 'flex-start' }}>
              {chosen && (
                <div className="row" style={{ gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  {p.templates.length > 1 && (
                    <Field label="Template">
                      <Select value={pick} onChange={(e) => setPick(e.target.value)}>
                        {p.templates.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                            {t.task_count ? ` · ${t.task_count} tasks` : ''}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  )}
                  <Field label="Starts" error={err ?? undefined}>
                    <Input value={start} onChange={(e) => setStart(e.target.value)} placeholder="11/18" style={{ width: 120 }} />
                  </Field>
                  <Button variant="primary" icon="layers" disabled={p.busy} onClick={apply}>
                    {`Start from ${templatePhrase(chosen.name)}`}
                  </Button>
                </div>
              )}
              <Button icon="plus" disabled={p.busy} onClick={p.onAdd}>
                Add the first task
              </Button>
            </div>
          ),
        }}
      />
    </div>
  );
}
