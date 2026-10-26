'use client';

/**
 * Company filter (retired from the bank feed — the shell's ⌘J context chip now owns
 * company scope; kept for any caller that still wants an in-page picker). Kit button +
 * kit popover listbox.
 */

import { useRef, useState, type KeyboardEvent } from 'react';
import { Button, Popover, PopoverItem, PopoverList } from '@meritbooks/merit-ui';
import { useQuery } from '@/hooks';
import type { Location } from '@meritbooks/shared';

interface CompanySelectorProps {
  selectedId: string | null;
  onChange: (locationId: string | null) => void;
}

export function CompanySelector({ selectedId, onChange }: CompanySelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);

  const { data: locations, isLoading } = useQuery<Location[]>('/api/locations');

  const selected = locations?.find((l) => l.id === selectedId);
  const label = selected ? `${selected.short_code} · ${selected.name}` : 'All companies';

  const choose = (id: string | null) => {
    onChange(id);
    setIsOpen(false);
  };
  const onKey = (id: string | null) => (e: KeyboardEvent<HTMLLIElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      choose(id);
    }
  };

  return (
    <>
      <Button
        ref={anchorRef}
        iconAfter="down"
        onClick={() => setIsOpen((o) => !o)}
        disabled={isLoading}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label={`Filter by company: ${label}`}
      >
        <span className="mb-trunc" style={{ maxWidth: 200 }}>{label}</span>
      </Button>

      <Popover open={isOpen && !!locations} onClose={() => setIsOpen(false)} anchorRef={anchorRef} width={320} role="listbox" aria-label="Companies">
        <PopoverList style={{ maxHeight: 320 }}>
          <PopoverItem active={!selectedId} onClick={() => choose(null)} onKeyDown={onKey(null)} right={<span className="tnum">{locations?.length ?? 0}</span>} tabIndex={0}>
            All companies
          </PopoverItem>
          {(locations ?? []).map((loc) => (
            <PopoverItem
              key={loc.id}
              active={selectedId === loc.id}
              onClick={() => choose(loc.id)}
              onKeyDown={onKey(loc.id)}
              right={loc.industry ? <span>{loc.industry}</span> : undefined}
              tabIndex={0}
            >
              <span className="code">{loc.short_code}</span>
              <span className="mb-trunc">{loc.name}</span>
            </PopoverItem>
          ))}
        </PopoverList>
      </Popover>
    </>
  );
}
