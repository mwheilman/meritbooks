'use client';

import { useMemo, useState } from 'react';
import { Check, Field, Search, Select, useDebounce } from '@meritbooks/merit-ui';
import type { CompanyOption } from './automation-types';
import s from './automation.module.css';

/** "Default for every company" or one company's override. */
export function ScopePicker({
  companies,
  overrides,
  value,
  onChange,
}: {
  companies: CompanyOption[];
  overrides: ReadonlySet<string>;
  value: string | null;
  onChange: (locationId: string | null) => void;
}) {
  return (
    <Field label="Applies to" help={value ? (overrides.has(value) ? 'This company has its own settings.' : 'This company uses the default today. Saving here gives it its own settings.') : 'Every company without its own settings uses these.'}>
      <Select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">Default for every company</option>
        {companies.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
            {overrides.has(c.id) ? ' (own settings)' : ''}
          </option>
        ))}
      </Select>
    </Field>
  );
}

/** A searchable checkbox list of customers (excluded / included customers). */
export function CustomerPicker({
  label,
  help,
  customers,
  selected,
  onChange,
}: {
  label: string;
  help?: string;
  customers: Array<{ id: string; name: string }>;
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const [q, setQ] = useState('');
  const dq = useDebounce(q, 200);
  const set = useMemo(() => new Set(selected), [selected]);
  const shown = useMemo(() => {
    const needle = dq.trim().toLowerCase();
    const list = needle ? customers.filter((c) => c.name.toLowerCase().includes(needle)) : customers;
    // Selected first, then alphabetical; cap the list so a large book stays responsive.
    return [...list].sort((a, b) => Number(set.has(b.id)) - Number(set.has(a.id)) || a.name.localeCompare(b.name)).slice(0, 200);
  }, [customers, dq, set]);
  return (
    <Field label={`${label}${selected.length ? ` · ${selected.length} picked` : ''}`} help={help}>
      <div>
        <Search aria-label={`Search customers for ${label.toLowerCase()}`} placeholder="Search customers" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className={s.picker} role="group" aria-label={label}>
          {shown.length === 0 ? (
            <span className="ink-3">No customers match.</span>
          ) : (
            shown.map((c) => (
              <Check
                key={c.id}
                label={c.name}
                checked={set.has(c.id)}
                onChange={(e) => onChange(e.target.checked ? [...selected, c.id] : selected.filter((x) => x !== c.id))}
              />
            ))
          )}
        </div>
      </div>
    </Field>
  );
}
