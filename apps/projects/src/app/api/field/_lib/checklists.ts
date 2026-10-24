/**
 * Field checklists offered on the phone. Pure.
 *
 * There is no checklist table yet (named gap: pm.checklist_templates per company, edited in
 * Settings). Until it lands these built-in templates are offered by the job type's modules, and a
 * completed checklist is stored as a pm.field_logs row (kind INSPECTION or SAFETY) whose `ext.checklist`
 * holds every answer — so it shows on the job's Logs tab today. A failed item becomes a punch item.
 */
import type { ModuleKey } from '@meritbooks/industry-packs';

export interface Bilingual {
  en: string;
  es: string;
}

export interface ChecklistItemTemplate {
  key: string;
  text: Bilingual;
  /** required: a photo for PASS or FAIL · on_fail: only when it fails · optional */
  photo: 'required' | 'on_fail' | 'optional';
}

export interface ChecklistTemplate {
  key: string;
  title: Bilingual;
  logKind: 'INSPECTION' | 'SAFETY';
  /** Offered when the job type has ANY of these modules (null: every job). */
  modules: ReadonlyArray<ModuleKey> | null;
  items: ReadonlyArray<ChecklistItemTemplate>;
}

export const CHECKLISTS: ReadonlyArray<ChecklistTemplate> = [
  {
    key: 'site_safety',
    title: { en: 'Daily site safety walk', es: 'Recorrido diario de seguridad' },
    logKind: 'SAFETY',
    modules: null,
    items: [
      { key: 'ppe', text: { en: 'Everyone on site has hard hat, glasses, gloves and boots', es: 'Todos tienen casco, lentes, guantes y botas' }, photo: 'on_fail' },
      { key: 'housekeeping', text: { en: 'Walkways clear, no trip hazards', es: 'Pasillos libres, sin riesgo de tropiezo' }, photo: 'on_fail' },
      { key: 'ladders', text: { en: 'Ladders inspected and tied off', es: 'Escaleras revisadas y amarradas' }, photo: 'on_fail' },
      { key: 'fall_protection', text: { en: 'Fall protection in place at edges and openings', es: 'Protección contra caídas en bordes y aberturas' }, photo: 'required' },
      { key: 'electrical', text: { en: 'Cords and tools in good shape, GFCI in use', es: 'Cables y herramientas en buen estado, GFCI en uso' }, photo: 'on_fail' },
      { key: 'fire', text: { en: 'Fire extinguisher charged and reachable', es: 'Extintor cargado y accesible' }, photo: 'on_fail' },
      { key: 'first_aid', text: { en: 'First-aid kit stocked', es: 'Botiquín completo' }, photo: 'optional' },
    ],
  },
  {
    key: 'visit_closeout',
    title: { en: 'Visit close-out', es: 'Cierre de la visita' },
    logKind: 'INSPECTION',
    modules: ['dispatch', 'service_agreements', 'assets'],
    items: [
      { key: 'system_running', text: { en: 'Equipment running and tested', es: 'Equipo funcionando y probado' }, photo: 'required' },
      { key: 'settings_restored', text: { en: 'Thermostat and settings back the way the customer wants', es: 'Termostato y ajustes como los quiere el cliente' }, photo: 'optional' },
      { key: 'area_clean', text: { en: 'Work area cleaned up', es: 'Área de trabajo limpia' }, photo: 'required' },
      { key: 'old_parts', text: { en: 'Old parts removed or left as the customer asked', es: 'Piezas viejas retiradas o dejadas como pidió el cliente' }, photo: 'optional' },
      { key: 'customer_walkthrough', text: { en: 'Walked the customer through the work', es: 'Le explicamos el trabajo al cliente' }, photo: 'optional' },
    ],
  },
  {
    key: 'punch_walk',
    title: { en: 'Final walk-through', es: 'Recorrido final' },
    logKind: 'INSPECTION',
    modules: ['punch_warranty', 'schedule'],
    items: [
      { key: 'finishes', text: { en: 'Paint and finishes complete, no touch-ups needed', es: 'Pintura y acabados completos, sin retoques' }, photo: 'on_fail' },
      { key: 'doors_hardware', text: { en: 'Doors, drawers and hardware work', es: 'Puertas, cajones y herrajes funcionan' }, photo: 'on_fail' },
      { key: 'fixtures', text: { en: 'Fixtures and devices installed and working', es: 'Accesorios y aparatos instalados y funcionando' }, photo: 'on_fail' },
      { key: 'flooring', text: { en: 'Floors clean and undamaged', es: 'Pisos limpios y sin daños' }, photo: 'on_fail' },
      { key: 'debris', text: { en: 'All debris and materials removed', es: 'Todo el escombro y material retirado' }, photo: 'required' },
    ],
  },
];

export function templateByKey(key: string): ChecklistTemplate | null {
  return CHECKLISTS.find((t) => t.key === key) ?? null;
}

/** Template keys offered for a job type with these modules. */
export function templatesFor(modules: ReadonlyArray<string> | null): string[] {
  const has = new Set(modules ?? []);
  return CHECKLISTS.filter((t) => !t.modules || t.modules.some((m) => has.has(m))).map((t) => t.key);
}

/** A plain-English summary for the log body (shows on the job's Logs tab). */
export function checklistSummary(t: ChecklistTemplate, counts: { pass: number; fail: number; na: number }, failed: ReadonlyArray<{ key: string; note?: string | null }>): string {
  const head = `${t.title.en}: ${counts.pass} pass, ${counts.fail} fail, ${counts.na} not applicable.`;
  if (!failed.length) return head;
  const lines = failed.map((f) => {
    const item = t.items.find((i) => i.key === f.key);
    return `Fail: ${item?.text.en ?? f.key}${f.note ? ` — ${f.note}` : ''}`;
  });
  return [head, ...lines].join('\n').slice(0, 8000);
}
