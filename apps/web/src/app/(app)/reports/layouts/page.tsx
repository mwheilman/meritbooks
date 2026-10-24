import { LayoutDesigner } from '../engine/layout-designer';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Statement layouts' };

/** /reports/layouts — the custom row designer (FPB-financial-reports §4 AC3A.24). */
export default function StatementLayoutsPage() {
  return <LayoutDesigner />;
}
