/**
 * Unit tests for the PURE document-metadata helpers backing the source-retention
 * (store-source) flow. store-source.ts itself is all Supabase I/O; the deterministic
 * logic it depends on (storage-path building, filename sanitizing, doc-type inference,
 * row shaping, entity-link filtering) lives here and is testable with no I/O.
 */

import { describe, it, expect } from 'vitest';
import {
  sanitizeFileName,
  buildStoragePath,
  inferDocType,
  shapeDocumentRow,
  filterByEntity,
  formatBytes,
  type DocumentRow,
} from './schema';

const ORG = 'org_abc';
const ID = 'doc_0001';

describe('sanitizeFileName', () => {
  it('lowercases, strips path separators, keeps extension', () => {
    expect(sanitizeFileName('/tmp/Some Path/Invoice #42.PDF')).toBe('invoice-42.pdf');
  });
  it('collapses repeated separators and trims leading/trailing junk', () => {
    expect(sanitizeFileName('--A   B..name--')).toBe('a-b..name');
  });
  it('never returns empty — falls back to "file"', () => {
    expect(sanitizeFileName('')).toBe('file');
    expect(sanitizeFileName('***')).toBe('file');
    expect(sanitizeFileName('///')).toBe('file');
  });
  it('caps length at 120 chars', () => {
    expect(sanitizeFileName('a'.repeat(400)).length).toBeLessThanOrEqual(120);
  });
  it('defends against path traversal by keeping only the basename', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
  });
});

describe('buildStoragePath', () => {
  it('namespaces by org and uses the entity folder', () => {
    expect(buildStoragePath(ORG, 'covenant', 'Loan.pdf', ID)).toBe(
      'org_abc/covenant/doc_0001-loan.pdf',
    );
  });
  it('uses "unfiled" when entityType is null/blank', () => {
    expect(buildStoragePath(ORG, null, 'x.pdf', ID)).toBe('org_abc/unfiled/doc_0001-x.pdf');
    expect(buildStoragePath(ORG, '   ', 'x.pdf', ID)).toBe('org_abc/unfiled/doc_0001-x.pdf');
  });
  it('sanitizes a dirty entityType into a safe folder', () => {
    expect(buildStoragePath(ORG, 'Bank Account!!', 'x.pdf', ID)).toBe(
      'org_abc/bank-account/doc_0001-x.pdf',
    );
  });
  it('two identical filenames never collide because id prefixes the key', () => {
    const a = buildStoragePath(ORG, 'bill', 'same.pdf', 'id_a');
    const b = buildStoragePath(ORG, 'bill', 'same.pdf', 'id_b');
    expect(a).not.toBe(b);
  });
});

describe('inferDocType', () => {
  it.each([
    ['vendor-w9.pdf', 'W9'],
    ['w-9-form.pdf', 'W9'],
    ['acme-coi.pdf', 'COI'],
    ['certificate-of-insurance.pdf', 'COI'],
    ['policy-2026.pdf', 'POLICY'],
    ['office-lease.pdf', 'LEASE'],
    ['promissory-note.pdf', 'LOAN'],
    ['bank-statement-jan.pdf', 'STATEMENT'],
    ['receipt-lunch.jpg', 'RECEIPT'],
    ['invoice-1001.pdf', 'BILL'],
    ['master-services-agreement.pdf', 'CONTRACT'],
    ['random.bin', 'OTHER'],
  ] as const)('infers %s → %s', (name, expected) => {
    expect(inferDocType(name, null)).toBe(expected);
  });

  it('handles empty filename → OTHER', () => {
    expect(inferDocType('', null)).toBe('OTHER');
  });
});

describe('shapeDocumentRow', () => {
  it('normalizes blank strings to null and defaults doc_type to OTHER', () => {
    const row = shapeDocumentRow({
      orgId: ORG,
      storagePath: 'org_abc/unfiled/doc-x.pdf',
      fileName: 'x.pdf',
      mimeType: '   ',
      entityType: '',
      entityId: '   ',
      notes: undefined,
    });
    expect(row.mime_type).toBeNull();
    expect(row.entity_type).toBeNull();
    expect(row.entity_id).toBeNull();
    expect(row.notes).toBeNull();
    expect(row.doc_type).toBe('OTHER');
    expect(row.org_id).toBe(ORG);
  });

  it('falls back to "file" for a blank filename', () => {
    const row = shapeDocumentRow({ orgId: ORG, storagePath: 'p', fileName: '   ' });
    expect(row.file_name).toBe('file');
  });

  it('truncates and floors non-negative size; rejects negative/NaN', () => {
    expect(shapeDocumentRow({ orgId: ORG, storagePath: 'p', fileName: 'f', sizeBytes: 10.9 }).size_bytes).toBe(10);
    expect(shapeDocumentRow({ orgId: ORG, storagePath: 'p', fileName: 'f', sizeBytes: -5 }).size_bytes).toBeNull();
    expect(shapeDocumentRow({ orgId: ORG, storagePath: 'p', fileName: 'f', sizeBytes: NaN }).size_bytes).toBeNull();
  });

  it('trims retained string fields', () => {
    const row = shapeDocumentRow({
      orgId: ORG,
      storagePath: 'p',
      fileName: 'f',
      entityType: '  covenant  ',
      entityId: '  abc  ',
      notes: '  hi  ',
    });
    expect(row.entity_type).toBe('covenant');
    expect(row.entity_id).toBe('abc');
    expect(row.notes).toBe('hi');
  });
});

describe('filterByEntity', () => {
  const rows: Pick<DocumentRow, 'entity_type' | 'entity_id'>[] = [
    { entity_type: 'covenant', entity_id: 'c1' },
    { entity_type: 'covenant', entity_id: 'c2' },
    { entity_type: 'bill', entity_id: 'c1' },
    { entity_type: null, entity_id: null }, // unfiled
  ];

  it('returns only rows matching (entityType, entityId)', () => {
    const out = filterByEntity(rows, 'covenant', 'c1');
    expect(out).toHaveLength(1);
    expect(out[0].entity_type).toBe('covenant');
  });

  it('a blank entityId matches only unfiled (null) rows', () => {
    expect(filterByEntity(rows, null, null)).toHaveLength(1);
    expect(filterByEntity(rows, '  ', '  ')).toHaveLength(1);
  });

  it('does not cross entity_type even with the same id', () => {
    expect(filterByEntity(rows, 'bill', 'c1')).toHaveLength(1);
  });
});

describe('formatBytes', () => {
  it('renders B / KB / MB', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
  it('renders an em dash for null/negative/NaN', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(NaN)).toBe('—');
  });
});
