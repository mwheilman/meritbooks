export const dynamic = 'force-dynamic';

import type { ImportFileKind } from '@/lib/dealer/types';
import { ImportsScreen } from './_components/imports-screen';

/**
 * Dealer imports (FPB-dealer-pack §8, D2 slice E). Page guard + one-client scope live in
 * ../layout.tsx. `?new=1` opens the wizard; `?kind=OPENING` (etc.) preselects the kind —
 * Settings links here for the go-live opening import.
 */
const KINDS: readonly ImportFileKind[] = ['UNITS', 'DEALS', 'WARRANTY', 'LENDER_STATEMENT', 'LENDER_AUDIT', 'OEM_STATEMENT', 'PROGRAMS', 'OPENING'];

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default function DealerImportsPage({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const k = one(searchParams.kind);
  const kind = k && (KINDS as readonly string[]).includes(k) ? (k as ImportFileKind) : null;
  const open = one(searchParams.new) === '1' || kind !== null;
  return <ImportsScreen initialWizard={{ open, kind }} />;
}
