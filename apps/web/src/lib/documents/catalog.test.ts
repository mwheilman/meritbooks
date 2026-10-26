import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_TYPES,
  UPLOAD_DOCUMENT_TYPES,
  coarseTypeLabel,
  docTypeForClass,
  documentTypeLabel,
  parseDocumentType,
  presetFromDocumentType,
} from './catalog';
import { DOC_CLASSES } from './intelligence/types';
import { DOC_TYPES } from './schema';
import { backfillMessage } from './intelligence/service';
import { DOCUMENTS_CLASSIFY_RETRY_JOB } from '@/lib/scheduler/jobs/documents-classify-retry';
import { TICK_BUDGET_MS } from '@/lib/scheduler/dispatch';
import { bandCount, typeLabel, visibleColumnIds, type IntelSummary } from '@/app/(app)/documents/documents-types';
import type { DocumentRow } from './schema';
import type { IntelligenceDto } from './intelligence/types';

describe('document-type catalog (one list for upload, filter and the panel)', () => {
  it('covers every intelligence class exactly once, "Other" last', () => {
    expect(DOCUMENT_TYPES.map((t) => t.value).sort()).toEqual([...DOC_CLASSES].sort());
    expect(new Set(DOCUMENT_TYPES.map((t) => t.value)).size).toBe(DOC_CLASSES.length);
    expect(DOCUMENT_TYPES.at(-1)?.value).toBe('other');
  });
  it('upload offers every type except Other (that is what "Work it out" falls back to)', () => {
    expect(UPLOAD_DOCUMENT_TYPES).toHaveLength(DOC_CLASSES.length - 1);
    expect(UPLOAD_DOCUMENT_TYPES.some((t) => t.value === 'other')).toBe(false);
  });
  it('every type stores under a valid coarse documents.doc_type bucket', () => {
    for (const t of DOCUMENT_TYPES) expect(DOC_TYPES).toContain(t.docType);
    expect(docTypeForClass('lease')).toBe('LEASE');
    expect(docTypeForClass('fixed_asset_invoice')).toBe('BILL');
  });
  it('parses only real types; a chosen type is a person’s final answer', () => {
    expect(parseDocumentType('lease')).toBe('lease');
    expect(parseDocumentType('LEASE')).toBeNull();
    expect(parseDocumentType(undefined)).toBeNull();
    expect(presetFromDocumentType('loan')).toEqual({ docClass: 'loan', confidence: 1, source: 'user' });
    expect(presetFromDocumentType('other')).toBeNull();
  });
  it('an unread file’s bucket reads in the catalog’s words', () => {
    expect(coarseTypeLabel('POLICY')).toBe(documentTypeLabel('insurance_policy'));
    expect(coarseTypeLabel('COI')).toBe(documentTypeLabel('coi'));
    expect(coarseTypeLabel('OTHER')).toBe('Other');
    expect(coarseTypeLabel('nonsense')).toBe('Other');
  });
});

describe('documents center display helpers', () => {
  const summary: IntelSummary = { needs_review: 2, proposals_pending: 1, ai_deferred: 0, not_analyzed: 1, documents: 7, unfiled: 4 };
  it('band tiles always show a number once the summary has loaded (never "·")', () => {
    expect(bandCount('unfiled', 'all', 7, summary)).toBe(4);
    expect(bandCount('all', 'review', 2, summary)).toBe(7);
    expect(bandCount('unfiled', 'unfiled', 3, summary)).toBe(3); // filtered list total when showing
    expect(bandCount('review', 'all', 7, summary)).toBe(2);
    expect(bandCount('unfiled', 'all', 7, undefined)).toBe('—');
  });
  it('the panel-open table keeps document · type · status only', () => {
    expect(visibleColumnIds(true)).toEqual(['doc', 'type', 'status']);
    expect(visibleColumnIds(false)).toEqual(['doc', 'type', 'conf', 'company', 'linked', 'status']);
  });
  it('type label: the read class, else the stored bucket', () => {
    const doc = { doc_type: 'POLICY' } as DocumentRow;
    expect(typeLabel({ doc, intel: null })).toBe('Insurance policy');
    const intel = { doc_class: 'lease', status: 'proposal_created' } as IntelligenceDto;
    expect(typeLabel({ doc, intel })).toBe('Lease');
  });
});

describe('"Analyze existing documents" result wording', () => {
  const base = { analyzed: 0, proposals: 0, needsReview: 0, duplicates: 0, linksCreated: 0, remaining: 0, errors: [] as string[] };
  it('never says "already analyzed" when a read failed', () => {
    const m = backfillMessage({ ...base, errors: ['467c…: Could not record the document analysis'] });
    expect(m).not.toMatch(/already been analyzed/);
    expect(m).toMatch(/1 document couldn’t be read/);
  });
  it('link-backfill errors are not counted as unread documents', () => {
    expect(backfillMessage({ ...base, errors: ['links: boom'] })).toBe('Everything here has already been analyzed.');
  });
  it('reports what it did', () => {
    expect(backfillMessage({ ...base, analyzed: 2, proposals: 1, needsReview: 1, remaining: 3 })).toBe(
      'Analyzed 2 document(s): 1 proposal(s) ready for review, 1 need a type. 3 more to go — run it again.',
    );
  });
});

describe('documents.classify_retry can actually start', () => {
  it('its timeout leaves room inside the scheduler tick budget (a unit starts only while budget left ≥ timeout)', () => {
    // At timeoutMs === TICK_BUDGET_MS the unit was deferred on every tick and never ran.
    expect(DOCUMENTS_CLASSIFY_RETRY_JOB.timeoutMs).toBeLessThanOrEqual(TICK_BUDGET_MS - 60_000);
  });
});
