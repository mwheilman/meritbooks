import { describe, it, expect, vi } from 'vitest';

// resolve-upload pulls in the admin Supabase client; the pure helpers under test don't use it.
vi.mock('@/lib/supabase/server', () => ({ createAdminSupabase: () => ({}) }));

import { isOrgIntakePath, displayNameFromStoragePath, isSheetName, isReadableName } from './paths';
import { pickMediaType, mediaTypeFromName, PARSEABLE_DOC_TYPES, SPREADSHEET_TYPES, INTAKE_READABLE_TYPES } from './resolve-upload';

const ORG = '7f1c2d3e-0000-4000-8000-000000000001';

describe('isOrgIntakePath', () => {
  it('accepts only this org’s intake space', () => {
    expect(isOrgIntakePath(`intake/${ORG}/abc-file.pdf`, ORG)).toBe(true);
    expect(isOrgIntakePath(`intake/other-org/abc-file.pdf`, ORG)).toBe(false);
    expect(isOrgIntakePath(`intake/${ORG}/`, ORG)).toBe(false);
    expect(isOrgIntakePath(`intake/${ORG}/../x/file.pdf`, ORG)).toBe(false);
    expect(isOrgIntakePath(`documents/${ORG}/file.pdf`, ORG)).toBe(false);
  });
});

describe('displayNameFromStoragePath', () => {
  it('drops the folder and uuid prefix', () => {
    expect(displayNameFromStoragePath(`intake/${ORG}/0b8f3c3e-1111-4222-8333-944445555666-Trial_Balance.xlsx`)).toBe('Trial_Balance.xlsx');
    expect(displayNameFromStoragePath('intake/x/plain.pdf')).toBe('plain.pdf');
  });
});

describe('extension helpers', () => {
  it('classifies sheets vs readable docs', () => {
    expect(isSheetName('a.CSV')).toBe(true);
    expect(isSheetName('a.xlsx')).toBe(true);
    expect(isSheetName('a.xls')).toBe(false);
    expect(isReadableName('a.pdf')).toBe(true);
    expect(isReadableName('a.docx')).toBe(false);
  });
});

describe('resolve-upload media typing (backward compatible)', () => {
  it('default allowed types are unchanged (PDF/images only)', () => {
    expect([...PARSEABLE_DOC_TYPES]).toEqual(['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif']);
    expect(PARSEABLE_DOC_TYPES.includes('text/csv')).toBe(false);
    expect(INTAKE_READABLE_TYPES).toEqual([...PARSEABLE_DOC_TYPES, ...SPREADSHEET_TYPES]);
  });

  it('PDF/images keep reported-type-first; a CSV with no allowance is still rejected by type', () => {
    expect(pickMediaType('application/pdf', 'x.pdf', PARSEABLE_DOC_TYPES)).toBe('application/pdf');
    expect(pickMediaType('', 'x.png', PARSEABLE_DOC_TYPES)).toBe('image/png');
    expect(PARSEABLE_DOC_TYPES.includes(pickMediaType('text/csv', 'x.csv', PARSEABLE_DOC_TYPES))).toBe(false);
  });

  it('sheets resolve by extension (Windows reports .csv as application/vnd.ms-excel)', () => {
    expect(pickMediaType('application/vnd.ms-excel', 'budget.csv', SPREADSHEET_TYPES)).toBe('text/csv');
    expect(pickMediaType('application/octet-stream', 'tb.xlsx', INTAKE_READABLE_TYPES)).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(mediaTypeFromName('notes.txt')).toBe('text/plain');
  });
});
