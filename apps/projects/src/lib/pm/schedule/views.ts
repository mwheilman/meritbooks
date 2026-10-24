/**
 * Which schedule view a job opens on, by its job type's archetype (packages/industry-packs):
 * project work (commercial_gc, home_builder, residential_remodel, specialty_trade projects),
 * development (real_estate_development, home_builder lots), engineered-to-order
 * (manufacturing_eto) and engagements (professional_services) open on the Gantt; visit-shaped
 * work (field service, recurring service, dealer service, retail orders) opens on the task list.
 * Either view is one click away. Pure.
 */
import type { ScheduleView, TemplateOption } from './types';

const GANTT_ARCHETYPES = new Set(['project', 'development', 'eto', 'engagement']);

export function defaultScheduleView(archetype: string | null | undefined): ScheduleView {
  return archetype && GANTT_ARCHETYPES.has(archetype) ? 'gantt' : 'list';
}

/** Words a template's job type suggests, to pick the one an empty schedule offers first. */
const HINTS: ReadonlyArray<[RegExp, RegExp]> = [
  [/kitchen/i, /kitchen/i],
  [/bath/i, /bath/i],
  [/remodel|renovat/i, /kitchen|remodel/i],
  [/custom|home|house|spec/i, /custom home|home/i],
  [/tenant|\bti\b|fit-?out|interior/i, /tenant|\bti\b|fit/i],
  [/hvac|mechanical|furnace|install/i, /hvac|install/i],
  [/cabinet|eto|millwork|shop/i, /cabinet|eto/i],
  [/floor/i, /floor/i],
  [/develop|land|lot/i, /develop|milestone/i],
];

/**
 * The template an empty schedule offers ("Start from the Kitchen remodel template"): one made
 * for this job type, else one whose name fits the job type's words, else the first.
 */
export function suggestTemplate(templates: ReadonlyArray<TemplateOption>, jobTypeKey: string | null, jobTypeLabel: string | null): TemplateOption | null {
  if (!templates.length) return null;
  const exact = jobTypeKey ? templates.find((t) => t.job_type_keys.includes(jobTypeKey)) : undefined;
  if (exact) return exact;
  const words = `${jobTypeKey ?? ''} ${jobTypeLabel ?? ''}`;
  for (const [job, tpl] of HINTS) {
    if (!job.test(words)) continue;
    const hit = templates.find((t) => tpl.test(t.name));
    if (hit) return hit;
  }
  return templates[0] ?? null;
}

/** "Kitchen remodel" → "the Kitchen remodel template" (no doubled "template"). */
export function templatePhrase(name: string): string {
  return /template$/i.test(name.trim()) ? `the ${name.trim()}` : `the ${name.trim()} template`;
}
