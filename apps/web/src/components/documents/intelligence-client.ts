'use client';

/**
 * Client helpers for document intelligence (FPB-document-intelligence §8): the shapes the
 * API returns, where a proposal opens, and the "the module made the record" call.
 */

import { useCallback, useEffect, useState } from 'react';
import { api } from '@meritbooks/merit-ui';
import { TARGETS, type ProposalDto, type ProposalSummaryDto, type TargetKind } from '@/lib/documents/intelligence/types';

export interface ProposalDocument {
  id: string;
  file_name: string;
  mime_type: string | null;
  created_at: string;
}

export interface ProposalWithDoc extends ProposalDto {
  document: ProposalDocument | null;
}

/** A proposal as the LIST returns it (no extracted terms — load the detail for those). */
export interface ProposalSummaryWithDoc extends ProposalSummaryDto {
  document: ProposalDocument | null;
}

/** One proposal with its extracted terms (the detail read; TIN-redacted). */
export async function loadDocumentProposal(id: string): Promise<{ proposal: ProposalWithDoc | null; error: string | null }> {
  const r = await api.get<{ data: ProposalDto; document: ProposalDocument | null }>('/api/documents/proposals', { id });
  if (r.error || !r.data) return { proposal: null, error: r.error?.error ?? 'Could not load the proposal.' };
  return { proposal: { ...r.data.data, document: r.data.document }, error: null };
}

/** Where "Review" goes for a proposal: staged → the module page carrying ?proposal=. */
export function proposalHref(p: Pick<ProposalSummaryDto, 'id' | 'target_kind' | 'mode' | 'target_href' | 'native_id' | 'document_id'>): string {
  const base = p.target_href || TARGETS[p.target_kind].href;
  if (p.mode === 'staged') return `${base}${base.includes('?') ? '&' : '?'}proposal=${encodeURIComponent(p.id)}`;
  // A native draft not lodged yet (needs a company / vendor) is finished in Documents.
  if (p.mode === 'native' && !p.native_id) return `/documents?doc=${encodeURIComponent(p.document_id)}`;
  return base;
}

/** Open a stored document in a new tab (view) or download it, via a short-lived signed URL. */
export async function openDocument(documentId: string, mode: 'view' | 'download' = 'view'): Promise<string | null> {
  const r = await api.get<{ url: string; fileName: string }>(`/api/documents/${encodeURIComponent(documentId)}/signed-url`, mode === 'view' ? { download: '0' } : undefined);
  if (r.error || !r.data) return r.error?.error ?? 'Could not open the document.';
  window.open(r.data.url, '_blank', 'noopener,noreferrer');
  return null;
}

/** After the module's own create path made the record: link the document both ways. */
export async function acceptDocumentProposal(proposalId: string, targetType: string, targetId: string): Promise<string | null> {
  const r = await api.post<{ message: string }>('/api/documents/proposals/decide', { action: 'accept', proposal_id: proposalId, target_type: targetType, target_id: targetId });
  return r.error ? r.error.error : null;
}

export async function dismissDocumentProposal(proposalId: string, note?: string): Promise<string | null> {
  const r = await api.post<{ message: string }>('/api/documents/proposals/decide', { action: 'dismiss', proposal_id: proposalId, note });
  return r.error ? r.error.error : null;
}

/**
 * The proposal a module page was opened with (`?proposal=<id>`), loaded once, for the
 * module to pre-fill its own review form. `clear()` drops the param from the URL.
 * Reads `window.location` after mount (no useSearchParams → no Suspense boundary needed
 * on the module's page).
 */
export function useDocumentProposal(kind: TargetKind): {
  proposal: ProposalWithDoc | null;
  error: string | null;
  clear: () => void;
} {
  const [id, setId] = useState<string | null>(null);
  const [proposal, setProposal] = useState<ProposalWithDoc | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setId(new URLSearchParams(window.location.search).get('proposal'));
  }, []);

  useEffect(() => {
    let live = true;
    if (!id) {
      setProposal(null);
      return;
    }
    void api.get<{ data: ProposalDto; document: ProposalDocument | null }>('/api/documents/proposals', { id }).then((r) => {
      if (!live) return;
      if (r.error || !r.data) {
        setError(r.error?.error ?? 'Could not load the proposal.');
        return;
      }
      if (r.data.data.target_kind !== kind) {
        setError('That proposal belongs to another module.');
        return;
      }
      if (r.data.data.status !== 'pending') {
        setError('That proposal was already handled.');
        return;
      }
      setProposal({ ...r.data.data, document: r.data.document });
    });
    return () => {
      live = false;
    };
  }, [id, kind]);

  const clear = useCallback(() => {
    setProposal(null);
    setId(null);
    const url = new URL(window.location.href);
    if (url.searchParams.has('proposal')) {
      url.searchParams.delete('proposal');
      window.history.replaceState(null, '', url.toString());
    }
  }, []);

  return { proposal, error, clear };
}
