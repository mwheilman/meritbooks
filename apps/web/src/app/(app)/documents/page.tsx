import { DocumentsCenter } from './documents-center';

export const metadata = {
  title: 'Documents',
};

/**
 * DOCUMENTS (FPB-document-intelligence §8) — every stored file, typed and routed to the
 * module it belongs to as a proposal for review. Built on merit-ui. Page-level RBAC lives
 * in layout.tsx (audit_trail:view, fails closed before any client JS).
 */
export default function DocumentsPage() {
  return <DocumentsCenter />;
}
