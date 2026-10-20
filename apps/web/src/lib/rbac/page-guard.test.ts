import { describe, it, expect, vi } from 'vitest';

vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('@clerk/nextjs/server', () => ({ auth: vi.fn() }));

import { noAccessHref } from './page-guard';

describe('noAccessHref (page-guard refusal target)', () => {
  it('points at the 403 page with the cell’s primary capability and action', () => {
    expect(noAccessHref('bills', 'approve')).toBe('/no-access?cap=ap.bills&action=approve');
    expect(noAccessHref('reconciliation', 'reconcile')).toBe('/no-access?cap=bank.reconciliations&action=edit');
  });

  it('carries the client when the page knows it', () => {
    expect(noAccessHref('checks', 'view', '11111111-2222-3333-4444-555555555555'))
      .toBe('/no-access?cap=pay.checks&action=view&client=11111111-2222-3333-4444-555555555555');
  });

  it('a refused dashboard no longer loops back to /dashboard', () => {
    expect(noAccessHref('dashboard', 'view')).toBe('/no-access?cap=home.workspace&action=view');
  });

  it('keeps the legacy landing spot for the retired payments key (no capability)', () => {
    expect(noAccessHref('payments', 'run')).toBe('/dashboard');
  });
});
