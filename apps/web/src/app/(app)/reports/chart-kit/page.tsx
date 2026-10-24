import { requirePagePermission } from '@/lib/rbac/page-guard';
import { ChartGallery } from '@/components/charts/gallery/chart-gallery';

export const metadata = { title: 'Chart kit' };

/**
 * CHART KIT GALLERY (Slice 3C) — internal QA for the ChartCard frame and every
 * chart type, in every state. SAMPLE figures only (components/charts/gallery/
 * samples.ts), each card tagged "Sample". Not in navigation. Guarded to
 * internal administrators (settings_system:view, internalOnly) and fails
 * closed before any client JS.
 */
export default async function ChartKitPage() {
  await requirePagePermission('settings_system', 'view');
  return <ChartGallery />;
}
