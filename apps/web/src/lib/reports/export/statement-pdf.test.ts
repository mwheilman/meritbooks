/**
 * The statement PDF keeps the number-governance marks (watermark, banner, footnote).
 */
import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToBuffer } from '@react-pdf/renderer';
import { pdfText } from '@/test/pdf-text';
import { StatementPdf } from './statement-pdf';
import { stampUngoverned, UNGOVERNED_FOOTNOTE, type StatementModel } from './statement-model';

const model: StatementModel = {
  title: 'Income statement',
  entityLabel: 'Alpha Co',
  periodLabel: 'Sep 2026',
  generatedAt: '2026-10-24T00:00:00Z',
  columns: [{ key: 'cur', label: 'Sep 2026', money: true }],
  rows: [{ kind: 'account', label: 'Revenue', values: [1_000_00] }],
  watermark: 'PREVIEW',
  banner: 'Preview not released',
  footnote: 'Books closed through Aug 2026',
};

const render = async (m: StatementModel) =>
  pdfText(await renderToBuffer(React.createElement(StatementPdf, { model: m }) as Parameters<typeof renderToBuffer>[0])).replace(/\s+/g, ' ');

describe('statement PDF governance marks', () => {
  it('renders the watermark, banner and footnote', async () => {
    const text = await render(model);
    expect(text).toContain('PREVIEW');
    expect(text).toContain('Preview not released');
    expect(text).toContain('Books closed through Aug 2026');
  }, 30_000);

  it('a client-built (ungoverned) model is stamped as such', async () => {
    const text = await render(stampUngoverned(model));
    expect(text).not.toContain('Preview not released');
    expect(text).toContain(UNGOVERNED_FOOTNOTE.split('.')[0]);
  }, 30_000);
});
