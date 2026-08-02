export const dynamic = 'force-dynamic';

/**
 * POST /api/search — the SEARCH / KNOWLEDGE lane (matrix modality M13).
 *
 * A plain-English "find anything" across the owned ledger. Read-only: it runs
 * every query through the RLS-scoped `ctx.supabase`, so results are org-isolated
 * at the database and nothing here writes. The deterministic parser + ranker do
 * the retrieval; the Core AI gateway is consulted ONLY to structure ambiguous
 * intent (never to author SQL or fabricate rows), and the whole thing degrades
 * to pure deterministic parsing when AI is unavailable or budget-blocked.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler } from '@/lib/api-handler';
import { getAnthropicApiKey } from '@/lib/ai/gateway';
import { runSearch } from '@/lib/search/search-service';
import { ALL_SEARCH_TYPES, type SearchType } from '@/lib/search/types';

const searchSchema = z.object({
  query: z.string().trim().min(2).max(500),
  types: z.array(z.enum(ALL_SEARCH_TYPES as unknown as [SearchType, ...SearchType[]])).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

type SearchInput = z.infer<typeof searchSchema>;

export const POST = apiHandler(searchSchema, async (body: SearchInput, ctx) => {
  const response = await runSearch({
    supabase: ctx.supabase,
    orgId: ctx.orgId,
    userId: ctx.userId,
    query: body.query,
    types: body.types,
    limit: body.limit,
    anthropicApiKey: getAnthropicApiKey(),
  });

  return NextResponse.json(response);
});
