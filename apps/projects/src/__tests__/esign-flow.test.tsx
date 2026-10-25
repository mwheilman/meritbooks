import { renderToString } from 'react-dom/server';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {} }),
  usePathname: () => '/documents',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));

import { MeritProvider } from '@meritbooks/merit-ui';
import { DEFAULT_VOCAB } from '@meritbooks/industry-packs';
import { ShellProvider } from '@/components/shell/ShellContext';
import { runSubjectCallback, COMPLETION_HANDLERS, type PmCalls } from '@/lib/esign/callbacks';
import { deliverLink, signingEmail, signingSms } from '@/lib/esign/deliver';
import { REASON_WORD, type PublicSignState } from '@/lib/esign/types';
import { SignPage } from '@/components/esign/SignPage';
import { DocumentsView } from '@/components/documents/DocumentsView';
import { DrawingsView } from '@/components/documents/drawings/DrawingsView';
import type { FileListItem } from '@/lib/documents/store';
import { isTenantLogoUrl } from '@/lib/templates/context';

function fake(results: Record<string, { error: { message: string; code: string } | null; data?: unknown }>): PmCalls & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    rpc: async (fn, args) => { calls.push(`${fn}:${JSON.stringify(args)}`); return { data: results[fn]?.data ?? null, error: results[fn]?.error ?? null }; },
    receiveWaiver: async (id, doc) => { calls.push(`waiver:${id}:${doc}`); return { data: results.waiver?.data ?? [{ id }], error: results.waiver?.error ?? null }; },
  };
}
const E = (message: string, code = '22023') => ({ message, code });

