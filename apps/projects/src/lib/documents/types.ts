/**
 * Documents & drawings vocabulary shared by routes, server queries and client views.
 * Mirrors the CHECK lists of migration 1115 (a test asserts the lists match the SQL).
 */
import { z } from 'zod';

export const DOC_KINDS = [
  'file', 'photo', 'drawing_set', 'spec', 'contract', 'proposal', 'change_order', 'pay_app', 'draw_request',
  'lien_waiver', 'work_order', 'daily_report', 'install_ticket', 'po', 'subcontract', 'buyers_order', 'permit',
  'submittal', 'rfi', 'warranty', 'manual', 'form', 'inspection', 'closeout', 'correspondence', 'other',
] as const;
export type DocKind = (typeof DOC_KINDS)[number];

export const MONEY_CAPS = ['projects.contract_value', 'projects.financials'] as const;
export type MoneyCap = (typeof MONEY_CAPS)[number];

export const RETENTION_CLASSES = ['standard', 'project_record', 'contract', 'financial', 'safety', 'permanent'] as const;
export type RetentionClass = (typeof RETENTION_CLASSES)[number];

export const SET_KINDS = ['bid', 'permit', 'ifc', 'asi', 'bulletin', 'addendum', 'record', 'shop', 'other'] as const;
export type SetKind = (typeof SET_KINDS)[number];

export const MARKUP_KINDS = ['pin', 'rect', 'cloud', 'arrow', 'freehand', 'text'] as const;
export type MarkupKind = (typeof MARKUP_KINDS)[number];

export const KIND_LABEL: Readonly<Record<DocKind, string>> = {
  file: 'File', photo: 'Photo', drawing_set: 'Drawing set', spec: 'Specification', contract: 'Contract', proposal: 'Proposal',
  change_order: 'Change order', pay_app: 'Pay application', draw_request: 'Draw request', lien_waiver: 'Lien waiver',
  work_order: 'Work order', daily_report: 'Daily report', install_ticket: 'Install ticket', po: 'Purchase order',
  subcontract: 'Subcontract', buyers_order: "Buyer's order", permit: 'Permit', submittal: 'Submittal', rfi: 'RFI',
  warranty: 'Warranty', manual: 'Manual', form: 'Form', inspection: 'Inspection', closeout: 'Closeout', correspondence: 'Correspondence',
  other: 'Other',
};

export const RETENTION_LABEL: Readonly<Record<RetentionClass, string>> = {
  standard: 'Standard (3 years)', project_record: 'Project record (10 years)', contract: 'Contract (10 years)',
  financial: 'Financial (7 years)', safety: 'Safety (30 years)', permanent: 'Permanent',
};

export const SET_KIND_LABEL: Readonly<Record<SetKind, string>> = {
  bid: 'Bid set', permit: 'Permit set', ifc: 'Issued for construction', asi: 'ASI', bulletin: 'Bulletin', addendum: 'Addendum',
  record: 'Record set', shop: 'Shop drawings', other: 'Other',
};

/** Same rule as pm.doc_kind_money_cap. */
export function kindMoneyCap(kind: DocKind): MoneyCap | null {
  if (['contract', 'proposal', 'change_order', 'pay_app', 'draw_request', 'buyers_order'].includes(kind)) return 'projects.contract_value';
  if (['po', 'subcontract', 'lien_waiver'].includes(kind)) return 'projects.financials';
  return null;
}

export interface FolderRow {
  id: string;
  job_id: string;
  parent_id: string | null;
  key: string | null;
  name: string;
  sort: number;
  money_cap: MoneyCap | null;
  kinds: string[];
}

