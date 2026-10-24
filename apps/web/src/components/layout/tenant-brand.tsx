'use client';

/**
 * The tenant's brand area at the top of the rail (FPB-branding §4.1, AC-10).
 *
 * When the tenant has uploaded a logo, it takes the rail's top-left spot (the Merit lockup
 * steps back to a small "Powered by Merit Books" line). Only this brand area changes: the
 * product chrome stays Merit (merit-ui v2.3) — the tenant colour is used only for the thin
 * rule under the logo. No logo → nothing renders and the rail is exactly as before.
 *
 * Full white-label theming later is a merit-ui token override (brandCssVars → --electric /
 * --signal on .app-shell), not a change here.
 */

import { useEffect, useState, type CSSProperties } from 'react';
import { AppLink } from '@meritbooks/merit-ui';
import type { ShellBrand } from '@/lib/branding/shell';
import './tenant-brand.css';

const KEY = 'mb.shellBrand.v1';
let memo: ShellBrand | null | undefined;

function readCache(): ShellBrand | null | undefined {
  if (memo !== undefined) return memo;
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as ShellBrand | null;
  } catch {
    // storage unavailable
  }
  return undefined;
}

export function useShellBrand(): ShellBrand | null {
  const [brand, setBrand] = useState<ShellBrand | null>(() => (typeof window === 'undefined' ? null : readCache() ?? null));
  useEffect(() => {
    let live = true;
    fetch('/api/settings/brand/shell', { credentials: 'same-origin' })
      .then((r) => (r.ok ? (r.json() as Promise<{ brand: ShellBrand | null }>) : { brand: null }))
      .then((j) => {
        memo = j.brand;
        try {
          window.sessionStorage.setItem(KEY, JSON.stringify(j.brand));
        } catch {
          // storage unavailable
        }
        if (live) setBrand(j.brand);
      })
      .catch(() => undefined);
    // Settings → Brand saves broadcast this so the rail updates without a reload.
    const onChange = (e: Event) => {
      const next = (e as CustomEvent<ShellBrand | null>).detail ?? null;
      memo = next;
      setBrand(next);
    };
    window.addEventListener('mb:brand-changed', onChange);
    return () => {
      live = false;
      window.removeEventListener('mb:brand-changed', onChange);
    };
  }, []);
  return brand;
}

/** Tell the shell the tenant brand changed (Settings → Brand, after a save). */
export function announceShellBrand(next: ShellBrand | null): void {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // storage unavailable
  }
  window.dispatchEvent(new CustomEvent('mb:brand-changed', { detail: next }));
}

export function TenantBrandMark({ mini, homeHref = '/dashboard' }: { mini: boolean; homeHref?: string }) {
  const brand = useShellBrand();
  if (!brand) return null;
  return (
    <div className={mini ? 'mb-tenant-brand mb-tenant-brand--mini' : 'mb-tenant-brand'} style={{ '--tb-accent': brand.accent } as CSSProperties}>
      <AppLink href={homeHref} className="mb-tenant-brand-link" aria-label={`${brand.name} — home`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={mini ? brand.markUrl : brand.logoUrl}
          alt=""
          className={brand.onChip || mini ? 'mb-tenant-brand-img mb-tenant-brand-img--chip' : 'mb-tenant-brand-img'}
        />
      </AppLink>
      {!mini && <span className="mb-tenant-brand-powered">Powered by Merit Books</span>}
    </div>
  );
}
