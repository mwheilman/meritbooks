import { Receipt, FileText, CheckCircle, ArrowRightLeft, Landmark } from 'lucide-react';
import { clsx } from 'clsx';
import { formatMoney } from '@meritbooks/shared';
import { getRecentActivity, type RecentActivity } from './actions';

const ICON_MAP = {
  receipt: { icon: Receipt, color: 'text-blue-400 bg-blue-500/10' },
  bill: { icon: FileText, color: 'text-amber-400 bg-amber-500/10' },
  approval: { icon: CheckCircle, color: 'text-emerald-400 bg-emerald-500/10' },
  bank_txn: { icon: Landmark, color: 'text-slate-400 bg-slate-500/10' },
  je: { icon: ArrowRightLeft, color: 'text-purple-400 bg-purple-500/10' },
};

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export async function ActivityFeed() {
  const activity = await getRecentActivity(15);

  return (
    <div className="card">
      <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-white">Activity</h2>
        <span className="text-2xs text-slate-500">{activity.length > 0 ? 'Latest' : 'No activity'}</span>
      </div>
      <div className="divide-y divide-slate-800/30">
        {activity.length === 0 && (
          <div className="px-5 py-8 text-center text-sm text-slate-500">
            No recent activity. Transactions will appear here as they&apos;re processed.
          </div>
        )}
        {activity.map((item) => {
          const { icon: Icon, color } = ICON_MAP[item.type] ?? ICON_MAP.bank_txn;
          return (
            <div key={item.id} className="px-5 py-3 table-row-hover">
              <div className="flex gap-3">
                <div className={clsx('h-7 w-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5', color)}>
                  <Icon size={14} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-slate-200 truncate">{item.description}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    {item.location_name && (
                      <span className="text-2xs text-slate-500">{item.location_name}</span>
                    )}
                    {item.amount_cents != null && (
                      <span className="text-2xs font-mono tabular-nums text-slate-500">
                        {formatMoney(item.amount_cents)}
                      </span>
                    )}
                    <span className="text-2xs text-slate-600 capitalize">{item.status.toLowerCase()}</span>
                  </div>
                </div>
                <span className="text-2xs text-slate-600 shrink-0">{timeAgo(item.created_at)}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
