'use client';

import { useState } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import { clsx } from 'clsx';
import { usePlane } from '@/lib/hooks/use-plane';
import { PLANES, PLANE_ORDER } from '@/lib/planes';

/**
 * The "which hat" control. Shows the active plane and, when the viewer has more
 * than one, lets them switch. The sidebar reshapes to the chosen plane so it is
 * always clear whether you are operating the platform, administering the
 * practice, or working a set of books.
 */
export function PlaneSwitcher() {
  const { plane, available, setPlane } = usePlane();
  const [open, setOpen] = useState(false);
  const active = PLANES[plane];
  const ActiveIcon = active.icon;
  const options = PLANE_ORDER.filter((p) => available.includes(p));

  // Only one hat available — show a static indicator, no dropdown.
  if (options.length <= 1) {
    return (
      <div className="flex items-center gap-2 px-2 py-1.5">
        <div className="h-6 w-6 rounded-lg bg-brand-500/15 flex items-center justify-center">
          <ActiveIcon size={14} className="text-brand-400" />
        </div>
        <span className="text-sm font-semibold text-white">{active.label}</span>
      </div>
    );
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 hover:bg-white/[0.03] transition-colors"
      >
        <div className="h-6 w-6 rounded-lg bg-brand-500/15 flex items-center justify-center">
          <ActiveIcon size={14} className="text-brand-400" />
        </div>
        <div className="text-left leading-tight">
          <p className="text-2xs text-slate-500">Viewing as</p>
          <p className="text-sm font-semibold text-white -mt-0.5">{active.label}</p>
        </div>
        <ChevronDown size={14} className="text-slate-500" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute top-full left-0 mt-1 z-20 w-72 rounded-xl border border-slate-800 bg-surface-900 shadow-xl py-1 animate-slide-up">
            <p className="px-3 pt-2 pb-1 text-2xs font-semibold uppercase tracking-wider text-slate-500">
              Switch context
            </p>
            {options.map((p) => {
              const def = PLANES[p];
              const Icon = def.icon;
              const isActive = p === plane;
              return (
                <button
                  key={p}
                  onClick={() => {
                    setPlane(p);
                    setOpen(false);
                  }}
                  className={clsx(
                    'w-full flex items-center gap-3 px-3 py-2 text-sm transition-colors text-left',
                    isActive ? 'bg-brand-500/10' : 'hover:bg-white/[0.03]'
                  )}
                >
                  <div
                    className={clsx(
                      'h-7 w-7 rounded-lg flex items-center justify-center shrink-0',
                      isActive ? 'bg-brand-500/20' : 'bg-slate-800'
                    )}
                  >
                    <Icon size={15} className={isActive ? 'text-brand-400' : 'text-slate-400'} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className={clsx('font-medium leading-tight', isActive ? 'text-brand-300' : 'text-slate-200')}>
                      {def.label}
                    </p>
                    <p className="text-2xs text-slate-500 leading-tight">{def.tagline}</p>
                  </div>
                  {isActive && <Check size={15} className="text-brand-400 shrink-0" />}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
