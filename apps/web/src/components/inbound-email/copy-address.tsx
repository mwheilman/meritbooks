'use client';

import { useState } from 'react';
import { Button } from '@meritbooks/merit-ui';
import { addToast } from '@/hooks';

/** An inbox address with a Copy button (clipboard API, with a select-the-text fallback). */
export function CopyAddress({ address, label = 'Copy', size = 'md' }: { address: string; label?: string; size?: 'md' | 'sm' }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      addToast('success', `Copied ${address}`);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      const el = document.getElementById(`addr-${address}`);
      if (el) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
      addToast('error', 'Copy is blocked in this browser — the address is selected, press Ctrl/⌘+C.');
    }
  }

  return (
    <span className="row" style={{ gap: 8, alignItems: 'center', minWidth: 0 }}>
      <code
        id={`addr-${address}`}
        className={size === 'sm' ? 't-cap ink' : 'ink'}
        style={{ fontFamily: 'var(--f-text)', fontWeight: 600, overflowWrap: 'anywhere', userSelect: 'all' }}
      >
        {address}
      </code>
      <Button variant="quiet" onClick={() => void copy()} aria-label={`Copy ${address}`}>
        {copied ? 'Copied' : label}
      </Button>
    </span>
  );
}
