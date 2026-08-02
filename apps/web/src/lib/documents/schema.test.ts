/**
 * Document Management Center — pure helpers.
 *
 * Pins the metadata shaping (blank → null normalization, size coercion, doc_type
 * default), the storage-path builder + filename sanitizer (org namespacing, collision
 * prefix, path-separator stripping), doc-type inference, and the entity-link filter
 * semantics (unfiled = both null). No Storage / Postgres dependency.
 */

import { describe, it, expect } from 'vitest';
import {
  sanitizeFileName,
  buildStoragePath,
  shapeDocumentRow,
  filterByEntity,
  inferDocType,
  formatBytes,
  DOC_TYPES,
} from './schema';

describe('sanitizeFileName', () => {
  it('strips path separators and keeps the base name', () => {
    expect(sanitizeFileName('/Users/mike/Bill Q4.pdf')).toBe('bill-q4.pdf');
    expect(sanitizeFileName('C:\\docs\\W-9 Form.PDF')).toBe('w-9-form.pdf');
  });
  it('collapses unsafe chars and never returns empty', () => {
    expect(sanitizeFileName('   !!! .pdf')).toBe('pdf');
    expect(sanitizeFileName('')).toBe('file');
    expect(sanitizeFileName('***')).toBe('file');
  });
});

describe('buildStoragePath', () => {
  const org = '11111111-1111-1111-1111-111111111111';
  const id = '22222222-2222-2222-2222-222222222222';
  it('namespaces by org, folders by entity type, and prefixes with the id', () => {
    expect(buildStoragePath(org, 'BILL', 'Invoice 100.pdf', id)).toBe(
      `${org}/bill/${id}-invoice-100.pdf`,
    );
  });
  it('files documents with no entity under unfiled', () => {
    expect(buildStoragePath(org, null, 'note.txt', id)).toBe(`${org}/unfiled/${id}-note.txt`);
    expect(buildStoragePath(org, '   ', 'note.txt', id)).toBe(`${org}/unfiled/${id}-note.txt`);
  });
  it('two identical filenames get distinct paths via the id prefix', () => {
    const a = buildStoragePath(org, 'RECEIPT', 'r.pdf', 'aaaaaaaa-0000-0000-0000-000000000000');
    const b = buildStoragePath(org, 'RECEIPT', 'r.pdf', 'bbbbbbbb-0000-0000-0000-000000000000');
    expect(a).not.toBe(b);
  });
});

describe('shapeDocumentRow', () => {
  it('normalizes blanks to null and truncates size to an int', () => {
    const row = shapeDocumentRow({
      orgId: 'org-1',
      storagePath: 'org-1/unfiled/x-file.pdf',
      fileName: 'File.pdf',
      mimeType: '  ',
      sizeBytes: 123.9,
      entityType: '',
      entityId: '   ',
      notes: '  keep me  ',
      uploadedByUser: 'user_abc',
    });
    expect(row.mime_type).toBeNull();
    expect(row.entity_type).toBeNull();
    expect(row.entity_id).toBeNull();
    expect(row.size_bytes).toBe(123);
    expect(row.notes).toBe('keep me');
    expect(row.uploaded_by_user).toBe('user_abc');
    expect(row.doc_type).toBe('OTHER');
  });
  it('rejects negative / non-finite sizes as null and preserves a chosen doc_type', () => {
    const row = shapeDocumentRow({
      orgId: 'org-1',
      storagePath: 'p',
      fileName: 'x',
      sizeBytes: -5,
      docType: 'W9',
      entityType: 'VENDOR',
      entityId: '33333333-3333-3333-3333-333333333333',
    });
    expect(row.size_bytes).toBeNull();
    expect(row.doc_type).toBe('W9');
    expect(row.entity_type).toBe('VENDOR');
    expect(row.entity_id).toBe('33333333-3333-3333-3333-333333333333');
  });
  it('every DOC_TYPE round-trips', () => {
    for (const t of DOC_TYPES) {
      expect(shapeDocumentRow({ orgId: 'o', storagePath: 'p', fileName: 'f', docType: t }).doc_type).toBe(t);
    }
  });
});

describe('filterByEntity — attachments link semantics', () => {
  const docs = [
    { entity_type: 'BILL', entity_id: 'b1' },
    { entity_type: 'BILL', entity_id: 'b2' },
    { entity_type: 'INVOICE', entity_id: 'b1' },
    { entity_type: null, entity_id: null },
  ];
  it('returns only the exact (type,id) match', () => {
    expect(filterByEntity(docs, 'BILL', 'b1')).toEqual([{ entity_type: 'BILL', entity_id: 'b1' }]);
  });
  it('does not cross entity types even with the same id', () => {
    const res = filterByEntity(docs, 'INVOICE', 'b1');
    expect(res).toHaveLength(1);
    expect(res[0].entity_type).toBe('INVOICE');
  });
  it('a null/blank entity_id matches only unfiled rows', () => {
    expect(filterByEntity(docs, null, null)).toEqual([{ entity_type: null, entity_id: null }]);
    expect(filterByEntity(docs, '  ', '  ')).toEqual([{ entity_type: null, entity_id: null }]);
  });
  it('no match yields an empty array, never throws', () => {
    expect(filterByEntity(docs, 'LEASE', 'zzz')).toEqual([]);
  });
});

describe('inferDocType', () => {
  it('maps common names to types', () => {
    expect(inferDocType('vendor-w9.pdf', 'application/pdf')).toBe('W9');
    expect(inferDocType('ABC-COI-2026.pdf', null)).toBe('COI');
    expect(inferDocType('office-lease.pdf', null)).toBe('LEASE');
    expect(inferDocType('bank statement jan.pdf', null)).toBe('STATEMENT');
    expect(inferDocType('promissory note.pdf', null)).toBe('LOAN');
    expect(inferDocType('random.dat', null)).toBe('OTHER');
  });
});

describe('formatBytes', () => {
  it('formats and degrades', () => {
    expect(formatBytes(500)).toBe('500 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(-1)).toBe('—');
  });
});
