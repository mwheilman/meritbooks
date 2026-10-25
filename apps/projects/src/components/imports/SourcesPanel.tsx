'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ButtonLink, InlineNotice, Tag, WidgetState } from '@meritbooks/merit-ui';
import type { CommitResult, ImportEntity, OpeningKind, SourceSystem } from '@/lib/imports/types';
import { getJson } from './api';
import '../../app/onboarding/onboarding.css';
import './imports.css';
import { FileImport } from './FileImport';
import type { CatalogResponse, SourceCard } from './types';

const FAMILY: Record<SourceCard['family'], string> = {
  residential: 'Builders and remodelers', field_service: 'Service and maintenance', dealer: 'Equipment dealers', commercial: 'Commercial jobs under way',
  accounting: 'Accounting', generic: 'Spreadsheets',
};
const ORDER: SourceCard['family'][] = ['residential', 'field_service', 'dealer', 'commercial', 'generic', 'accounting'];

const mono = (name: string) => name.replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase();

export interface CommittedFile {
  source: SourceSystem | null;
  entity: ImportEntity;
  fileName: string;
  result: CommitResult;
  openingKind: OpeningKind | null;
}

/**
 * Step 4 — "Where does your work live today?" (UX §a). Logo tiles of the tools we read (multi-select),
 * each with its illustrated how-to-export card and one drop slot per export file, in the order that
 * links them (customers before the jobs that name them). "Another spreadsheet" takes any file.
 */
export function SourcesPanel({ companyId, booksUrl, preselect, onCommitted }: {
  companyId: string;
  booksUrl: string;
  preselect?: SourceSystem[];
  onCommitted?: (f: CommittedFile) => void;
}) {
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<SourceSystem[]>(preselect ?? []);

  const load = useCallback(async () => {
    const r = await getJson<CatalogResponse>(`/api/imports?companyId=${companyId}`);
    if (r.ok) { setCatalog(r.data); setError(null); } else setError(r.error);
  }, [companyId]);
  useEffect(() => { void load(); }, [load]);

  const grouped = useMemo(() => {
    const m = new Map<SourceCard['family'], SourceCard[]>();
    for (const s of catalog?.sources ?? []) m.set(s.family, [...(m.get(s.family) ?? []), s]);
    return ORDER.filter((f) => m.has(f)).map((f) => ({ family: f, sources: m.get(f)! }));
  }, [catalog]);

  const toggle = (id: SourceSystem) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const brought = (catalog?.batches ?? []).filter((b) => b.status === 'COMMITTED');

  if (error) return <InlineNotice tone="neg" title={error}>Refresh in a moment; nothing you brought in is lost.</InlineNotice>;
  if (!catalog) return <div className="ob-skel" aria-busy="true"><span className="t-cap">Loading the tools we read…</span></div>;

  return (
    <div className="imp-sources">
      {grouped.map((g) => (
        <section key={g.family} aria-labelledby={`imp-f-${g.family}`}>
          <h4 className="imp-fam" id={`imp-f-${g.family}`}>{FAMILY[g.family]}</h4>
          <div className="ob-tiles">
            {g.sources.map((s) => (
              <button key={s.id} type="button" className="ob-tile" aria-pressed={picked.includes(s.id)} onClick={() => toggle(s.id)}>
                <span className="imp-mono" aria-hidden="true">{mono(s.name)}</span>
                <span className="t-head">{s.name}</span>
                <span className="t-cap">{s.files.map((f) => f.label.toLowerCase()).slice(0, 3).join(', ')}{s.files.length > 3 ? '…' : ''}</span>
                {s.viaBooks && <Tag>Through Books</Tag>}
              </button>
            ))}
          </div>
        </section>
      ))}

      {picked.length === 0 && (
        <WidgetState state={{ kind: 'empty', title: 'Pick where your work lives today', body: 'Choose one or more tools above. Each shows the exports to pull and takes them one file at a time; imports keep running while you go on.' }} />
      )}

      {picked.map((id) => {
        const s = catalog.sources.find((x) => x.id === id);
        if (!s) return null;
        return (
          <section key={id} className="ob-card imp-source" aria-labelledby={`imp-s-${id}`}>
            <div className="ob-card-h"><h3 id={`imp-s-${id}`}>From {s.name}</h3><span className="sp" />{s.viaBooks && <ButtonLink variant="quiet" href={`${booksUrl}/onboarding/conversion`} target="_blank" rel="noreferrer" iconAfter="right">QuickBooks import in Books</ButtonLink>}</div>
            <div className="imp-howto">
              <ol>{s.howToExport.map((h) => <li key={h}>{h}</li>)}</ol>
            </div>
            <ul className="imp-files">
              {s.files.map((f) => (
                <li key={f.entity}>
                  <div className="imp-file-h">
                    <span className="l1">{f.label}</span>
                    <span className="t-cap">{f.effect}</span>
                    {brought.some((b) => b.source_system === id && b.entity === f.entity) && <Tag tone="pos">Brought in</Tag>}
                  </div>
                  <FileImport companyId={companyId} source={id} entity={f.entity} label={f.label} compact
                    onCommitted={(r) => { onCommitted?.({ source: id, entity: r.entity, fileName: r.fileName, result: r.result, openingKind: r.openingKind }); void load(); }} />
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      <section className="ob-card imp-source" aria-labelledby="imp-any">
        <div className="ob-card-h"><h3 id="imp-any">Another spreadsheet</h3><span className="t-cap">Any CSV or Excel export. We work out what is in it and ask about the columns we are not sure of.</span></div>
        <div className="ob-card-b">
          <FileImport companyId={companyId} source={null} entity={null} label="spreadsheet"
            onCommitted={(r) => { onCommitted?.({ source: null, entity: r.entity, fileName: r.fileName, result: r.result, openingKind: r.openingKind }); void load(); }} />
        </div>
      </section>
    </div>
  );
}
