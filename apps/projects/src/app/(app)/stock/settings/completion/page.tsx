import type { Metadata } from 'next';
import { ButtonLink } from '@meritbooks/merit-ui';
import { DealerShell } from '@/components/dealer/completion/Shell';
import { CompletionSettingsView } from '@/components/dealer/completion/StoreViews';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';

export const metadata: Metadata = { title: 'Store rules' };
export const dynamic = 'force-dynamic';

/** Lot GPS, recon, QC, texts, storage, rental paperwork, shop capacity and shop fees. */
export default async function StockSettingsCompletionPage() {
  return (
    <DealerShell guard="/stock/settings" title="Store rules" what="Lot GPS, recon, QC, texts, storage, rental paperwork, shop capacity and shop fees." actions={<ButtonLink variant="quiet" href="/stock/settings">Store settings</ButtonLink>}>
      {async ({ companyId, o, today }) => {
      return <CompletionSettingsView companyId={companyId} />;
      }}
    </DealerShell>
  );
}
