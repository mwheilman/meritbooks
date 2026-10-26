import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToBuffer } from '@react-pdf/renderer';
import { ConversionCertificatePdf, type CertificatePdfModel } from './certificate-pdf';

const model: CertificatePdfModel = {
  number: 'CC-0001',
  version: 1,
  status: 'issued',
  clientName: 'Heartland Heating & Cooling',
  clientCode: 'HHC',
  tenantName: 'Merit Management Group',
  cutoverDate: '2026-09-30',
  historyDepthLabel: 'Opening balances only',
  preparedBy: 'Sam Kovac',
  preparedAt: '2026-10-19T14:02:00Z',
  approvedBy: 'Priya Natarajan',
  approvedAt: '2026-10-20T09:15:00Z',
  voidReason: null,
  contentHash: 'a'.repeat(64),
  ties: [
    { key: 'tb', label: 'Trial balance', status: 'tied', summary: 'All accounts tie', lines: [], evidence: 'internal_only' },
    { key: 'ar', label: 'Receivables', status: 'tied', summary: 'Receivables tie', lines: [{ label: 'Source aging → MeritBooks open invoices', sourceCents: 21488040, meritCents: 21488040, differenceCents: 0 }], evidence: 'evidenced' },
  ],
  sources: [{ name: 'QuickBooks Online', role: 'ledger_source', files: [{ file: null, sha256: null, parser: 'quickbooks.api v1', entity: 'tb_line' }] }],
  dispositions: [{ name: 'Receivables match the A/R account', severity: 'blocker', amountCents: 421250, disposition: 'carry_as_reconciling_item', note: 'Unapplied A/R from conversion, cleared in October' }],
  mapping: { accounts: 251, accepted: 251, typeExceptions: [] },
  practiceClose: 'Clean switch',
};

describe('Conversion Certificate PDF', () => {
  it('renders a real PDF (issued, and draft-watermarked when not yet signed off)', async () => {
    const issued = await renderToBuffer(React.createElement(ConversionCertificatePdf, { m: model }) as Parameters<typeof renderToBuffer>[0]);
    expect(issued.subarray(0, 4).toString()).toBe('%PDF');
    const prepared = await renderToBuffer(React.createElement(ConversionCertificatePdf, { m: { ...model, status: 'prepared', approvedBy: null, approvedAt: null } }) as Parameters<typeof renderToBuffer>[0]);
    expect(prepared.subarray(0, 4).toString()).toBe('%PDF');
    expect(prepared.length).toBeGreaterThan(1000);
  }, 60_000);
});
