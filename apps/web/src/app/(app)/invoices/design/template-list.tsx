'use client';

import { Tag } from '@meritbooks/merit-ui';
import type { InvoiceTemplate } from '@/lib/invoices/templates/types';

export interface ListedTemplate extends InvoiceTemplate {
  scope: 'COMPANY' | 'ORGANIZATION';
  customers: number;
  invoices: number;
}

const LAYOUT_NAME: Record<InvoiceTemplate['style'], string> = {
  MODERN: 'Modern', CLASSIC: 'Classic', MINIMAL: 'Minimal', BOLD: 'Bold', COMPACT: 'Compact',
};

/** The template library for one company (its own templates first, then organization-wide). */
export function TemplateList({
  templates, selectedId, onSelect,
}: { templates: ListedTemplate[]; selectedId: string | null; onSelect: (id: string) => void }) {
  const own = templates.filter((t) => t.scope === 'COMPANY');
  const org = templates.filter((t) => t.scope === 'ORGANIZATION');
  const group = (title: string, rows: ListedTemplate[]) =>
    rows.length === 0 ? null : (
      <div>
        <div className="mb-design-list-head"><span className="eyebrow">{title}</span><span className="t-cap tnum">{rows.length}</span></div>
        {rows.map((t) => (
          <button
            key={t.id ?? t.name}
            type="button"
            className="mb-design-item"
            aria-current={t.id === selectedId}
            onClick={() => t.id && onSelect(t.id)}
          >
            <span className="mb-design-item-name">
              <span>{t.name}</span>
              {t.is_default && <Tag tone="ai">Default</Tag>}
            </span>
            <span className="mb-design-item-meta" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <i className="mb-design-swatch" style={{ background: t.accent_color }} aria-hidden="true" />
              {LAYOUT_NAME[t.style]} · {t.customers} customer{t.customers === 1 ? '' : 's'} · {t.invoices} invoice{t.invoices === 1 ? '' : 's'}
            </span>
          </button>
        ))}
      </div>
    );
  return (
    <nav className="mb-design-list" aria-label="Invoice templates">
      {group('This company', own)}
      {group('All companies', org)}
    </nav>
  );
}
