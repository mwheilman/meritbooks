'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, ConfirmDialog, InlineNotice, Tag } from '@meritbooks/merit-ui';
import { PageHeader } from '@/components/ui';
import { addToast, useQuery } from '@/hooks';
import { api } from '@/lib/api-client';
import { announceShellBrand } from '@/components/layout/tenant-brand';
import { pickBrand } from '@/lib/branding/resolve';
import { shellBrandOf } from '@/lib/branding/shell';
import { draftFromProfile, draftIsSavable, draftToPayload, draftsEqual, previewBrand, type BrandDraft } from '@/lib/branding/draft';
import type { BrandOverview } from '@/lib/branding/service';
import type { BrandProfile, ResolvedBrand } from '@/lib/branding/types';
import { BrandEditor } from './brand-editor';
import { BrandPreview } from './brand-preview';
import './brand.css';

/**
 * Settings → Brand (FPB-branding §5). The tenant brand and every company's brand: upload
 * logos, the colours are read from the logo and 2–3 accessible palettes suggested, override
 * any colour by hex with live contrast checks, pick the type, preview the invoice / email /
 * pay page / portal, save. A company either uses the tenant brand or has its own.
 */

type Scope = 'tenant' | string;

function Swatches({ b }: { b: ResolvedBrand }) {
  return (
    <span className="mb-brand-mini" aria-hidden="true">
      {[b.palette.primary, b.palette.secondary, b.palette.accent, b.palette.surface].map((c, i) => (
        <i key={i} style={{ background: c }} />
      ))}
    </span>
  );
}

