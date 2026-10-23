'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, ButtonLink, ConfirmDialog, InlineNotice, Tabs, Tag, useHotkey } from '@meritbooks/merit-ui';
import { PageHeader } from '@/components/ui';
import { useQuery, addToast } from '@/hooks';
import { api } from '@/lib/api-client';
import { useActiveCompany } from '@/lib/hooks/use-active-company';
import { BUILT_IN_TEMPLATE, type InvoiceTemplate } from '@/lib/invoices/templates/types';
import { bodyFromTemplate, templateBodySchema, type TemplateBody } from '@/lib/invoices/templates/schema';
import { TemplateList, type ListedTemplate } from './template-list';
import { TemplateEditor } from './template-editor';
import { TemplatePreview } from './template-preview';
import { CustomerAssignments } from './customer-assignments';

export interface TemplatesResponse {
  company: { id: string; name: string } | null;
  templates: ListedTemplate[];
  online: { payable: boolean; mode: 'live' | 'test' | null; code: string; reason: string | null; methods: string[] };
}

type Tab = 'templates' | 'customers';
const PANEL = 'invoice-design-panel';

/** Field-level errors from the shared Zod schema (same rules as the server). */
export type FieldErrors = Partial<Record<keyof TemplateBody | string, string>>;

function validate(body: TemplateBody): FieldErrors {
  const r = templateBodySchema.safeParse(body);
  if (r.success) return {};
  const out: FieldErrors = {};
  for (const i of r.error.issues) {
    const k = i.path.join('.');
    if (!out[k]) out[k] = i.message;
  }
  return out;
}