describe('e-sign completion callbacks call the record\'s own action', () => {
  it('estimate signed → pm.accept_estimate; already accepted counts as done', async () => {
    const c = fake({});
    expect(await runSubjectCallback(c, { kind: 'envelope.completed', subject_kind: 'estimate', subject_id: 'e1' }, { documentId: 'd1' })).toEqual({ ok: true, outcome: { estimate: 'accepted' } });
    expect(c.calls).toEqual(['accept_estimate:{"p_estimate":"e1"}']);
    const again = fake({ accept_estimate: { error: E('PM_ESTIMATE_NOT_OPEN: EST-1 v1 is ACCEPTED') } });
    expect(await runSubjectCallback(again, { kind: 'envelope.completed', subject_kind: 'estimate', subject_id: 'e1' }, { documentId: null })).toMatchObject({ ok: true, outcome: { already: true } });
  });
  it('change order signed → the approvals engine decides when a rule applies', async () => {
    const approved = fake({ approval_decide: { error: null, data: { status: 'approved' } } });
    expect(await runSubjectCallback(approved, { kind: 'envelope.completed', subject_kind: 'change_order', subject_id: 'co' }, { documentId: null }))
      .toEqual({ ok: true, outcome: { change_order: 'approved', via: 'approvals' } });
    expect(approved.calls).toEqual(['approval_decide:{"p_object_type":"change_order","p_object_id":"co","p_decision":"approve","p_reason":"Signed by the customer (e-signature)","p_channel":"api"}']);
    const waiting = fake({ approval_decide: { error: null, data: { status: 'submitted' } } });
    expect(await runSubjectCallback(waiting, { kind: 'envelope.completed', subject_kind: 'change_order', subject_id: 'co' }, { documentId: null }))
      .toEqual({ ok: true, outcome: { change_order: 'signed_awaiting_internal_approval', approval: 'submitted' } });
    const plain = fake({ approval_decide: { error: null, data: { status: 'not_needed' } } });
    await runSubjectCallback(plain, { kind: 'envelope.completed', subject_kind: 'change_order', subject_id: 'co' }, { documentId: null });
    expect(plain.calls[1]).toBe('approve_change_order:{"p_co":"co"}');
    const noEngine = fake({ approval_decide: { error: E('Could not find the function pm.approval_decide', 'PGRST202') } });
    await runSubjectCallback(noEngine, { kind: 'envelope.completed', subject_kind: 'change_order', subject_id: 'co' }, { documentId: null });
    expect(noEngine.calls[1]).toBe('approve_change_order:{"p_co":"co"}');
  });
  it('change order signed → approve; the requester who prepared it leaves it for an internal approver', async () => {
    const sod = fake({ approval_decide: { error: null, data: { status: 'not_needed' } }, approve_change_order: { error: E('PM_SOD_VIOLATION: the preparer of CO-1 cannot approve it', '42501') } });
    expect(await runSubjectCallback(sod, { kind: 'envelope.completed', subject_kind: 'change_order', subject_id: 'co' }, { documentId: null }))
      .toEqual({ ok: true, outcome: { change_order: 'signed_awaiting_internal_approval' } });
  });
  it('lien waiver signed → received with the signed file; buyer\'s order → accept the quote', async () => {
    const c = fake({});
    expect(await runSubjectCallback(c, { kind: 'envelope.completed', subject_kind: 'lien_waiver', subject_id: 'lw' }, { documentId: 'signed-doc' })).toEqual({ ok: true, outcome: { lien_waiver: 'received' } });
    expect(c.calls).toEqual(['waiver:lw:signed-doc']);
    const q = fake({});
    await runSubjectCallback(q, { kind: 'envelope.completed', subject_kind: 'dealer_quote', subject_id: 'q1' }, { documentId: null });
    expect(q.calls).toEqual(['accept_dealer_quote:{"p_quote":"q1"}']);
  });
  it('a caller without the right defers (someone else will run it); other errors fail and retry', async () => {
    const f = fake({ accept_estimate: { error: E('PM_FORBIDDEN: requires projects.estimates:edit', '42501') } });
    expect(await runSubjectCallback(f, { kind: 'envelope.completed', subject_kind: 'estimate', subject_id: 'e' }, { documentId: null })).toMatchObject({ ok: false, deferred: true });
    const g = fake({ accept_estimate: { error: E('PM_ESTIMATE_UNCODED: 2 lines have no cost code') } });
    expect(await runSubjectCallback(g, { kind: 'envelope.completed', subject_kind: 'estimate', subject_id: 'e' }, { documentId: null })).toMatchObject({ ok: false, error: expect.stringMatching(/UNCODED/) });
  });
  it('declined → decline the estimate / quote with the signer\'s reason; no subject → nothing to do', async () => {
    const c = fake({});
    await runSubjectCallback(c, { kind: 'envelope.declined', subject_kind: 'estimate', subject_id: 'e1' }, { documentId: null, reason: 'Too high' });
    expect(c.calls).toEqual(['decline_estimate:{"p_estimate":"e1","p_reason":"Too high"}']);
    expect(await runSubjectCallback(c, { kind: 'envelope.completed', subject_kind: 'none', subject_id: null }, { documentId: null })).toEqual({ ok: true, outcome: { subject: 'none' } });
    expect(Object.keys(COMPLETION_HANDLERS).sort()).toEqual(['change_order', 'dealer_quote', 'estimate', 'lien_waiver']);
  });
});