export function BrandSettings({ initialCompany }: { initialCompany: string | null }) {
  const { data, isLoading, error, refetch } = useQuery<BrandOverview>('/api/settings/brand', undefined, { scope: false });
  const [scope, setScope] = useState<Scope>(initialCompany ?? 'tenant');
  const [draft, setDraft] = useState<BrandDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [pendingScope, setPendingScope] = useState<Scope | null>(null);

  const company = useMemo(() => (scope === 'tenant' ? null : data?.companies.find((c) => c.locationId === scope) ?? null), [data, scope]);
  const kind: 'tenant' | 'company' = scope === 'tenant' ? 'tenant' : 'company';
  const saved: BrandProfile | null = kind === 'tenant' ? data?.tenant ?? null : company?.profile ?? null;
  const tenantResolved = data?.tenantResolved ?? null;
  const baseline = useMemo(
    () => (data ? draftFromProfile(saved, kind === 'tenant' ? tenantResolved : company?.resolved ?? tenantResolved) : null),
    [data, saved, kind, tenantResolved, company],
  );

  // A stale ?company= (deleted / out of scope) falls back to the tenant brand.
  useEffect(() => {
    if (data && scope !== 'tenant' && !data.companies.some((c) => c.locationId === scope)) setScope('tenant');
  }, [data, scope]);

  // Re-seed the draft whenever the scope (or the saved row) changes.
  useEffect(() => {
    setDraft(baseline);
    setServerError(null);
  }, [baseline]);

  const dirty = !!draft && !!baseline && !draftsEqual(draft, baseline);
  const savable = !!draft && draftIsSavable(draft, kind);
  const preview = draft && tenantResolved ? previewBrand(draft, kind, tenantResolved) : null;

  const choose = (next: Scope) => {
    if (next === scope) return;
    if (dirty) setPendingScope(next);
    else setScope(next);
  };

  const save = useCallback(async () => {
    if (!draft || !data) return;
    setSaving(true);
    setServerError(null);
    const locationId = kind === 'tenant' ? null : scope;
    const res = await api.put<{ profile: BrandProfile }>('/api/settings/brand', draftToPayload(draft, locationId));
    setSaving(false);
    if (res.error || !res.data) {
      const msg = res.status === 403 ? 'You do not have permission to change the brand.' : res.error?.error ?? 'The brand could not be saved.';
      setServerError(msg);
      addToast('error', msg);
      return;
    }
    if (kind === 'tenant') announceShellBrand(shellBrandOf(pickBrand(res.data.profile, null), data.orgName));
    addToast('success', kind === 'tenant' ? 'Saved the tenant brand' : `Saved the brand for ${company?.name ?? 'the company'}`);
    await refetch();
  }, [draft, data, kind, scope, company, refetch]);

  const reset = useCallback(async () => {
    const q = kind === 'tenant' ? '' : `?location_id=${encodeURIComponent(scope)}`;
    const res = await api.delete<{ ok: boolean }>(`/api/settings/brand${q}`);
    if (res.error) {
      addToast('error', res.error.error || 'Could not reset the brand.');
      return;
    }
    if (kind === 'tenant') announceShellBrand(null);
    addToast('success', kind === 'tenant' ? 'The tenant brand is back to the Merit default' : `${company?.name ?? 'The company'} uses the tenant brand again`);
    await refetch();
  }, [kind, scope, company, refetch]);

  // ⌘S saves.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (dirty && savable && !saving) void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dirty, savable, saving, save]);

  const header = (
    <PageHeader
      eyebrow={['Settings', 'Brand']}
      title="Brand"
      description="Your logo and colours on invoices, statements, emails, the pay page and the customer and vendor portals. Upload your logo and we pick colours that match it and stay easy to read."
    />
  );

  if (isLoading && !data) {
    return (
      <div className="density-cockpit">
        {header}
        <div className="mb-brand-grid" aria-busy="true">
          <div className="wg-loading" style={{ height: 320 }}><span className="bar-l" style={{ width: '70%' }} /></div>
          <div className="wg-loading" style={{ height: 560 }}><span className="bar-l" style={{ width: '50%' }} /></div>
          <div className="wg-loading" style={{ height: 560 }}><span className="bar-l" style={{ width: '40%' }} /></div>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="density-cockpit">
        {header}
        <InlineNotice tone="neg" title="Couldn't load the brand settings.">
          {error ?? 'Something went wrong.'} <Button variant="quiet" onClick={() => void refetch()}>Try again</Button>
        </InlineNotice>
      </div>
    );
  }

  const sourceLabel = (r: ResolvedBrand, own: boolean) =>
    own ? 'Own brand' : r.source === 'TENANT' ? 'Uses the tenant brand' : 'Merit default';

  return (
    <div className="density-cockpit">
      {header}
      <div className="mb-brand-grid">
        <nav className="mb-brand-list" aria-label="Brands">
          <button type="button" className="mb-brand-item" aria-current={scope === 'tenant'} onClick={() => choose('tenant')}>
            <span className="mb-brand-item-name">
              <span>{data.orgName}</span>
              <Tag>Tenant</Tag>
            </span>
            <span className="mb-brand-item-meta">
              <Swatches b={data.tenantResolved} />
              {data.tenant ? (data.tenant.logo_url ? 'Logo and colours set' : 'Colours set, no logo') : 'Merit default'}
            </span>
          </button>
          {data.companies.length === 0 ? (
            <p className="mb-brand-list-empty">No active companies yet. Companies you add use the tenant brand.</p>
          ) : (
            data.companies.map((c) => {
              const own = !!c.profile && !c.profile.use_tenant_brand;
              return (
                <button key={c.locationId} type="button" className="mb-brand-item" aria-current={scope === c.locationId} onClick={() => choose(c.locationId)}>
                  <span className="mb-brand-item-name">
                    <span>{c.name}</span>
                    {c.shortCode && <span className="t-cap">{c.shortCode}</span>}
                  </span>
                  <span className="mb-brand-item-meta">
                    <Swatches b={c.resolved} />
                    {sourceLabel(c.resolved, own)}
                  </span>
                </button>
              );
            })
          )}
        </nav>

        <div className="mb-brand-col">
          {draft && (
            <BrandEditor
              kind={kind}
              scopeName={kind === 'tenant' ? data.orgName : company?.name ?? ''}
              locationId={kind === 'tenant' ? null : scope}
              draft={draft}
              onChange={setDraft}
              tenantResolved={data.tenantResolved}
              onEditTenant={() => choose('tenant')}
            />
          )}
          {serverError && (
            <div style={{ marginTop: 12 }}>
              <InlineNotice tone="neg" title="Not saved.">{serverError}</InlineNotice>
            </div>
          )}
          <div className="mb-brand-savebar">
            <Button variant="primary" chord="mod+s" onClick={() => void save()} disabled={!dirty || !savable || saving} aria-busy={saving || undefined}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
            <Button onClick={() => baseline && setDraft(baseline)} disabled={!dirty || saving}>Discard changes</Button>
            {saved && (
              <Button variant="danger" onClick={() => setConfirmReset(true)} disabled={saving}>
                {kind === 'tenant' ? 'Reset to Merit default' : 'Remove company brand'}
              </Button>
            )}
            <span className="t-cap" style={{ marginLeft: 'auto' }}>
              {!savable ? 'Fix the colours marked below to save.' : dirty ? 'Unsaved changes' : saved ? 'All changes saved' : 'Not saved yet'}
            </span>
          </div>
        </div>

        <div className="mb-brand-col mb-brand-preview-col">
          {preview && <BrandPreview brand={preview} name={kind === 'tenant' ? data.orgName : company?.name ?? data.orgName} />}
        </div>
      </div>

      <ConfirmDialog
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        onConfirm={reset}
        tone="danger"
        title={kind === 'tenant' ? 'Reset the tenant brand?' : `Remove ${company?.name ?? 'this company'}'s brand?`}
        confirmLabel={kind === 'tenant' ? 'Reset to Merit default' : 'Remove company brand'}
      >
        {kind === 'tenant'
          ? 'Every company that uses the tenant brand goes back to the Merit default look on its invoices, emails and portals. Uploaded logo files stay in storage. Amounts never change.'
          : 'This company goes back to the tenant brand on its invoices, emails and portals. Amounts never change.'}
      </ConfirmDialog>

      <ConfirmDialog
        open={pendingScope !== null}
        onClose={() => setPendingScope(null)}
        onConfirm={() => {
          if (pendingScope) setScope(pendingScope);
          setPendingScope(null);
        }}
        tone="danger"
        title="Discard unsaved changes?"
        confirmLabel="Discard changes"
      >
        You changed this brand and haven&apos;t saved. Switching throws those changes away.
      </ConfirmDialog>
    </div>
  );
}
