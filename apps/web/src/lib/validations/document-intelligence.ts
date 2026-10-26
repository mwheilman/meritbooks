import { z } from 'zod';
import { DOC_CLASSES, TARGET_KINDS } from '@/lib/documents/intelligence/types';

const recordType = z.string().trim().regex(/^[a-z][a-z0-9_]*$/).max(64);

export const intelligenceListQuery = z.object({
  /** Comma-separated document ids (the center's current page), ≤ 100. */
  document_ids: z.string().trim().max(4000).optional(),
  status: z.enum(['needs_review', 'proposal_created', 'routed', 'accepted', 'linked', 'dismissed', 'duplicate', 'queued', 'classified']).optional(),
  /** The catalog type (lib/documents/catalog.ts) — the center's "Filter by type". Combines with status. */
  doc_class: z.enum(DOC_CLASSES).optional(),
});

export const analyzeBody = z.union([
  z.object({ document_id: z.string().uuid(), force: z.boolean().optional() }),
  z.object({ all: z.literal(true), limit: z.number().int().min(1).max(50).optional() }),
]);
export type AnalyzeBody = z.infer<typeof analyzeBody>;

export const updateIntelligenceBody = z.discriminatedUnion('action', [
  z.object({ action: z.literal('change_type'), document_id: z.string().uuid(), doc_class: z.enum(DOC_CLASSES) }),
  z.object({ action: z.literal('set_company'), document_id: z.string().uuid(), location_id: z.string().uuid() }),
  z.object({ action: z.literal('dismiss'), document_id: z.string().uuid(), note: z.string().trim().max(500).optional() }),
  z.object({ action: z.literal('link'), document_id: z.string().uuid(), target_type: recordType, target_id: z.string().uuid() }),
]);
export type UpdateIntelligenceBody = z.infer<typeof updateIntelligenceBody>;

export const proposalsQuery = z.object({
  id: z.string().uuid().optional(),
  target_kind: z.enum(TARGET_KINDS).optional(),
  status: z.enum(['pending', 'accepted', 'dismissed', 'superseded', 'failed', 'all']).optional(),
  location_id: z.string().uuid().optional(),
});

export const decideProposalBody = z.discriminatedUnion('action', [
  z.object({ action: z.literal('accept'), proposal_id: z.string().uuid(), target_type: recordType, target_id: z.string().uuid(), note: z.string().trim().max(500).optional() }),
  z.object({ action: z.literal('dismiss'), proposal_id: z.string().uuid(), note: z.string().trim().max(500).optional() }),
]);
export type DecideProposalBody = z.infer<typeof decideProposalBody>;

export const linksQuery = z
  .object({
    document_id: z.string().uuid().optional(),
    target_type: recordType.optional(),
    target_id: z.string().uuid().optional(),
  })
  .refine((q) => !!q.document_id || (!!q.target_type && !!q.target_id), { message: 'document_id or target_type + target_id is required' });

export const unlinkBody = z.object({ link_id: z.string().uuid() });

export const linkTargetsQuery = z.object({
  type: recordType,
  q: z.string().trim().max(80).optional(),
  location_id: z.string().uuid().optional(),
});
