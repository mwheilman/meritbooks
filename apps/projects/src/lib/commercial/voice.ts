/**
 * Voice-to-daily-log hook (CGC-71), deterministic first pass. The superintendent talks; this
 * proposes entries (manpower by company, deliveries, delays, inspections, equipment, work done)
 * that the super reviews before pm.cm_daily_log_apply_voice writes them. An AI extractor can
 * replace `parseTranscript` behind the same output shape. English and Spanish keywords. Pure.
 */

export type VoiceKind = 'MANPOWER' | 'DELIVERY' | 'DELAY' | 'INSPECTION' | 'EQUIPMENT' | 'SAFETY' | 'WORK_SUMMARY';
export type DelayCause = 'WEATHER' | 'OWNER' | 'DESIGN' | 'SUB' | 'MATERIAL' | 'INSPECTION' | 'LABOR' | 'ACCESS' | 'OTHER';

export interface DirectoryCompany {
  vendorId: string | null;
  name: string;
  trade?: string | null;
}

export interface ProposedEntry {
  kind: VoiceKind;
  company_name?: string;
  vendor_id?: string | null;
  trade?: string;
  headcount?: number;
  hours?: number;
  supplier?: string;
  equipment?: string;
  description: string;
  cause?: DelayCause;
  duration_hours?: number;
  result?: 'PASS' | 'FAIL' | 'PARTIAL';
  /** The sentence it came from (shown in review). */
  source: string;
  confidence: number;
}

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20,
  uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, doce: 12, quince: 15, veinte: 20,
};

const TRADE_WORDS: ReadonlyArray<[RegExp, string]> = [
  [/electric(ian|ians|al)?|electricistas?/i, 'Electrical'],
  [/plumb(er|ers|ing)|plomeros?/i, 'Plumbing'],
  [/pipefitters?|fitters?|hvac|mechanical|tuberos?/i, 'Mechanical'],
  [/drywall|tapers?|framers?|tablaroca/i, 'Drywall'],
  [/carpenters?|carpinteros?/i, 'Carpentry'],
  [/laborers?|obreros?|ayudantes?/i, 'Labor'],
  [/iron ?workers?|steel|herreros?/i, 'Steel'],
  [/concrete|finishers?|concreto/i, 'Concrete'],
  [/painters?|pintores?/i, 'Painting'],
  [/roofers?|techadores?/i, 'Roofing'],
  [/masons?|alba[nñ]iles?/i, 'Masonry'],
];

const CAUSES: ReadonlyArray<[RegExp, DelayCause]> = [
  [/rain|snow|wind|storm|weather|lluvia|viento|clima/i, 'WEATHER'],
  [/inspect(or|ion)|inspecci[oó]n/i, 'INSPECTION'],
  [/material|delivery|shipment|entrega/i, 'MATERIAL'],
  [/owner|due[nñ]o|propietario/i, 'OWNER'],
  [/drawing|design|rfi|architect|dise[nñ]o|plano/i, 'DESIGN'],
  [/access|blocked|acceso/i, 'ACCESS'],
  [/crew|short.?handed|labor|no.?show|personal/i, 'LABOR'],
];

function toNumber(s: string): number | null {
  const n = Number(s.replace(',', '.'));
  if (Number.isFinite(n)) return n;
  return NUMBER_WORDS[s.toLowerCase()] ?? null;
}

function sentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?;])\s+|\s+(?:and then|then|y luego|luego)\s+/i)
    .map((s) => s.trim().replace(/[.!?;]+$/, ''))
    .filter((s) => s.length > 2);
}

function matchCompany(s: string, dir: ReadonlyArray<DirectoryCompany>): DirectoryCompany | null {
  const lower = s.toLowerCase();
  let best: DirectoryCompany | null = null;
  for (const c of dir) {
    const first = c.name.toLowerCase().split(/\s+/)[0] ?? '';
    if (lower.includes(c.name.toLowerCase()) || (first.length >= 4 && lower.includes(first))) {
      if (!best || c.name.length > best.name.length) best = c;
    }
  }
  return best;
}

const NUM = '(\\d+(?:[.,]\\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|doce|quince|veinte)';

