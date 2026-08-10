import type { EstimateStatus } from './types';

const CONFIG: Record<EstimateStatus, { bg: string; text: string; label: string }> = {
  DRAFT: { bg: 'bg-gray-500/20', text: 'text-gray-300', label: 'Draft' },
  SENT: { bg: 'bg-blue-500/20', text: 'text-blue-300', label: 'Sent' },
  ACCEPTED: { bg: 'bg-emerald-500/20', text: 'text-emerald-300', label: 'Accepted' },
  DECLINED: { bg: 'bg-red-500/20', text: 'text-red-300', label: 'Declined' },
  EXPIRED: { bg: 'bg-amber-500/20', text: 'text-amber-300', label: 'Expired' },
  CONVERTED: { bg: 'bg-indigo-500/20', text: 'text-indigo-300', label: 'Converted' },
};

export function EstimateStatusBadge({ status }: { status: EstimateStatus }) {
  const c = CONFIG[status] ?? CONFIG.DRAFT;
  return <span className={`px-2 py-0.5 text-xs rounded-full ${c.bg} ${c.text}`}>{c.label}</span>;
}
