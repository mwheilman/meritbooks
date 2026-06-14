'use client';
import { formatMoney } from '@meritbooks/shared';
import { StatusBadge } from '@/components/ui';
import { DetailDrawer, DetailSection, DetailField } from '@/components/detail-drawer';

export interface AssetLike {
  id: string; name: string; assetTag: string | null; serialNumber: string | null; category: string | null;
  acquisitionDate: string; acquisitionCostCents: number; salvageValueCents: number; usefulLifeMonths: number;
  depreciationMethod: string; accumulatedDepreciationCents: number; netBookValueCents: number;
  lastDepreciationDate: string | null; status: string; physicalLocation: string | null; condition: string | null;
  location: { id: string; name: string; short_code: string } | null;
  assignedTo: { id: string; first_name: string; last_name: string } | null;
}

export function AssetDrawer({ asset, onClose }: { asset: AssetLike | null; onClose: () => void }) {
  const depPct = asset && asset.acquisitionCostCents > 0
    ? Math.round((asset.accumulatedDepreciationCents / asset.acquisitionCostCents) * 100) : 0;
  return (
    <DetailDrawer
      open={!!asset} onClose={onClose} width="md"
      title={asset?.name ?? 'Asset'}
      subtitle={asset ? [asset.assetTag, asset.category].filter(Boolean).join(' · ') || null : null}
      headerRight={asset ? <StatusBadge status={asset.status} /> : undefined}
    >
      {asset && (
        <>
          <DetailSection title="Asset">
            <DetailField label="Tag" value={asset.assetTag ?? '--'} />
            <DetailField label="Serial" value={asset.serialNumber ?? '--'} />
            <DetailField label="Category" value={asset.category ?? '--'} />
            <DetailField label="Company" value={asset.location?.name ?? '--'} />
            {asset.physicalLocation && <DetailField label="Physical location" value={asset.physicalLocation} />}
            {asset.assignedTo && <DetailField label="Assigned to" value={`${asset.assignedTo.first_name} ${asset.assignedTo.last_name}`} />}
            {asset.condition && <DetailField label="Condition" value={asset.condition} />}
          </DetailSection>
          <DetailSection title="Depreciation">
            <DetailField label="Method" value={asset.depreciationMethod.replace(/_/g, ' ')} />
            <DetailField label="Acquired" value={asset.acquisitionDate} mono />
            <DetailField label="Cost" value={formatMoney(asset.acquisitionCostCents)} mono />
            <DetailField label="Salvage value" value={formatMoney(asset.salvageValueCents)} mono />
            <DetailField label="Useful life" value={`${asset.usefulLifeMonths} months`} />
            <DetailField label="Accumulated" value={`${formatMoney(asset.accumulatedDepreciationCents)} (${depPct}%)`} mono />
            <DetailField label="Net book value" value={formatMoney(asset.netBookValueCents)} mono />
            <DetailField label="Last depreciation" value={asset.lastDepreciationDate ?? '--'} mono />
          </DetailSection>
        </>
      )}
    </DetailDrawer>
  );
}
