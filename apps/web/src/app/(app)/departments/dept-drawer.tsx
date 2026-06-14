'use client';
import { StatusBadge } from '@/components/ui';
import { DetailDrawer, DetailSection, DetailField } from '@/components/detail-drawer';

export interface DeptLike {
  id: string; name: string; code: string; locationId: string | null;
  parentDepartmentId: string | null; parentName: string | null;
  internalChargeMethod: string; hierarchyDepth: number; isActive: boolean; createdAt: string;
}
const CM: Record<string, string> = { inherit: 'Inherit company default', revenue: 'Revenue', cost_transfer: 'Cost transfer' };

export function DepartmentDrawer({ dept, companyName, onClose, onEdit }: { dept: DeptLike | null; companyName?: string; onClose: () => void; onEdit?: () => void }) {
  return (
    <DetailDrawer
      open={!!dept} onClose={onClose} width="md"
      title={dept?.name ?? 'Department'}
      subtitle={dept ? `${dept.code}${companyName ? ` · ${companyName}` : ''}` : null}
      isLoading={false} error={null}
      headerRight={dept ? (
        <div className="flex items-center gap-2">
          <StatusBadge status={dept.isActive ? 'ACTIVE' : 'INACTIVE'} />
          {onEdit && <button onClick={onEdit} className="px-2.5 py-1 rounded-md text-xs font-medium bg-slate-800 text-slate-200 hover:bg-slate-700">Edit</button>}
        </div>
      ) : undefined}
    >
      {dept && (
        <DetailSection title="Department">
          <DetailField label="Code" value={dept.code} />
          <DetailField label="Company" value={companyName ?? '--'} />
          {dept.parentName && <DetailField label="Parent" value={dept.parentName} />}
          <DetailField label="Internal charge method" value={CM[dept.internalChargeMethod] ?? dept.internalChargeMethod} />
          <DetailField label="Status" value={dept.isActive ? 'Active' : 'Inactive'} />
        </DetailSection>
      )}
    </DetailDrawer>
  );
}
