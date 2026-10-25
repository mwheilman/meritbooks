/**
 * Recipe helpers: adapters are written with the source tool's literal column headers; these
 * normalize them once (the same normHeader the matcher uses) so a field map reads like the export.
 */
import { normHeader } from '../../onboarding/import/automap';
import type { AdapterEntity, ImportEntity } from '../types';

/** One export file: literal headers → field keys. The first `signature` headers identify the file. */
export function recipe(entity: ImportEntity, label: string, fixture: string, columns: Record<string, string>, signature?: string[]): AdapterEntity {
  const cols: Record<string, string> = {};
  for (const [h, field] of Object.entries(columns)) cols[normHeader(h)] = field;
  const sig = (signature ?? Object.keys(columns)).map(normHeader);
  return { entity, label, fixture, columns: cols, signature: sig };
}
