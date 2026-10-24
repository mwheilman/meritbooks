/**
 * Duplicate review and merge (SHARED-RECORDS §4). Pure and client-safe: which fields the person
 * chooses between, the default choice, and the plain summary of what moves. The merge itself is
 * core.merge_parties (repoints every reference in every schema, keeps posted Books amounts and
 * dates, soft-archives the other record with merged_into, audits before/after).
 */

export type PartyKind = 'customer' | 'vendor' | 'contact';

export interface MergeField {
  key: string;
  label: string;
}

/** Identity fields only. Terms, credit and tax stay with Merit Books (Books picks on a conflict). */
export const MERGE_FIELDS: Readonly<Record<PartyKind, ReadonlyArray<MergeField>>> = {
  customer: [
    { key: 'name', label: 'Name' }, { key: 'email', label: 'Email' }, { key: 'phone', label: 'Phone' },
    { key: 'address_line1', label: 'Street' }, { key: 'city', label: 'City' }, { key: 'state', label: 'State' }, { key: 'zip', label: 'ZIP' },
  ],
  vendor: [{ key: 'name', label: 'Name' }, { key: 'email', label: 'Email' }, { key: 'phone', label: 'Phone' }, { key: 'city', label: 'City' }],
  contact: [
    { key: 'first_name', label: 'First name' }, { key: 'last_name', label: 'Last name' }, { key: 'email', label: 'Email' },
    { key: 'phone', label: 'Phone' }, { key: 'title', label: 'Title' },
  ],
};

export const KIND_WORDS: Readonly<Record<PartyKind, { one: string; many: string }>> = {
  customer: { one: 'customer', many: 'customers' },
  vendor: { one: 'vendor', many: 'vendors' },
  contact: { one: 'contact', many: 'contacts' },
};

export interface PartyRecord {
  id: string;
  name: string;
  fields: Readonly<Record<string, string | null>>;
  createdAt: string | null;
  /** First used in Merit Books, when known. */
  booksSince: string | null;
}

export type Side = 'survivor' | 'victim';
export type Choices = Record<string, Side>;

/** Keep the record Books has used longest, else the older one. */
export function suggestSurvivor(a: PartyRecord, b: PartyRecord): PartyRecord {
  if (a.booksSince && !b.booksSince) return a;
  if (b.booksSince && !a.booksSince) return b;
  if (a.booksSince && b.booksSince) return a.booksSince <= b.booksSince ? a : b;
  return (a.createdAt ?? '') <= (b.createdAt ?? '') ? a : b;
}

function blank(v: string | null | undefined): boolean {
  return v == null || v.trim() === '';
}

/** Per field: the survivor's value, unless it is empty and the other record has one. */
export function defaultChoices(kind: PartyKind, survivor: PartyRecord, victim: PartyRecord): Choices {
  const out: Choices = {};
  for (const f of MERGE_FIELDS[kind]) out[f.key] = blank(survivor.fields[f.key]) && !blank(victim.fields[f.key]) ? 'victim' : 'survivor';
  return out;
}

/** Fields whose two values differ (the only ones worth a choice). */
export function differingFields(kind: PartyKind, a: PartyRecord, b: PartyRecord): MergeField[] {
  const k = (v: string | null | undefined) => (v ?? '').trim().toLowerCase();
  return MERGE_FIELDS[kind].filter((f) => k(a.fields[f.key]) !== k(b.fields[f.key]));
}

/** The merged identity the survivor ends up with. */
export function mergedValues(kind: PartyKind, survivor: PartyRecord, victim: PartyRecord, choices: Choices): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const f of MERGE_FIELDS[kind]) out[f.key] = (choices[f.key] === 'victim' ? victim : survivor).fields[f.key] ?? null;
  return out;
}

/** References that move from the archived record to the kept one. */
export interface MoveCounts {
  contacts?: number;
  sites?: number;
  leads?: number;
  jobs?: number;
  estimates?: number;
  activities?: number;
  commitments?: number;
}

const MOVE_WORDS: ReadonlyArray<[keyof MoveCounts, string, string]> = [
  ['jobs', 'job', 'jobs'], ['estimates', 'estimate', 'estimates'], ['leads', 'lead', 'leads'], ['contacts', 'contact', 'contacts'],
  ['sites', 'site', 'sites'], ['commitments', 'commitment', 'commitments'], ['activities', 'logged activity', 'logged activities'],
];

export function moveList(m: MoveCounts): string[] {
  return MOVE_WORDS.flatMap(([k, one, many]) => {
    const n = m[k] ?? 0;
    return n > 0 ? [`${n.toLocaleString('en-US')} ${n === 1 ? one : many}`] : [];
  });
}

/** Plain summary shown before the merge is confirmed. */
export function mergeSummary(kind: PartyKind, survivor: PartyRecord, victim: PartyRecord, moves: MoveCounts): string[] {
  const w = KIND_WORDS[kind].one;
  const list = moveList(moves);
  return [
    `${survivor.name} is kept. ${victim.name} is archived and points to it, so old links still open.`,
    list.length ? `Moves to ${survivor.name}: ${list.join(', ')}.` : `Nothing in Merit Projects points to ${victim.name} yet.`,
    kind === 'contact'
      ? 'Leads and activities that name this person follow the kept contact.'
      : `Merit Books records for ${victim.name} (invoices, payments${kind === 'vendor' ? ', bills' : ''}) are repointed to ${survivor.name}; no amount or date changes.`,
    `Every change is written to the audit log. This ${w} merge can’t be undone from here.`,
  ];
}

/** core.merge_parties' p_field_choices: every identity field with the side whose value is kept. */
export function choicesPayload(kind: PartyKind, choices: Choices): Choices {
  return Object.fromEntries(MERGE_FIELDS[kind].map((f) => [f.key, choices[f.key] === 'victim' ? 'victim' : 'survivor'])) as Choices;
}
