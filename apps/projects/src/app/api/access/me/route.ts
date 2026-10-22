/**
 * GET /api/access/me — the caller's effective Projects access, serialized (lib/access/serialize).
 *   → { access: AccessJson, real: { persona, title }, canPreview: boolean }
 * `access` is preview-narrowed when an owner is previewing a role; `real` is who they are, for
 * the "Previewing as Technician — exit" banner. No money in the payload.
 */
import { route } from '@/lib/api';
import { accessToJson } from '@/lib/access/serialize';
import { canPreview } from '@/lib/access/derive';
import { getRealAccess } from '@/lib/access/server';

export const dynamic = 'force-dynamic';

export const GET = route({ access: 'none', mask: false }, async ({ access }) => {
  const real = await getRealAccess();
  return {
    access: accessToJson(access),
    real: { persona: real.persona, title: real.title },
    canPreview: canPreview(real.grants),
  };
});
