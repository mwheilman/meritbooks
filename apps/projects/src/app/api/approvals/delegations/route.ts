export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { route } from '@/lib/api';
import { createDelegation, loadDelegations } from '@/lib/approvals/server';
import { ObjectType } from '../schemas';

/** GET /api/approvals/delegations — my cover (given, held, managed) and who can cover me. */
export const GET = route({ access: 'none', mask: false }, async ({ db }) => loadDelegations(db));

const Body = z.object({
  delegateMembershipId: z.string().uuid(),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }),
  maxAmountCents: z.number().int().positive().max(100_000_000_000).nullish(),
  objectTypes: z.array(ObjectType).max(10).default([]),
  notify: z.boolean().default(true),
  reason: z.string().trim().max(500).nullish(),
  delegatorMembershipId: z.string().uuid().nullish(),
});

/** POST /api/approvals/delegations — set up out-of-office cover (never yourself; the engine checks limits). */
export const POST = route({ access: 'none', mask: false, body: Body }, async ({ db, body }) => {
  if (new Date(body.endsAt).getTime() <= new Date(body.startsAt).getTime()) {
    throw new HttpError(422, 'The cover must end after it starts.', 'VALIDATION');
  }
  const id = await createDelegation(db, {
    delegateMembershipId: body.delegateMembershipId, startsAt: body.startsAt, endsAt: body.endsAt,
    maxAmountCents: body.maxAmountCents ?? null, objectTypes: body.objectTypes, notify: body.notify,
    reason: body.reason || null, delegatorMembershipId: body.delegatorMembershipId ?? null,
  });
  return { id };
});