export function DesignClient() {
  const { activeCompany, activeCompanyId } = useActiveCompany();
  const [tab, setTab] = useState<Tab>('templates');
  const { data, isLoading, error, refetch } = useQuery<TemplatesResponse>('/api/invoice-templates', { location_id: activeCompanyId });
  const templates = useMemo(() => data?.templates ?? [], [data]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = templates.find((t) => t.id === selectedId) ?? null;
  const [draft, setDraft] = useState<TemplateBody | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState<string | null>(null);

  // Select the default (or first) template once loaded / when the company changes.
  useEffect(() => {
    if (!templates.length) { setSelectedId(null); setDraft(null); return; }
    if (!selectedId || !templates.some((t) => t.id === selectedId)) {
      const pick = templates.find((t) => t.is_default && t.location_id) ?? templates.find((t) => t.is_default) ?? templates[0];
      setSelectedId(pick.id);
      setDraft(bodyFromTemplate(pick));
    }
  }, [templates, selectedId]);

  const dirty = useMemo(
    () => !!selected && !!draft && JSON.stringify(bodyFromTemplate(selected)) !== JSON.stringify(draft),
    [selected, draft],
  );
  const errors = useMemo(() => (draft ? validate(draft) : {}), [draft]);
  const hasErrors = Object.keys(errors).length > 0;

  const choose = (id: string) => {
    if (id === selectedId) return;
    if (dirty) { setConfirmDiscard(id); return; }
    const t = templates.find((x) => x.id === id);
    if (t) { setSelectedId(id); setDraft(bodyFromTemplate(t)); }
  };

  const save = useCallback(async () => {
    if (!selected?.id || !draft || !dirty || hasErrors || saving) return;
    setSaving(true);
    const res = await api.patch<{ template: InvoiceTemplate }>(`/api/invoice-templates/${selected.id}`, draft);
    setSaving(false);
    if (res.error) { addToast('error', res.error.error || 'Could not save the template. Try again.'); return; }
    addToast('success', `Saved ${draft.name}`);
    await refetch();
  }, [selected, draft, dirty, hasErrors, saving, refetch]);

  useHotkey('mod+s', () => { void save(); return true; }, { allowInInputs: true, owner: 'InvoiceDesign', description: 'Save template' });

  async function createFirst() {
    const body = { ...bodyFromTemplate(BUILT_IN_TEMPLATE), name: 'Standard', location_id: activeCompanyId, make_default: true };
    const res = await api.post<{ template: InvoiceTemplate }>('/api/invoice-templates', body);
    if (res.error) { addToast('error', res.error.error || 'Could not create the template.'); return; }
    addToast('success', 'Created Standard');
    setSelectedId(res.data?.template.id ?? null);
    await refetch();
  }

  async function createNew() {
    const taken = new Set(templates.map((t) => t.name.toLowerCase()));
    let name = 'New template';
    for (let i = 2; taken.has(name.toLowerCase()); i++) name = `New template (${i})`;
    const base = draft ?? bodyFromTemplate(BUILT_IN_TEMPLATE);
    const res = await api.post<{ template: InvoiceTemplate }>('/api/invoice-templates', { ...base, name, location_id: activeCompanyId });
    if (res.error) { addToast('error', res.error.error || 'Could not create the template.'); return; }
    addToast('success', `Created ${name}`);
    if (res.data) { setSelectedId(res.data.template.id); setDraft(bodyFromTemplate(res.data.template)); }
    await refetch();
  }

  async function duplicate() {
    if (!selected?.id) return;
    const res = await api.post<{ template: InvoiceTemplate }>(`/api/invoice-templates/${selected.id}/duplicate`, { location_id: activeCompanyId });
    if (res.error) { addToast('error', res.error.error || 'Could not duplicate the template.'); return; }
    addToast('success', `Duplicated as ${res.data?.template.name ?? 'a copy'}`);
    if (res.data) { setSelectedId(res.data.template.id); setDraft(bodyFromTemplate(res.data.template)); }
    await refetch();
  }

  async function makeDefault() {
    if (!selected?.id) return;
    const res = await api.post<{ template: InvoiceTemplate }>(`/api/invoice-templates/${selected.id}/default`, {});
    if (res.error) { addToast('error', res.error.error || 'Could not set the default.'); return; }
    addToast('success', `${selected.name} is now the default`);
    await refetch();
  }

  async function remove() {
    if (!selected?.id) return;
    const res = await api.delete<{ ok: boolean; customers: number; invoices: number }>(`/api/invoice-templates/${selected.id}`);
    if (res.error) throw new Error(res.error.error || 'Could not delete the template.');
    addToast('success', `Deleted ${selected.name}`);
    setSelectedId(null);
    await refetch();
  }

  const online = data?.online;
  const companyName = activeCompany?.name ?? data?.company?.name ?? 'this company';

  return (
    <div className="mb-design">
      <PageHeader
        eyebrow={['Invoices', 'Design']}
        title="Invoice design"
        description={`How ${companyName}'s invoices look and what they print. Changes show in the preview as you type; nothing changes on customer invoices until you save.`}
        actions={
          <>
            <ButtonLink href="/invoices">Back to invoices</ButtonLink>
            {tab === 'templates' && templates.length > 0 && <Button onClick={() => void createNew()} icon="plus">New template</Button>}
          </>
        }
      />

      <Tabs
        className="mb-design-tabs"
        aria-label="Invoice design sections"
        value={tab}
        onChange={setTab}
        items={[
          { value: 'templates', label: 'Templates', count: data ? templates.length : undefined, panelId: PANEL },
          { value: 'customers', label: 'Customers', panelId: PANEL },
        ]}
      />

      {online && !online.payable && (
        <div className="mb-design-notice">
          <InlineNotice tone="warn" title="The pay link and QR code won't print for this company yet.">
            {online.reason} <a className="link" href="/settings/payments">Open payment settings</a>
          </InlineNotice>
        </div>
      )}
      {online?.payable && online.mode === 'test' && (
        <div className="mb-design-notice">
          <InlineNotice tone="info" title="Online payments are in Stripe test mode.">
            Invoices print a working pay link and QR code, but only test cards and test bank accounts can pay. Switch to live in Settings → Payments.
          </InlineNotice>
        </div>
      )}

      <div id={PANEL} role="tabpanel">
        {isLoading && !data ? (
          <div className="mb-design-grid" aria-busy="true">
            <div className="wg-loading" style={{ height: 320 }}><span className="bar-l" style={{ width: '70%' }} /></div>
            <div className="wg-loading" style={{ height: 520 }}><span className="bar-l" style={{ width: '50%' }} /></div>
            <div className="wg-loading" style={{ height: 560 }}><span className="bar-l" style={{ width: '40%' }} /></div>
          </div>
        ) : error ? (
          <InlineNotice tone="neg" title="Couldn't load invoice templates.">
            {error} <Button variant="quiet" onClick={() => void refetch()}>Try again</Button>
          </InlineNotice>
        ) : tab === 'customers' ? (
          <CustomerAssignments templates={templates} />
        ) : templates.length === 0 ? (
          <div className="mb-design-empty">
            <h2 className="t-section">No invoice templates yet</h2>
            <p>
              {companyName}&apos;s invoices use the built-in design: Electric Blue, standard columns, no logo. Create a
              template to add your logo and brand colour, choose columns, and print your terms and payment instructions.
            </p>
            <Button variant="primary" onClick={() => void createFirst()} icon="plus">Create the first template</Button>
          </div>
        ) : (
          <div className="mb-design-grid">
            <div className="mb-design-col">
              <TemplateList templates={templates} selectedId={selectedId} onSelect={choose} />
              {selected && (
                <div className="btn-row" style={{ marginTop: 12, flexWrap: 'wrap' }}>
                  <Button onClick={() => void duplicate()}>Duplicate</Button>
                  {!selected.is_default && <Button onClick={() => void makeDefault()}>Make default</Button>}
                  {!selected.is_default && <Button variant="danger" onClick={() => setConfirmDelete(true)}>Delete</Button>}
                </div>
              )}
              {selected?.is_default && (
                <p className="t-cap" style={{ marginTop: 8 }}>
                  <Tag>Default</Tag> {selected.location_id ? `Used for every ${companyName} invoice` : 'Used for every company without its own default'} unless the customer or invoice has its own template.
                </p>
              )}
            </div>
            <div className="mb-design-col">
              {draft && (
                <TemplateEditor
                  draft={draft}
                  errors={errors}
                  locationId={activeCompanyId}
                  onChange={setDraft}
                  footer={
                    <div className="mb-design-savebar">
                      <Button variant="primary" chord="mod+s" onClick={() => void save()} disabled={!dirty || hasErrors || saving} aria-busy={saving || undefined}>
                        {saving ? 'Saving…' : 'Save'}
                      </Button>
                      <Button onClick={() => selected && setDraft(bodyFromTemplate(selected))} disabled={!dirty || saving}>Discard changes</Button>
                      <span className="t-cap" style={{ marginLeft: 'auto' }}>
                        {hasErrors ? 'Fix the highlighted fields to save.' : dirty ? 'Unsaved changes' : 'All changes saved'}
                      </span>
                    </div>
                  }
                />
              )}
            </div>
            <div className="mb-design-col mb-design-preview">
              {draft && <TemplatePreview draft={draft} valid={!hasErrors} locationId={activeCompanyId} />}
            </div>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={remove}
        tone="danger"
        title={`Delete ${selected?.name ?? 'this template'}?`}
        confirmLabel="Delete template"
      >
        {selected && (selected.customers > 0 || selected.invoices > 0)
          ? `${selected.customers} customer${selected.customers === 1 ? '' : 's'} and ${selected.invoices} invoice${selected.invoices === 1 ? '' : 's'} use it. They will use the company default instead. Amounts never change.`
          : 'No customer or invoice uses it. This cannot be undone.'}
      </ConfirmDialog>

      <ConfirmDialog
        open={confirmDiscard !== null}
        onClose={() => setConfirmDiscard(null)}
        onConfirm={() => {
          const t = templates.find((x) => x.id === confirmDiscard);
          if (t) { setSelectedId(t.id); setDraft(bodyFromTemplate(t)); }
        }}
        tone="danger"
        title="Discard unsaved changes?"
        confirmLabel="Discard changes"
      >
        You changed {draft?.name ?? 'this template'} and haven&apos;t saved. Switching templates throws those changes away.
      </ConfirmDialog>
    </div>
  );
}
