/**
 * Schedule helpers: the `12FS+2d` link parser, drag math, virtualization windows, the outline
 * (WBS, indent targets), preferences storage, typed dates, export and the 1112 normalisers.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_CALENDAR, LAG_MAX, type SchedDep, type SchedTask } from '@/lib/pm/schedule/types';
import { formatLink, formatLinks, parseLinks, tokenizeLinks } from '@/lib/pm/schedule/links';
import { dragDays, finishDelta, moveStart, moveSummary, resizeDuration, snapWorkday } from '@/lib/pm/schedule/drag';
import { barX, dayAt, dayWindow, makeScale, rowWindow, ticks, xOf } from '@/lib/pm/schedule/timeline';
import { buildOutline, indentTarget, refResolver, visibleOutline } from '@/lib/pm/schedule/tree';
import { DEFAULT_PREFS, loadPrefs, parsePrefs, savePrefs } from '@/lib/pm/schedule/prefs';
import { parseDayInput, parseDurationInput, parsePctInput } from '@/lib/pm/schedule/dates';
import { exportFileName, scheduleCsv, scheduleMspXml } from '@/lib/pm/schedule/export';
import { isMissingEngine, toConstraint, toLoadCell, toLookahead, toReschedule, toTask } from '@/lib/pm/schedule/normalize';
import { defaultScheduleView, suggestTemplate, templatePhrase } from '@/lib/pm/schedule/views';
import { makeCalendar, offDaysIn, workdaysBetween } from '@/lib/pm/schedule/calendar';

const task = (id: string, over: Partial<SchedTask> = {}): SchedTask => ({
  id, job_id: 'J', parent_task_id: null, title: id, status: 'TODO', is_milestone: false, is_summary: false, sort: 0, wbs_code: null,
  duration_days: 2, start_on: '2026-11-02', due_on: '2026-11-03', pct_complete: null, constraint_type: 'ASAP', constraint_date: null,
  actual_start: null, actual_finish: null, early_start: null, early_finish: null, late_start: null, late_finish: null, total_float: null,
  free_float: null, is_critical: false, constraint_conflict: false, assignee_employee_id: null, assigned_crew_id: null, assigned_vendor_id: null,
  commitment_id: null, hours_per_day: null, template_ref: null, cpm_at: null, billing_amount_cents: null, ...over,
});

describe('predecessor text', () => {
  const rows = buildOutline([task('a', { sort: 0 }), task('b', { sort: 1 }), task('p', { sort: 2 }), task('c', { sort: 0, parent_task_id: 'p' })]);
  const resolve = refResolver(rows);

  it('parses several links with types and lags', () => {
    expect(parseLinks('1FS+2d, 2ss-1, 4', 'x', resolve)).toEqual({
      ok: true,
      links: [
        { pred_id: 'a', dep_type: 'FS', lag_days: 2 },
        { pred_id: 'b', dep_type: 'SS', lag_days: -1 },
        { pred_id: 'c', dep_type: 'FS', lag_days: 0 },
      ],
    });
  });
  it('accepts WBS codes, weeks and semicolons', () => {
    expect(parseLinks('3.1FF+1w; 1 SF', 'x', resolve)).toEqual({ ok: true, links: [{ pred_id: 'c', dep_type: 'FF', lag_days: 5 }, { pred_id: 'a', dep_type: 'SF', lag_days: 0 }] });
  });
  it('an empty cell clears the links', () => expect(parseLinks('  ', 'x', resolve)).toEqual({ ok: true, links: [] }));
  it('refuses bad syntax, unknown rows, self links, phases and duplicates with a sentence', () => {
    expect(parseLinks('1XX', 'x', resolve)).toMatchObject({ ok: false, error: expect.stringContaining('is not a link') });
    expect(parseLinks('9', 'x', resolve)).toMatchObject({ ok: false, error: 'There is no row 9 in this schedule.' });
    expect(parseLinks('1', 'a', resolve)).toMatchObject({ ok: false, error: expect.stringContaining('cannot follow itself') });
    expect(parseLinks('3', 'x', resolve)).toMatchObject({ ok: false, error: expect.stringContaining('is a phase') });
    expect(parseLinks('1, 1SS', 'x', resolve)).toMatchObject({ ok: false, error: expect.stringContaining('listed twice') });
  });
  it('keeps lags inside the guard’s bounds', () => {
    expect(tokenizeLinks(`1FS+${LAG_MAX + 1}d`)).toMatchObject({ ok: false });
    expect(tokenizeLinks(`1FS+${LAG_MAX}d`)).toMatchObject({ ok: true });
  });
  it('formats back the way it parses', () => {
    expect(formatLink('12', 'FS', 0)).toBe('12');
    expect(formatLink('12', 'SS', 0)).toBe('12SS');
    expect(formatLink('12', 'FS', 2)).toBe('12FS+2d');
    expect(formatLink('12', 'FF', -1)).toBe('12FF-1d');
    const deps: SchedDep[] = [{ pred_id: 'b', succ_id: 'x', dep_type: 'SS', lag_days: 1 }, { pred_id: 'a', succ_id: 'x', dep_type: 'FS', lag_days: 0 }];
    const no = new Map(rows.map((r) => [r.task.id, r.rowNo]));
    const text = formatLinks(deps, (id) => String(no.get(id)), (id) => no.get(id) ?? 0);
    expect(text).toBe('1, 2SS+1d');
    expect(parseLinks(text, 'x', resolve)).toMatchObject({ ok: true, links: [{ pred_id: 'a' }, { pred_id: 'b', dep_type: 'SS', lag_days: 1 }] });
  });
});

describe('drag math', () => {
  const ppd = 12;
  it('rounds to whole days and never returns -0', () => {
    expect(dragDays(5, ppd)).toBe(0);
    expect(Object.is(dragDays(-5, ppd), 0)).toBe(true);
    expect(dragDays(7, ppd)).toBe(1);
    expect(dragDays(-30, ppd)).toBe(-3);
  });
  it('a move snaps off the weekend in the direction of travel', () => {
    expect(moveStart(DEFAULT_CALENDAR, '2026-11-05', 2 * ppd, ppd)).toBe('2026-11-09'); // Thu + 2 = Sat → Mon
    expect(moveStart(DEFAULT_CALENDAR, '2026-11-09', -1 * ppd, ppd)).toBe('2026-11-06'); // Mon − 1 = Sun → Fri
    expect(moveStart(DEFAULT_CALENDAR, '2026-11-09', 3, ppd)).toBeNull();
    expect(snapWorkday(DEFAULT_CALENDAR, '2026-11-07', 1)).toBe('2026-11-09');
  });
  it('a resize counts working days and floors at one', () => {
    expect(resizeDuration(DEFAULT_CALENDAR, '2026-11-02', '2026-11-03', 3 * ppd, ppd)).toBe(5); // to Fri
    expect(resizeDuration(DEFAULT_CALENDAR, '2026-11-02', '2026-11-06', 2 * ppd, ppd)).toBeNull(); // into the weekend: still 5
    expect(resizeDuration(DEFAULT_CALENDAR, '2026-11-02', '2026-11-04', -10 * ppd, ppd)).toBe(1);
  });
  it('the toast says what moved and what the finish did', () => {
    expect(moveSummary('Moved', 9, 3)).toBe('Moved 9 tasks; finish +3 days');
    expect(moveSummary('Moved', 1, 0)).toBe('Moved 1 task; finish unchanged');
    expect(moveSummary('Resized', 2, -1)).toBe('Resized 2 tasks; finish −1 day');
    expect(finishDelta(DEFAULT_CALENDAR, '2026-11-06', '2026-11-11')).toBe(3);
  });
});

describe('virtualization windows', () => {
  it('draws only the rows in view plus overscan', () => {
    expect(rowWindow(0, 600, 28, 2000, 8)).toEqual({ start: 0, end: 31, offset: 0 });
    const w = rowWindow(28 * 1000, 600, 28, 2000, 8);
    expect(w.start).toBe(992);
    expect(w.end).toBe(1031);
    expect(w.offset).toBe(992 * 28);
    expect(rowWindow(28 * 1990, 600, 28, 2000).end).toBe(2000);
    expect(rowWindow(0, 600, 28, 0)).toEqual({ start: 0, end: 0, offset: 0 });
  });
  it('the row window stays the same size wherever you scroll (2,000 rows cost what 40 do)', () => {
    const sizes = [0, 5000, 20_000, 40_000].map((top) => {
      const w = rowWindow(top, 700, 28, 2000);
      return w.end - w.start;
    });
    expect(Math.max(...sizes)).toBeLessThanOrEqual(43);
  });
  it('day windows and scale are consistent', () => {
    const s = makeScale(['2026-11-04', '2027-03-01'], '2026-10-24', 'week');
    expect(new Date(s.origin * 86_400_000).getUTCDay()).toBe(1); // starts on a Monday
    expect(dayAt(s, xOf(s, '2026-12-01') + 1)).toBe('2026-12-01');
    const w = dayWindow(s, 1200, 800, 0);
    expect(w.to - w.from).toBe(Math.ceil(2000 / s.ppd) - Math.floor(1200 / s.ppd));
    expect(barX(s, '2026-11-02', '2026-11-06').w).toBe(5 * s.ppd);
    const t = ticks(s, 'week', w);
    expect(t.bottom.every((k) => k.major)).toBe(true);
  });
});

describe('outline', () => {
  const ts = [task('a', { sort: 0 }), task('p', { sort: 1 }), task('c1', { parent_task_id: 'p', sort: 0 }), task('c2', { parent_task_id: 'p', sort: 1 }), task('b', { sort: 2 })];
  const rows = buildOutline(ts);
  it('numbers rows and WBS in outline order', () => {
    expect(rows.map((r) => [r.task.id, r.rowNo, r.wbs, r.depth])).toEqual([
      ['a', 1, '1', 0], ['p', 2, '2', 0], ['c1', 3, '2.1', 1], ['c2', 4, '2.2', 1], ['b', 5, '3', 0],
    ]);
    expect(rows.find((r) => r.task.id === 'p')?.hasChildren).toBe(true);
  });
  it('collapses a phase', () => expect(visibleOutline(rows, new Set(['p'])).map((r) => r.task.id)).toEqual(['a', 'p', 'b']));
  it('Tab puts a row under the previous sibling; Shift-Tab lifts it out', () => {
    expect(indentTarget(rows, 'p', 'in')).toEqual({ parentId: 'a' });
    expect(indentTarget(rows, 'c2', 'in')).toEqual({ parentId: 'c1' });
    expect(indentTarget(rows, 'c1', 'in')).toBeNull();
    expect(indentTarget(rows, 'a', 'in')).toBeNull();
    expect(indentTarget(rows, 'c1', 'out')).toEqual({ parentId: null });
    expect(indentTarget(rows, 'b', 'out')).toBeNull();
  });
  it('survives a parent loop in bad data', () => {
    const bad = buildOutline([task('x', { parent_task_id: 'y' }), task('y', { parent_task_id: 'x' })]);
    expect(bad.map((r) => r.task.id).sort()).toEqual(['x', 'y']);
  });
});

describe('preferences', () => {
  it('drops malformed values', () => {
    expect(parsePrefs('{"zoom":"year","critical":"yes","gridWidth":99999,"views":{"j":"gantt","k":"pie"}}')).toEqual({ ...DEFAULT_PREFS, gridWidth: 1200, views: { j: 'gantt' } });
    expect(parsePrefs('not json')).toEqual({ ...DEFAULT_PREFS, views: {} });
    expect(parsePrefs(null).zoom).toBe('week');
  });
  it('storage that throws never breaks the page', () => {
    const g = globalThis as { window?: unknown };
    const before = g.window;
    g.window = { get localStorage(): Storage { throw new Error('blocked'); } };
    expect(loadPrefs('u1')).toEqual({ ...DEFAULT_PREFS, views: {} });
    expect(() => savePrefs('u1', DEFAULT_PREFS)).not.toThrow();
    const store = new Map<string, string>();
    g.window = { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) } };
    savePrefs('u1', { ...DEFAULT_PREFS, zoom: 'day' });
    expect(loadPrefs('u1').zoom).toBe('day');
    expect(loadPrefs('u2').zoom).toBe('week'); // per user
    g.window = before;
  });
});

describe('typed dates, days and percents', () => {
  const today = '2026-10-24';
  it('reads the usual ways people type a date', () => {
    expect(parseDayInput('2026-11-18', today)).toBe('2026-11-18');
    expect(parseDayInput('11/18', today)).toBe('2026-11-18');
    expect(parseDayInput('1/4', today)).toBe('2027-01-04'); // nearest
    expect(parseDayInput('11/18/27', today)).toBe('2027-11-18');
    expect(parseDayInput('Nov 18', today)).toBe('2026-11-18');
    expect(parseDayInput('18 nov 2026', today)).toBe('2026-11-18');
    expect(parseDayInput('2/30', today)).toBeNull();
    expect(parseDayInput('soon', today)).toBeNull();
  });
  it('durations and percents', () => {
    expect(parseDurationInput('5')).toBe(5);
    expect(parseDurationInput('2w')).toBe(10);
    expect(parseDurationInput('3 days')).toBe(3);
    expect(parseDurationInput('x')).toBeNull();
    expect(parsePctInput('40')).toBe(0.4);
    expect(parsePctInput('40%')).toBe(0.4);
    expect(parsePctInput('0.25')).toBe(0.25);
    expect(parsePctInput('140')).toBeNull();
  });
});

describe('calendar', () => {
  const cal = makeCalendar({ id: 'c', name: 'Crew', workdays: [1, 2, 3, 4, 5], hours_per_day: 8 }, [{ day: '2026-11-26', is_workday: false, name: 'Thanksgiving' }, { day: '2026-11-28', is_workday: true }]);
  it('shades weekends and holidays, names the holiday, honours an extra working Saturday', () => {
    const off = offDaysIn(cal, '2026-11-23', '2026-11-29');
    expect(off).toEqual([{ day: '2026-11-26', holiday: true, name: 'Thanksgiving' }, { day: '2026-11-29', holiday: false, name: null }]);
    expect(workdaysBetween(cal, '2026-11-25', '2026-11-30')).toBe(3); // Fri, Sat (extra), Mon
  });
});

describe('export', () => {
  const ts = [task('a', { title: '=HYPERLINK("x")', billing_amount_cents: 125_000 }), task('b', { title: 'Frame, walls', sort: 1, is_critical: true })];
  const rows = buildOutline(ts);
  const deps: SchedDep[] = [{ pred_id: 'a', succ_id: 'b', dep_type: 'FS', lag_days: 2 }];
  const base = { jobLabel: '1042 Smith kitchen', rows, deps, crewName: () => null };

  it('CSV quotes, neutralises formulas and links by row number', () => {
    const csv = scheduleCsv({ ...base, includeBilling: false });
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain('"Frame, walls"');
    expect(csv).toContain('1FS+2d');
    expect(csv).not.toContain('Billing amount');
    expect(csv).not.toContain('1250.00');
  });
  it('billing amounts only with the capability', () => {
    const csv = scheduleCsv({ ...base, includeBilling: true });
    expect(csv).toContain('Billing amount');
    expect(csv).toContain('1250.00');
  });
  it('Microsoft Project XML carries tasks, outline and links', () => {
    const xml = scheduleMspXml({ ...base, includeBilling: false, calendar: DEFAULT_CALENDAR, start: '2026-11-02' });
    expect(xml).toContain('<Project xmlns="http://schemas.microsoft.com/project">');
    expect(xml).toContain('<Name>Frame, walls</Name>');
    expect(xml).toContain('<PredecessorLink><PredecessorUID>1</PredecessorUID><Type>1</Type><LinkLag>9600</LinkLag>');
    expect(xml).toContain('&quot;x&quot;');
    expect(exportFileName('1042 Smith kitchen', 'csv')).toBe('1042-smith-kitchen-schedule.csv');
  });
});

describe('1112 normalisers', () => {
  it('reads a task row and fills safe defaults', () => {
    const t = toTask({ id: 't', job_id: 'j', title: 'Frame', status: 'WEIRD', constraint_type: 'NOPE', total_float: '3', pct_complete: 0.5, start_on: '2026-11-02T00:00:00' });
    expect(t).toMatchObject({ status: 'TODO', constraint_type: 'ASAP', total_float: 3, pct_complete: 0.5, start_on: '2026-11-02', billing_amount_cents: null });
    expect(toTask({ title: 'no id' })).toBeNull();
  });
  it('reads reschedule results', () => {
    expect(toReschedule({ changed: [{ id: 'a', start_on: '2026-11-03', due_on: '2026-11-04', total_float: 0 }], finish_before: '2026-11-10', finish_after: '2026-11-13', moved_count: 9 })).toEqual({
      changed: [{ id: 'a', start_on: '2026-11-03', due_on: '2026-11-04', total_float: 0 }], finish_before: '2026-11-10', finish_after: '2026-11-13', moved_count: 9,
    });
    expect(toReschedule(null)).toEqual({ changed: [], finish_before: null, finish_after: null, moved_count: 0 });
  });
  it('words constraint reasons for the look-ahead', () => {
    expect(toConstraint('submittal_not_approved')).toEqual({ kind: 'submittal', label: 'Submittal not approved' });
    expect(toConstraint({ kind: 'MATERIAL', label: 'Cabinets arrive Nov 20' })).toEqual({ kind: 'material', label: 'Cabinets arrive Nov 20' });
    expect(toConstraint('predecessor_open')).toEqual({ kind: 'predecessor', label: 'Predecessor not done' });
    expect(toLookahead({ task_id: 't', job_id: 'j', title: 'Set cabinets', constraints: ['material_not_received', 'predecessor_not_done'] })?.constraints).toHaveLength(2);
  });
  it('reads resource load cells', () => {
    expect(toLoadCell({ crew_id: 'c', crew_name: 'Crew A', day: '2026-11-02', hours: 10, capacity_minutes: 480 })).toMatchObject({ resource_kind: 'crew', hours: 10, capacity_hours: 8 });
  });
  it('knows a missing engine from a real error', () => {
    expect(isMissingEngine({ code: '42P01' })).toBe(true);
    expect(isMissingEngine({ code: 'PGRST202' })).toBe(true);
    expect(isMissingEngine({ code: '42501' })).toBe(false);
  });
});

describe('default views and templates', () => {
  it('project-shaped work opens on the Gantt, visit-shaped work on the list', () => {
    for (const a of ['project', 'development', 'eto', 'engagement']) expect(defaultScheduleView(a)).toBe('gantt');
    for (const a of ['field_service', 'recurring_service', 'dealer_service', 'retail_order', null]) expect(defaultScheduleView(a)).toBe('list');
  });
  it('offers the template made for the job type', () => {
    const tpls = [
      { id: '1', name: 'Custom home', description: null, task_count: 120, job_type_keys: [] },
      { id: '2', name: 'Kitchen remodel', description: null, task_count: 38, job_type_keys: [] },
      { id: '3', name: 'Bath remodel', description: null, task_count: 30, job_type_keys: ['bath'] },
    ];
    expect(suggestTemplate(tpls, 'kitchen_remodel', 'Kitchen remodel')?.id).toBe('2');
    expect(suggestTemplate(tpls, 'bath', 'Bath')?.id).toBe('3');
    expect(suggestTemplate([], 'x', null)).toBeNull();
    expect(templatePhrase('Kitchen remodel')).toBe('the Kitchen remodel template');
    expect(templatePhrase('HVAC install template')).toBe('the HVAC install template');
  });
});