describe('link delivery', () => {
  const base = { name: 'Pat Rivera', email: 'pat@example.test', phone: '+15155550100', link: 'https://p.example/sign/abc', title: 'Kitchen contract', message: 'Call me with questions', companyName: 'Heartland', expiresAt: '2026-11-07T00:00:00Z', resend: false };
  it('email + SMS through the notification providers; nothing delivered → the sender shares the link', async () => {
    const sent: string[] = [];
    const ok = await deliverLink({ ...base, channel: 'both' }, {
      email: { id: 'resend', send: async (m) => { sent.push(`email:${m.to}:${m.subject}`); return { status: 'sent', provider: 'resend', providerMessageId: 'm1' }; } },
      sms: { id: 'twilio', send: async (m) => { sent.push(`sms:${m.to}`); return { status: 'sent', provider: 'twilio', providerMessageId: 's1' }; } },
    });
    expect(ok).toMatchObject({ email: 'sent', sms: 'sent', manual: false });
    expect(sent[0]).toMatch(/^email:pat@example\.test:Heartland sent you "Kitchen contract" to sign$/);
    const none = await deliverLink({ ...base, channel: 'email' }, { email: { id: 'none', send: async () => ({ status: 'not_configured', reason: 'Email is not set up.' }) } });
    expect(none).toMatchObject({ email: 'not_configured', manual: true, detail: 'Email is not set up.' });
    expect((await deliverLink({ ...base, channel: 'link' })).manual).toBe(true);
  });
  it('messages carry the link, escape HTML and say it is one-time', () => {
    const m = signingEmail({ ...base, channel: 'email', title: '<b>x</b>' });
    expect(m.html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(m.text).toContain(base.link);
    expect(m.text).toMatch(/works once/);
    expect(signingSms({ ...base, channel: 'sms' })).toContain(base.link);
  });
});

describe('logo fetch is limited to the tenant\'s own branding folder (SSRF)', () => {
  it('accepts only https <supabase>/storage/v1/object/public/branding/<org>/…', () => {
    const sb = 'https://abc.supabase.co';
    expect(isTenantLogoUrl('https://abc.supabase.co/storage/v1/object/public/branding/org1/logo.png', 'org1', sb)).toBe(true);
    expect(isTenantLogoUrl('https://abc.supabase.co/storage/v1/object/public/branding/org2/logo.png', 'org1', sb)).toBe(false);
    expect(isTenantLogoUrl('https://evil.test/storage/v1/object/public/branding/org1/logo.png', 'org1', sb)).toBe(false);
    expect(isTenantLogoUrl('http://abc.supabase.co/storage/v1/object/public/branding/org1/logo.png', 'org1', sb)).toBe(false);
    expect(isTenantLogoUrl(null, 'org1', sb)).toBe(false);
  });
});

// ------------------------------------------------------------------ SSR render
function wrap(el: ReactElement): string {
  return renderToString(
    <MeritProvider>
      <ShellProvider value={{ vocab: { ...DEFAULT_VOCAB }, companies: [], activeCompanyId: null, readOnly: false, setCrumbs: () => {} }}>{el}</ShellProvider>
    </MeritProvider>,
  );
}

const STATE: PublicSignState = {
  ok: true, reason: null, can_act: true,
  envelope: { id: 'e', title: 'Kitchen contract', message: 'Please sign by Friday', status: 'sent', expires_at: '2026-11-07T00:00:00Z', sent_at: '2026-10-24T00:00:00Z', completed_at: null, sha256: 'a'.repeat(64) },
  document: { title: 'Kitchen contract', file_name: 'contract.pdf', page_count: 3, kind: 'contract' },
  company: { company_name: 'Heartland Remodeling', org_name: 'Heartland', logo_url: null, primary_color: '#2563EB', ink_color: '#0A1628', on_primary_color: '#FFFFFF' },
  signer: { id: 's', name: 'Pat Rivera', email: 'pat@example.test', role_label: 'Owner', status: 'viewed', signed_at: null, routing_order: 1 },
  signers: [{ name: 'Pat Rivera', role_label: 'Owner', routing_order: 1, status: 'viewed', signed_at: null, you: true }, { name: 'Sam Rivera', role_label: null, routing_order: 2, status: 'waiting', signed_at: null, you: false }],
  consent: { version: 'esign-consent-v1', text: 'I agree to use electronic records and signatures.' },
};

describe('signing page states', () => {
  it('ready to sign: document, consent, typed name, pad, decline', () => {
    const html = wrap(<SignPage token="t" initial={STATE} viewUrl="https://files.test/v?token=10min" />);
    expect(html).toContain('Kitchen contract');
    expect(html).toContain('I agree to use electronic records');
    expect(html).toContain('Type your full name');
    expect(html).toContain('Decline to sign');
    expect(html).toContain('Sam Rivera');
    expect(html).toContain('Waiting for earlier signers');
    expect(html).toContain('https://files.test/v?token=10min');
  });
  it('invalid / used / signed links explain what to do', () => {
    expect(wrap(<SignPage token="t" initial={{ ok: false, reason: 'invalid' }} viewUrl={null} />)).toContain(REASON_WORD.invalid.slice(0, 30));
    expect(wrap(<SignPage token="t" initial={{ ...STATE, ok: false, can_act: false, reason: 'expired' }} viewUrl={null} />)).toContain('expired');
    const signed = wrap(<SignPage token="t" initial={{ ...STATE, can_act: false, reason: 'used', signer: { ...STATE.signer!, status: 'signed', signed_at: '2026-10-24T15:00:00Z' } }} viewUrl="https://files.test/should-not-show" />);
    expect(signed).toContain('Signed. Thank you.');
    expect(signed).not.toContain('Type your full name');
    expect(signed).not.toContain('should-not-show');
  });
});

describe('documents and drawings views render every state', () => {
  const jobs = [{ id: 'j1', label: 'J-1 · Kitchen', companyId: 'c1', company: null, customerId: null, customer: 'Rivera', open: true, jobTypeKey: 'remodel' }];
  const file: FileListItem = {
    id: 'f1', location_id: 'c1', job_id: 'j1', folder_id: 'fo1', title: 'Prime contract', kind: 'contract', money_cap: 'projects.contract_value', description: null, tags: [],
    subject_table: null, subject_id: null, current_version_id: 'v1', version_count: 2, retention_class: 'contract', retain_until: '2036-10-24', legal_hold: true, legal_hold_reason: 'Claim',
    legal_hold_at: '2026-10-24T00:00:00Z', status: 'active', created_by: 'u', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-24T00:00:00Z',
    current: { id: 'v1', file_name: 'contract (signed).pdf', mime_type: 'application/pdf', size_bytes: 120000, version_no: 2, locked: true, created_at: '2026-10-24T00:00:00Z' }, signature: 'completed',
  };
  const perms = { create: true, edit: true, delete: true };
  it('no job picked → choose one', () => {
    expect(wrap(<DocumentsView jobs={jobs} jobId={null} folderId={null} kind={null} q="" folders={[]} counts={{}} files={[]} perms={perms} readOnly={false} jobLabel="" userId="u" />)).toContain('Pick a job to see its documents');
  });
  it('empty job → upload prompt; populated → folders, signed and hold tags', () => {
    const folders = [{ id: 'fo1', job_id: 'j1', parent_id: null, key: 'contract', name: 'Contract and proposals', sort: 10, money_cap: 'projects.contract_value' as const, kinds: ['contract'] }];
    expect(wrap(<DocumentsView jobs={jobs} jobId="j1" folderId={null} kind={null} q="" folders={folders} counts={{}} files={[]} perms={perms} readOnly={false} jobLabel="J-1" userId="u" />)).toContain('No documents on this job yet');
    const html = wrap(<DocumentsView jobs={jobs} jobId="j1" folderId={null} kind={null} q="" folders={folders} counts={{ fo1: 1 }} files={[file]} perms={perms} readOnly={false} jobLabel="J-1" userId="u" />);
    expect(html).toContain('Prime contract');
    expect(html).toContain('Contract and proposals');
    expect(html).toContain('Signed');
    expect(html).toContain('Hold');
  });
  it('drawings index groups sheets by discipline and lists sets in review', () => {
    const html = wrap(<DrawingsView jobs={jobs} jobId="j1" canCreate
      sets={[{ id: 's1', job_id: 'j1', name: 'IFC 1', set_kind: 'ifc', issued_on: '2026-09-01', source_file_id: null, page_count: 2, sheet_count: 2, status: 'published', published_at: '2026-09-02T00:00:00Z', created_at: '2026-09-01T00:00:00Z' },
            { id: 's2', job_id: 'j1', name: 'ASI 2', set_kind: 'asi', issued_on: '2026-10-01', source_file_id: null, page_count: 1, sheet_count: 1, status: 'review', published_at: null, created_at: '2026-10-01T00:00:00Z' }]}
      sheets={[{ id: 'a', job_id: 'j1', sheet_number: 'A-101', title: 'First floor plan', discipline: 'Architectural', current_revision_id: 'r1', revision_count: 2, updated_at: '', current: { id: 'r1', revision_label: '2', set_id: 's1', created_at: '', set_name: 'IFC 1', issued_on: '2026-09-01' } }]} />);
    expect(html).toContain('A-101');
    expect(html).toContain('Architectural');
    expect(html).toContain('In review');
    expect(html).toContain('ASI 2');
  });
});
