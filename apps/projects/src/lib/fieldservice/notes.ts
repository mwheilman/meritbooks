/**
 * Voice note → structured visit notes (FS-31), rules only until the AI gateway is switched on.
 * The tech talks; the phone's speech-to-text gives a transcript; these rules sort each sentence
 * into diagnosis, work performed or recommendations, pull readings the forms can pre-fill, and
 * write a plain customer summary. Photo captions get simple tags (FS-30). Pure; unit-tested.
 * The result is saved with structured_by = 'RULES' (pm.fs_save_visit_note) so an AI pass later
 * can be told apart.
 */

export interface StructuredNote {
  diagnosis: string | null;
  work_performed: string | null;
  recommendations: string | null;
  customer_summary: string | null;
  readings: Record<string, number>;
}

const RECOMMEND = /\b(recommend|recommended|suggest|should|consider|advise|advised|needs? to be replaced|will need|next visit|quote|replacement|upgrade)\b/i;
const WORK = /\b(replaced|installed|cleaned|tested|repaired|adjusted|tightened|flushed|charged|added|reset|cleared|unclogged|snaked|swapped|programmed|calibrated|lubricated|changed|checked|verified|sealed|rewired|mounted|drained|primed)\b/i;
const FOUND = /\b(found|noticed|diagnosed|observed|measured|reading|readings|failing|failed|cracked|leaking|leak|low|weak|dirty|clogged|broken|burnt|burned|shorted|tripped|corroded|worn|bad|no power|not working|frozen|iced)\b/i;

/** Sentence split that keeps decimals ("3.2 inches") intact. */
export function sentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])|;\s+|\s+(?:and then|then)\s+/i)
    .map((s) => s.trim().replace(/^[,.\s]+|[,\s]+$/g, ''))
    .filter((s) => s.length > 1);
}

const READING_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  ['superheat', /superheat(?:\s+(?:of|was|is|at))?\s+(-?\d+(?:\.\d+)?)/i],
  ['subcool', /sub-?cool(?:ing)?(?:\s+(?:of|was|is|at))?\s+(-?\d+(?:\.\d+)?)/i],
  ['static_pressure', /static(?:\s+pressure)?(?:\s+(?:of|was|is|at))?\s+(\d+(?:\.\d+)?)/i],
  ['temp_split', /(?:temp(?:erature)?\s+split|delta\s*t)(?:\s+(?:of|was|is|at))?\s+(\d+(?:\.\d+)?)/i],
  ['compressor_amps', /(?:compressor\s+)?amp(?:s|erage|\s+draw)?(?:\s+(?:of|was|is|at))?\s+(\d+(?:\.\d+)?)/i],
  ['co_ambient_ppm', /(?:ambient\s+)?co(?:\s+(?:in the house|ambient))?(?:\s+(?:of|was|is|at))?\s+(\d+(?:\.\d+)?)\s*(?:ppm|parts)/i],
  ['temp_rise', /temp(?:erature)?\s+rise(?:\s+(?:of|was|is|at))?\s+(\d+(?:\.\d+)?)/i],
];

export function extractReadings(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, re] of READING_PATTERNS) {
    const m = text.match(re);
    if (m?.[1] != null) {
      const v = Number(m[1]);
      if (Number.isFinite(v)) out[key] = v;
    }
  }
  return out;
}

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const join = (xs: string[]) => (xs.length ? xs.map((x) => cap(x.replace(/[.!?]+$/, ''))).join('. ') + '.' : null);

/** Plain words for the customer: "we" voice, no jargon readings. */
function forCustomer(diag: string[], work: string[], recs: string[]): string | null {
  const strip = (s: string) => s.replace(/\b(superheat|subcool(?:ing)?|static(?: pressure)?|amp(?:s| draw)?|delta t)\b[^,.;]*/gi, '').replace(/\s{2,}/g, ' ').trim();
  const parts: string[] = [];
  const w = work.map(strip).filter(Boolean);
  const d = diag.map(strip).filter(Boolean);
  const r = recs.map(strip).filter(Boolean);
  if (d.length) parts.push(`What we found: ${d.map((x) => x.replace(/^(i |we )?(found|noticed|diagnosed|observed) (that )?/i, '')).join('; ')}.`);
  if (w.length) parts.push(`What we did: ${w.map((x) => x.replace(/^(i |we )/i, '')).join('; ')}.`);
  if (r.length) parts.push(`What we recommend: ${r.map((x) => x.replace(/^(i |we )?(would )?(recommend|suggest)(ed)? (that )?/i, '')).join('; ')}.`);
  return parts.length ? parts.join(' ').replace(/\.\./g, '.') : null;
}

export function structureNote(transcript: string): StructuredNote {
  const diag: string[] = [];
  const work: string[] = [];
  const recs: string[] = [];
  for (const s of sentences(transcript)) {
    if (RECOMMEND.test(s)) recs.push(s);
    else if (WORK.test(s) && !/\b(found|noticed)\b/i.test(s)) work.push(s);
    else if (FOUND.test(s)) diag.push(s);
    else diag.push(s);
  }
  return {
    diagnosis: join(diag),
    work_performed: join(work),
    recommendations: join(recs),
    customer_summary: forCustomer(diag, work, recs),
    readings: extractReadings(transcript),
  };
}

const PHOTO_TAGS: ReadonlyArray<[string, RegExp]> = [
  ['nameplate', /\b(name ?plate|data ?plate|rating plate|serial|model)\b/i],
  ['filter', /\bfilter\b/i],
  ['panel', /\b(panel|breaker|disconnect)\b/i],
  ['leak', /\b(leak|oil|drip|water|rust)\b/i],
  ['coil', /\bcoil\b/i],
  ['before', /\bbefore\b/i],
  ['after', /\b(after|finished|done)\b/i],
  ['damage', /\b(crack|damage|burn|scorch|melt)\b/i],
];

export function tagPhoto(caption: string | null | undefined): string[] {
  const c = caption ?? '';
  return PHOTO_TAGS.filter(([, re]) => re.test(c)).map(([t]) => t);
}
