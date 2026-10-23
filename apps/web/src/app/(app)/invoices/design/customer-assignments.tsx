'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button, InlineNotice, ListPager, Search, Select, Input } from '@meritbooks/merit-ui';
import { useQuery, useDebounce, addToast } from '@/hooks';
import { api } from '@/lib/api-client';
import type { ListedTemplate } from './template-list';

interface CustomerRow { id: string; name: string; email: string | null; templateId: string | null; ccEmails: string[] }
interface Resp { customers: CustomerRow[]; pagination: { page: number; per_page: number; total: number; total_pages: number } }

/**
 * Which template each customer gets, and who is copied on their invoices. A customer
 * with no template uses the company default; an invoice can still pick its own.
 */
export function CustomerAssignments({ templates }: { templates: ListedTemplate[] }) {
  const [search, setSearch] = useState('');
  const q = useDebounce(search, 300);
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [q]);
  const params = useMemo(() => ({ page: String(page), ...(q.trim() ? { search: q.trim() } : {}) }), [page, q]);
  const { data, isLoading, error, refetch } = useQuery<Resp>('/api/invoice-templates/assignments', params);

  const [edits, setEdits] = useState<Record<string, { templateId: string | null; cc: string }>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const defaultName = templates.find((t) => t.is_default && t.location_id)?.name ?? templates.find((t) => t.is_default)?.name ?? 'Built-in';

  async function save(row: CustomerRow) {
    const e = edits[row.id];
    if (!e) return;
    setSaving(row.id);
    const res = await api.put<{ ok: boolean }>('/api/invoice-templates/assignments', {
      customer_id: row.id, template_id: e.templateId, cc_emails: e.cc,
    });
    setSaving(null);
    if (res.error) { addToast('error', res.error.error || `Could not save ${row.name}.`); return; }
    addToast('success', `Saved ${row.name}`);
    setEdits((m) => { const n = { ...m }; delete n[row.id]; return n; });
    await refetch();
  }

  const rows = data?.customers ?? [];

  return (
    <div className="mb-design-cust">
      <div className="mb-design-cust-tools">
        <Search aria-label="Search customers" placeholder="Search customers" value={search} onChange={(e) => setSearch(e.target.value)} />
        <span className="t-cap" style={{ marginLeft: 'auto' }}>No template = the company default ({defaultName})</span>
      </div>
      {error ? (
        <div style={{ padding: 16 }}>
          <InlineNotice tone="neg" title="Couldn't load customers.">{error} <Button variant="quiet" onClick={() => void refetch()}>Try again</Button></InlineNotice>
        </div>
      ) : isLoading && !data ? (
        <div className="wg-loading" style={{ height: 240 }} aria-busy="true"><span className="bar-l" style={{ width: '60%' }} /></div>
      ) : rows.length === 0 ? (
        <div className="mb-design-empty" style={{ border: 0 }}>
          <h2 className="t-section">{q ? 'No customers match' : 'No customers yet'}</h2>
          <p>{q ? 'Try a different name or email.' : 'Add customers in Customers, then give them a template here.'}</p>
        </div>
      ) : (
        <>
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr><th>Customer</th><th>Template</th><th>Always copy (CC)</th><th aria-label="Actions" /></tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const e = edits[r.id];
                  const templateId = e ? e.templateId : r.templateId;
                  const cc = e ? e.cc : r.ccEmails.join(', ');
                  const assignedMissing = !!templateId && !templates.some((t) => t.id === templateId);
                  return (
                    <tr key={r.id}>
                      <td>
                        <b style={{ fontWeight: 600 }}>{r.name}</b>
                        <div className="t-cap">{r.email ?? 'No email on file'}</div>
                      </td>
                      <td>
                        <Select aria-label={`Template for ${r.name}`} value={templateId ?? ''}
                          onChange={(ev) => setEdits((m) => ({ ...m, [r.id]: { templateId: ev.target.value || null, cc } }))}>
                          <option value="">Company default ({defaultName})</option>
                          {templates.map((t) => <option key={t.id ?? t.name} value={t.id ?? ''}>{t.name}{t.scope === 'ORGANIZATION' ? ' · all companies' : ''}</option>)}
                          {assignedMissing && <option value={templateId ?? ''}>Another company&apos;s template</option>}
                        </Select>
                      </td>
                      <td>
                        <Input aria-label={`CC list for ${r.name}`} placeholder="ap@customer.com, pm@customer.com" value={cc}
                          onChange={(ev) => setEdits((m) => ({ ...m, [r.id]: { templateId, cc: ev.target.value } }))} />
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <Button variant={e ? 'primary' : 'default'} disabled={!e || saving === r.id} aria-busy={saving === r.id || undefined} onClick={() => void save(r)}>
                          {saving === r.id ? 'Saving…' : 'Save'}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {data && data.pagination.total_pages > 1 && (
            <ListPager page={data.pagination.page} perPage={data.pagination.per_page} total={data.pagination.total} onPage={setPage} noun="customers" />
          )}
        </>
      )}
    </div>
  );
}
