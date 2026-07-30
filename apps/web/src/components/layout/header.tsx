'use client';

import { UserButton } from '@clerk/nextjs';
import { Search, Bell, ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { clsx } from 'clsx';
import { useMe } from '@/lib/hooks/use-me';
import { usePlane } from '@/lib/hooks/use-plane';
import { PlaneSwitcher } from '@/components/layout/plane-switcher';

interface CompanyOption {
  id: string;
  name: string;
  shortCode: string;
}

export function Header() {
  const { locations } = useMe();
  const companies: CompanyOption[] = [
    { id: 'all', name: 'All Companies', shortCode: 'ALL' },
    ...locations.map((l) => ({
      id: l.id,
      name: l.name,
      shortCode: (l.code || l.name).slice(0, 3).toUpperCase(),
    })),
  ];

  const [selectedId, setSelectedId] = useState('all');
  const [companyOpen, setCompanyOpen] = useState(false);
  const selectedCompany = companies.find((c) => c.id === selectedId) ?? companies[0];
  const { plane } = usePlane();

  return (
    <header className="flex h-[var(--header-height)] items-center justify-between border-b border-slate-800 bg-surface-950 px-6">
      {/* Context (which hat) + entity selector */}
      <div className="flex items-center gap-1">
        <PlaneSwitcher />
        {/* Entity picker is only meaningful inside the Book-of-Record plane */}
        {plane === 'books' && (
          <>
            <div className="h-5 w-px bg-slate-800 mx-1.5" />
            <div className="relative">
        <button
          onClick={() => setCompanyOpen(!companyOpen)}
          className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm hover:bg-white/[0.03] transition-colors"
        >
          <div className="h-6 w-6 rounded bg-brand-500/20 flex items-center justify-center text-2xs font-bold text-brand-400">
            {selectedCompany.shortCode.slice(0, 2)}
          </div>
          <span className="text-slate-200 font-medium">{selectedCompany.name}</span>
          <ChevronDown size={14} className="text-slate-500" />
        </button>

        {companyOpen && (
          <>
            <div
              className="fixed inset-0 z-10"
              onClick={() => setCompanyOpen(false)}
            />
            <div className="absolute top-full left-0 mt-1 z-20 w-72 rounded-xl border border-slate-800 bg-surface-900 shadow-xl py-1 animate-slide-up">
              {companies.length === 1 && (
                <div className="px-3 py-2 text-xs text-slate-500">
                  No companies yet — add them in setup.
                </div>
              )}
              {companies.map((company) => (
                <button
                  key={company.id}
                  onClick={() => {
                    setSelectedId(company.id);
                    setCompanyOpen(false);
                  }}
                  className={clsx(
                    'w-full flex items-center gap-3 px-3 py-2 text-sm transition-colors',
                    company.id === selectedCompany.id
                      ? 'bg-brand-500/10 text-brand-400'
                      : 'text-slate-300 hover:bg-white/[0.03]'
                  )}
                >
                  <div className="h-6 w-6 rounded bg-slate-800 flex items-center justify-center text-2xs font-bold text-slate-400">
                    {company.shortCode.slice(0, 2)}
                  </div>
                  <span>{company.name}</span>
                </button>
              ))}
            </div>
          </>
        )}
            </div>
          </>
        )}
      </div>

      {/* Right side */}
      <div className="flex items-center gap-3">
        {/* Search */}
        <button className="flex items-center gap-2 rounded-lg border border-slate-800 bg-surface-900 px-3 py-1.5 text-sm text-slate-500 hover:border-slate-700 transition-colors w-64">
          <Search size={14} />
          <span>Search transactions...</span>
          <kbd className="ml-auto text-2xs text-slate-600 bg-slate-800 px-1.5 py-0.5 rounded">⌘/</kbd>
        </button>

        {/* Notifications */}
        <button className="relative p-2 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-white/[0.03] transition-colors">
          <Bell size={18} />
          <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-brand-500" />
        </button>

        {/* User */}
        <UserButton
          appearance={{
            elements: {
              avatarBox: 'h-8 w-8',
            },
          }}
        />
      </div>
    </header>
  );
}
