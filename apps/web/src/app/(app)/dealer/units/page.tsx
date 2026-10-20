export const dynamic = 'force-dynamic';

import { UnitsRegister, type UnitsQuery } from './units-register';

/**
 * Unit register (FPB §3.6–3.7, R3, DL-4/DL-12; D2 slice A). Honors the canonical
 * drill query (lib/dealer/ui/links.ts → dealerLinks.units): status, condition,
 * minAge, maxAge, floored=yes|no, q. Guard + client scope: ../layout.tsx.
 */
function one(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return s && s.trim() ? s.trim() : undefined;
}

function int(v: string | undefined): number | undefined {
  if (!v || !/^\d{1,5}$/.test(v)) return undefined;
  return Number(v);
}

export default function UnitsPage({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const floored = one(searchParams.floored);
  const initial: UnitsQuery = {
    status: one(searchParams.status),
    condition: one(searchParams.condition),
    minAge: int(one(searchParams.minAge)),
    maxAge: int(one(searchParams.maxAge)),
    floored: floored === 'yes' || floored === 'no' ? floored : undefined,
    q: one(searchParams.q),
  };
  return <UnitsRegister initial={initial} />;
}
