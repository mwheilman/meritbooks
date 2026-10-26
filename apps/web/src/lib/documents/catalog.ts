/**
 * THE document-type catalog (PURE, client-safe) — the one list every Documents surface reads:
 * the upload "Type" picker, the "Filter by type" picker, the side panel's "Change type" picker,
 * and the row's type label.
 *
 * The vocabulary is the document-intelligence class (migration 188 `doc_class`, 20 values).
 * Each class also names its coarse `public.documents.doc_type` bucket (migration 090 CHECK,
 * 10 values) — that bucket is a storage detail, never a second list a person picks from.
 */

import {
  CLASS_TO_DOC_TYPE,
  DOC_CLASSES,
  DOC_CLASS_LABEL,
  isDocClass,
  type DocClass,
  type DocumentsDocType,
} from './intelligence/types';

export interface DocumentTypeOption {
  value: DocClass;
  label: string;
  /** The coarse documents.doc_type the file is stored under. */
  docType: DocumentsDocType;
}

/** Every type, in a person-friendly order (alphabetical by label, "Other" last). */
export const DOCUMENT_TYPES: readonly DocumentTypeOption[] = [...DOC_CLASSES]
  .map((value) => ({ value, label: DOC_CLASS_LABEL[value], docType: CLASS_TO_DOC_TYPE[value] }))
  .sort((a, b) => (a.value === 'other' ? 1 : b.value === 'other' ? -1 : a.label.localeCompare(b.label)));

/** What a person can choose on upload ("Other" is what "Work it out for me" falls back to). */
export const UPLOAD_DOCUMENT_TYPES: readonly DocumentTypeOption[] = DOCUMENT_TYPES.filter((t) => t.value !== 'other');

export function documentTypeLabel(value: DocClass): string {
  return DOC_CLASS_LABEL[value];
}

/** Parse a loose form/query value into a class (null when it isn't one). */
export function parseDocumentType(v: unknown): DocClass | null {
  return isDocClass(v) ? v : null;
}

/** The coarse storage bucket for a chosen type. */
export function docTypeForClass(value: DocClass): DocumentsDocType {
  return CLASS_TO_DOC_TYPE[value];
}

/**
 * The label for a document nobody has read yet (only its coarse bucket is known). Uses the
 * catalog's wording for the class the bucket stands for, so an unread "POLICY" and a read
 * insurance policy read the same; a broad bucket keeps its broad word.
 */
const COARSE_LABEL: Record<DocumentsDocType, string> = {
  BILL: DOC_CLASS_LABEL.vendor_bill,
  RECEIPT: 'Receipt',
  CONTRACT: 'Contract',
  LEASE: DOC_CLASS_LABEL.lease,
  LOAN: DOC_CLASS_LABEL.loan,
  POLICY: DOC_CLASS_LABEL.insurance_policy,
  W9: DOC_CLASS_LABEL.w9,
  COI: DOC_CLASS_LABEL.coi,
  STATEMENT: 'Statement',
  OTHER: DOC_CLASS_LABEL.other,
};

export function coarseTypeLabel(docType: string | null | undefined): string {
  return docType && docType in COARSE_LABEL ? COARSE_LABEL[docType as DocumentsDocType] : DOC_CLASS_LABEL.other;
}

/** The intelligence preset an upload's chosen type implies (a person's choice is final). */
export function presetFromDocumentType(value: DocClass): { docClass: DocClass; confidence: number; source: 'user' } | null {
  return value === 'other' ? null : { docClass: value, confidence: 1, source: 'user' };
}