export interface FileRow {
  id: string;
  location_id: string;
  job_id: string | null;
  folder_id: string | null;
  title: string;
  kind: DocKind;
  money_cap: MoneyCap | null;
  /** 1118: portal audiences the document is shared with (pm.portal_share_document). */
  portal_audiences?: Array<'customer' | 'vendor' | 'lender' | 'investor'> | null;
  description: string | null;
  tags: string[];
  subject_table: string | null;
  subject_id: string | null;
  current_version_id: string | null;
  version_count: number;
  retention_class: RetentionClass;
  retain_until: string | null;
  legal_hold: boolean;
  legal_hold_reason: string | null;
  legal_hold_at: string | null;
  status: 'active' | 'archived' | 'deleted';
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface VersionRow {
  id: string;
  file_id: string;
  version_no: number;
  document_id: string;
  file_name: string;
  mime_type: string | null;
  size_bytes: number | null;
  content_sha256: string | null;
  page_count: number | null;
  label: string | null;
  note: string | null;
  source: 'upload' | 'template' | 'esign' | 'drawing_split' | 'restore' | 'import';
  is_current: boolean;
  superseded_at: string | null;
  locked: boolean;
  meta: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
}

export interface PhotoMetaRow {
  document_id: string;
  taken_at: string | null;
  taken_at_source: 'exif' | 'device' | 'none';
  gps_lat: number | null;
  gps_lng: number | null;
  device_make: string | null;
  device_model: string | null;
  received_at: string;
  area: string | null;
}

export interface DrawingSetRow {
  id: string;
  job_id: string;
  name: string;
  set_kind: SetKind;
  issued_on: string | null;
  source_file_id: string | null;
  page_count: number;
  sheet_count: number;
  status: 'review' | 'published';
  published_at: string | null;
  created_at: string;
}

export interface DrawingSheetRow {
  id: string;
  job_id: string;
  sheet_number: string;
  title: string | null;
  discipline: string | null;
  current_revision_id: string | null;
  revision_count: number;
  updated_at: string;
}

export interface DrawingRevisionRow {
  id: string;
  job_id: string;
  sheet_id: string;
  set_id: string;
  document_id: string;
  page_index: number;
  title: string | null;
  revision_label: string | null;
  width_pt: number | null;
  height_pt: number | null;
  extraction: 'text' | 'manual' | 'none';
  confidence: number | null;
  status: 'review' | 'published';
  is_current: boolean;
  created_at: string;
}

// ------------------------------------------------------------------ markups

const unit = z.number().min(0).max(1);
const point = z.object({ x: unit, y: unit });
export const MarkupGeometry = {
  pin: point,
  text: point.extend({ size: z.number().min(0.005).max(0.2).optional() }),
  rect: z.object({ x: unit, y: unit, w: unit, h: unit }),
  cloud: z.object({ x: unit, y: unit, w: unit, h: unit }),
  arrow: z.object({ x1: unit, y1: unit, x2: unit, y2: unit }),
  freehand: z.object({ points: z.array(z.tuple([unit, unit])).min(2).max(2000) }),
} as const;

export const MarkupStyle = z.object({
  color: z.enum(['electric', 'neg', 'warn', 'ink', 'pos']).default('neg'),
  width: z.number().min(0.5).max(8).default(2),
}).partial();

export const MarkupInput = z.object({
  kind: z.enum(MARKUP_KINDS),
  geometry: z.unknown(),
  style: MarkupStyle.optional(),
  body: z.string().trim().max(2000).optional().nullable(),
  visibility: z.enum(['personal', 'published']).default('personal'),
  linkTable: z.enum(['punch_items', 'tasks', 'rfis', 'photos', 'doc_files', 'change_orders']).optional().nullable(),
  linkId: z.string().uuid().optional().nullable(),
}).superRefine((v, ctx) => {
  if (!MarkupGeometry[v.kind].safeParse(v.geometry).success) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['geometry'], message: `Not a valid ${v.kind} shape.` });
  }
  if (v.kind === 'text' && !v.body) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['body'], message: 'Type the note.' });
});
export type MarkupInputT = z.infer<typeof MarkupInput>;

export interface MarkupRow {
  id: string;
  revision_id: string;
  sheet_id: string;
  author_user: string;
  visibility: 'personal' | 'published';
  kind: MarkupKind;
  geometry: Record<string, unknown>;
  style: Record<string, unknown>;
  body: string | null;
  link_table: string | null;
  link_id: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Validate one markup's geometry for its kind (client and server). */
export function parseGeometry(kind: MarkupKind, g: unknown): Record<string, unknown> | null {
  const r = MarkupGeometry[kind].safeParse(g);
  return r.success ? (r.data as Record<string, unknown>) : null;
}