export function parseTranscript(text: string, directory: ReadonlyArray<DirectoryCompany> = []): ProposedEntry[] {
  const out: ProposedEntry[] = [];
  const work: string[] = [];
  for (const s of sentences(text)) {
    let used = false;
    // manpower: "5 electricians from Acme", "Acme had 6 guys for 8 hours", "4 plomeros de Rivera"
    const headRe = new RegExp(`${NUM}\\s+(?:guys|men|workers|people|hands|trabajadores|personas|hombres|[a-zñ]+)`, 'i');
    const head = s.match(headRe);
    const trade = TRADE_WORDS.find(([re]) => re.test(s));
    const company = matchCompany(s, directory);
    if (head && (trade || company || /guys|men|workers|crew|people|trabajadores|personas|cuadrilla/i.test(s))) {
      const n = toNumber(head[1]!);
      const hrs = s.match(new RegExp(`${NUM}\\s*(?:hours|hrs|horas)`, 'i'));
      if (n !== null && n > 0 && n < 500) {
        out.push({
          kind: 'MANPOWER', headcount: Math.round(n), hours: hrs ? (toNumber(hrs[1]!) ?? undefined) : undefined,
          company_name: company?.name ?? (s.match(/(?:from|with|de|con)\s+([A-Z][\w&'.-]*(?:\s+[A-Z][\w&'.-]*)*)/)?.[1] ?? undefined),
          vendor_id: company?.vendorId ?? null, trade: trade?.[1] ?? company?.trade ?? undefined,
          description: s, source: s, confidence: company ? 0.9 : 0.7,
        });
        used = true;
      }
    }
    // deliveries
    if (/\b(delivered|delivery|received|arrived|showed up|entregaron|lleg[oó])\b/i.test(s)) {
      const supplier = matchCompany(s, directory)?.name ?? s.match(/(?:from|by|de)\s+([A-Z][\w&'.-]*(?:\s+[A-Z][\w&'.-]*)*)/)?.[1];
      out.push({ kind: 'DELIVERY', supplier: supplier ?? undefined, description: s, source: s, confidence: supplier ? 0.85 : 0.6 });
      used = true;
    }
    // delays
    let delayed = false;
    if (/\b(delay|delayed|waited|waiting|lost|shut down|stopped|rained out|retraso|esperamos|paramos)\b/i.test(s)) {
      const cause = CAUSES.find(([re]) => re.test(s))?.[1] ?? 'OTHER';
      const hrs = s.match(new RegExp(`${NUM}\\s*(?:hours|hrs|horas)`, 'i'));
      const half = /half (?:a |the )?day|medio d[ií]a/i.test(s) ? 4 : /all day|whole day|todo el d[ií]a/i.test(s) ? 8 : null;
      out.push({ kind: 'DELAY', cause, duration_hours: hrs ? (toNumber(hrs[1]!) ?? undefined) : half ?? undefined, description: s, source: s, confidence: 0.75 });
      used = true;
      delayed = true;
    }
    // inspections
    if (/\binspect(ion|or|ed)\b|inspecci[oó]n/i.test(s)) {
      const result = /\b(fail|failed|rejected|reprob|no pas)/i.test(s) ? 'FAIL' : /\b(pass|passed|approved|aprob|pas[oó])/i.test(s) ? 'PASS' : undefined;
      // "waited 2 hours on the inspector" is a delay, not an inspection result
      if (!(delayed && result === undefined)) out.push({ kind: 'INSPECTION', result, description: s, source: s, confidence: result ? 0.85 : 0.6 });
      used = true;
    }
    // equipment on site
    const eq = s.match(/\b(scissor ?lift|boom ?lift|forklift|telehandler|excavator|crane|skid ?steer|generator|lull|montacargas|gr[uú]a)\b/i);
    if (eq) {
      const hrs = s.match(new RegExp(`${NUM}\\s*(?:hours|hrs|horas)`, 'i'));
      out.push({ kind: 'EQUIPMENT', equipment: eq[1]!.toLowerCase(), hours: hrs ? (toNumber(hrs[1]!) ?? undefined) : undefined, description: s, source: s, confidence: 0.7 });
      used = true;
    }
    if (/\b(near miss|injur|hurt|first aid|incident|accidente|lesi[oó]n|casi accidente)\b/i.test(s)) {
      out.push({ kind: 'SAFETY', description: s, source: s, confidence: 0.8 });
      used = true;
    }
    if (!used) work.push(s);
  }
  if (work.length) out.push({ kind: 'WORK_SUMMARY', description: work.join('. ') + '.', source: work.join(' '), confidence: 0.5 });
  return out;
}
