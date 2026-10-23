/** Email attachments: the service-role download only ever follows this org's folder. */
import { describe, it, expect } from 'vitest';
import { buildStoragePath, isOrgStoragePath } from './schema';

const ORG = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';

describe('isOrgStoragePath', () => {
  it('accepts what the upload path builder produces', () => {
    expect(isOrgStoragePath(ORG, buildStoragePath(ORG, 'invoice', 'Signed contract.pdf', 'abc'))).toBe(true);
  });
  it.each([
    ['another org', `${OTHER}/invoice/abc-x.pdf`],
    ['a prefix look-alike', `${ORG}-evil/invoice/abc-x.pdf`],
    ['traversal', `${ORG}/../${OTHER}/invoice/abc-x.pdf`],
    ['an empty segment', `${ORG}//x.pdf`],
    ['a backslash', `${ORG}/invoice\\..\\x.pdf`],
    ['a control character', `${ORG}/invoice/x\u0000.pdf`],
    ['the folder alone', `${ORG}/`],
    ['empty', ''],
  ])('refuses %s', (_l, path) => {
    expect(isOrgStoragePath(ORG, path)).toBe(false);
  });
  it('refuses without an org', () => {
    expect(isOrgStoragePath('', `${ORG}/invoice/x.pdf`)).toBe(false);
  });
});
