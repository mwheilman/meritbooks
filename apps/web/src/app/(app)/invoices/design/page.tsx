export const dynamic = 'force-dynamic';

import { requirePagePermission } from '@/lib/rbac/page-guard';
import { CompanyScopeGuard } from '@/components/company-scope-guard';
import { DesignClient } from './design-client';
import './design.css';

export const metadata = { title: 'Invoice design' };

/**
 * INVOICES → DESIGN (Slice 1B, FPB-invoices §4). How customer invoices look and what
 * they print: a template library per company (plus organization-wide templates), a
 * live PDF preview while you edit, and which template each customer gets.
 * Viewing needs invoices:view; editing templates needs invoices:approve (the routes
 * enforce it); assigning a customer's template needs invoices:create.
 */
export default async function InvoiceDesignPage() {
  await requirePagePermission('invoices', 'view');
  return (
    <CompanyScopeGuard
      title="Pick a company to design its invoices"
      description="Each company has its own invoice templates, logo and brand colour. Choose the company whose invoices you want to design."
    >
      <DesignClient />
    </CompanyScopeGuard>
  );
}
