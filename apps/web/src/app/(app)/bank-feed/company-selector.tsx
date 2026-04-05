'use client';

import { Building2, ChevronDown } from 'lucide-react';
import { useState, useRef, useEffect } from 'react';
import { useQuery } from '@/hooks';
import type { Location } from '@meritbooks/shared';

interface CompanySelectorProps {
  selectedId: string | null;
  onChange: (locationId: string | null) => void;
}

export function CompanySelector({ selectedId, onChange }: CompanySelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const { data: locations, isLoading } = useQuery<Location[]>('/api/locations');

  // Close on click outside
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const selected = locations?.find((l) => l.id === selectedId);
  const label = selected
    ? `${selected.short_code} · ${selected.name}`
    : 'All Companies';

  return (
    <div ref={dropdownRef} className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        disabled={isLoading}
        className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-900 border border-slate-800 text-sm text-slate-200 hover:border-slate-700 hover:bg-white/[0.02] transition-colors"
      >
        <Building2 size={14} className="text-slate-500" />
        <span className="max-w-[200px] truncate">{label}</span>
        <ChevronDown size={14} className={`text-slate-500 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && locations && (
        <div className="absolute top-full left-0 mt-1 w-72 max-h-80 overflow-y-auto rounded-lg bg-surface-900 border border-slate-800 shadow-xl z-50">
          {/* All companies option */}
          <button
            onClick={() => { onChange(null); setIsOpen(false); }}
            className={`w-full flex items-center gap-2 px-3 py-2.5 text-left text-sm transition-colors ${
              !selectedId
                ? 'bg-brand-500/10 text-brand-400'
                : 'text-slate-300 hover:bg-white/[0.04]'
            }`}
          >
            <Building2 size={14} className="text-slate-500 shrink-0" />
            <span>All Companies</span>
            <span className="ml-auto text-xs text-slate-600">{locations.length}</span>
          </button>

          <div className="h-px bg-slate-800" />

          {locations.map((loc) => (
            <button
              key={loc.id}
              onClick={() => { onChange(loc.id); setIsOpen(false); }}
              className={`w-full flex items-center gap-2 px-3 py-2.5 text-left text-sm transition-colors ${
                selectedId === loc.id
                  ? 'bg-brand-500/10 text-brand-400'
                  : 'text-slate-300 hover:bg-white/[0.04]'
              }`}
            >
              <span className="font-mono text-xs text-slate-500 w-8 shrink-0">{loc.short_code}</span>
              <span className="truncate">{loc.name}</span>
              {loc.industry && (
                <span className="ml-auto text-2xs text-slate-600 shrink-0">{loc.industry}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
