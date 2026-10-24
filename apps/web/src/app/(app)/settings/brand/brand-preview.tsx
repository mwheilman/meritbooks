'use client';

import { useState, type CSSProperties, type ReactNode } from 'react';
import { Eyebrow, Seg } from '@meritbooks/merit-ui';
import { WHITE } from '@/lib/branding/color';
import type { ResolvedBrand } from '@/lib/branding/types';

/**
 * Live preview of the surfaces the brand drives (FPB-branding §5 `04 // PREVIEW`): the
 * invoice header + totals, the invoice email, the pay page and the customer portal band.
 * Pure rendering of the draft — the real renderers read the same resolved brand.
 */

type Surface = 'invoice' | 'email' | 'pay' | 'portal';

function Logo({ brand, onDark, name, height = 28 }: { brand: ResolvedBrand; onDark: boolean; name: string; height?: number }) {
  const dark = onDark && brand.logoDarkUrl;
  const src = dark ? brand.logoDarkUrl : brand.logoUrl;
  if (!src) return <b style={{ fontSize: 15, color: onDark ? brand.palette.on_primary : brand.palette.ink }}>{name}</b>;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      style={{ height, maxWidth: 150, objectFit: 'contain', display: 'block', ...(onDark && !dark ? { background: WHITE, padding: '3px 6px' } : {}) }}
    />
  );
}

function Frame({ children, label }: { children: ReactNode; label: string }) {
  return (
    <figure className="mb-brand-pv" aria-label={label}>
      {children}
    </figure>
  );
}

export function BrandPreview({ brand, name }: { brand: ResolvedBrand; name: string }) {
  const [surface, setSurface] = useState<Surface>('invoice');
  const p = brand.palette;
  const font: CSSProperties = { fontFamily: brand.fontStack, color: p.ink };

  return (
    <section className="mb-brand-sec mb-brand-preview">
      <Eyebrow>{['04', 'Preview']}</Eyebrow>
      <Seg
        aria-label="Preview surface"
        value={surface}
        onChange={setSurface}
        items={[
          { value: 'invoice', label: 'Invoice' },
          { value: 'email', label: 'Email' },
          { value: 'pay', label: 'Pay page' },
          { value: 'portal', label: 'Portal' },
        ]}
      />

      {surface === 'invoice' && (
        <Frame label="Invoice preview">
          <div style={{ ...font, background: WHITE, border: '1px solid var(--line)' }}>
            <div style={{ background: p.primary, color: p.on_primary, padding: '18px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Logo brand={brand} onDark name={name} />
              <span style={{ fontWeight: 700, letterSpacing: 2, fontSize: 18 }}>INVOICE</span>
            </div>
            <div style={{ padding: '14px 20px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: p.primary, textTransform: 'uppercase', letterSpacing: 1, fontWeight: 700 }}>
                <span>Bill to</span><span>Invoice 1042 · Due Nov 30</span>
              </div>
              <div style={{ marginTop: 4, fontSize: 13 }}>Harper Construction</div>
              <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 12, fontSize: 12 }}>
                <thead>
                  <tr style={{ background: p.surface }}>
                    <th style={{ textAlign: 'left', padding: '6px 8px', fontWeight: 700 }}>Description</th>
                    <th style={{ textAlign: 'right', padding: '6px 8px', fontWeight: 700 }}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  <tr><td style={{ padding: '6px 8px', borderBottom: '1px solid #E4E1DA' }}>Kitchen remodel — progress bill 2</td><td className="tnum" style={{ padding: '6px 8px', textAlign: 'right', borderBottom: '1px solid #E4E1DA' }}>$12,400.00</td></tr>
                  <tr><td style={{ padding: '6px 8px', borderBottom: '1px solid #E4E1DA' }}>Cabinet hardware</td><td className="tnum" style={{ padding: '6px 8px', textAlign: 'right', borderBottom: '1px solid #E4E1DA' }}>$860.00</td></tr>
                </tbody>
              </table>
              <div style={{ marginTop: 12, marginLeft: 'auto', maxWidth: 220, background: p.primary, color: p.on_primary, padding: '8px 10px', display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}>
                <span style={{ fontSize: 11, letterSpacing: 1 }}>BALANCE DUE</span><span className="tnum">$13,260.00</span>
              </div>
              <div style={{ marginTop: 12, fontSize: 11, color: p.primary, fontWeight: 700 }}>Pay online: pay.example.com/i/1042</div>
            </div>
          </div>
        </Frame>
      )}

      {surface === 'email' && (
        <Frame label="Email preview">
          <div style={{ ...font, background: '#F5F3EF', padding: 16 }}>
            <div style={{ background: WHITE, border: '1px solid #E4E1DA' }}>
              <div style={{ background: p.primary, color: p.on_primary, padding: '14px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Logo brand={brand} onDark name={name} height={26} />
                <span style={{ fontSize: 10, letterSpacing: 1.4 }}>INVOICE</span>
              </div>
              <div style={{ padding: 18 }}>
                <div style={{ fontSize: 12, fontWeight: 600 }}>Amount due · November 30, 2026</div>
                <div className="tnum" style={{ fontSize: 26, fontWeight: 700, margin: '4px 0' }}>$13,260.00</div>
                <div style={{ fontSize: 12 }}>Invoice 1042 from {name}</div>
                <span style={{ display: 'inline-block', marginTop: 14, background: p.primary, color: p.on_primary, padding: '10px 22px', fontWeight: 700, fontSize: 13 }}>Pay this invoice</span>
              </div>
            </div>
          </div>
        </Frame>
      )}

      {surface === 'pay' && (
        <Frame label="Pay page preview">
          <div style={{ ...font, background: '#F5F3EF', padding: 16 }}>
            <div style={{ background: WHITE, border: '1px solid #E4E1DA', borderTop: `4px solid ${p.primary}` }}>
              <div style={{ padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 10 }}>
                <Logo brand={brand} onDark={false} name={name} height={32} />
              </div>
              <div style={{ padding: '0 18px 18px' }}>
                <div style={{ borderTop: '1px solid #E4E1DA', borderBottom: '1px solid #E4E1DA', padding: '10px 0' }}>
                  <div style={{ fontSize: 11 }}>Due Nov 30</div>
                  <div className="tnum" style={{ fontSize: 28, fontWeight: 600 }}>$13,260.00</div>
                </div>
                <div style={{ marginTop: 12, border: '1px solid #D8D4CB', padding: 12, background: p.surface }}>
                  <div style={{ border: `1px solid ${p.primary}`, boxShadow: `inset 3px 0 0 ${p.primary}`, background: WHITE, padding: '8px 12px', fontWeight: 600, fontSize: 13 }}>Bank transfer · no fee</div>
                  <div style={{ marginTop: 10, background: p.primary, color: p.on_primary, textAlign: 'center', padding: '10px 0', fontWeight: 600 }}>Pay $13,260.00</div>
                </div>
              </div>
            </div>
          </div>
        </Frame>
      )}

      {surface === 'portal' && (
        <Frame label="Customer portal preview">
          <div style={{ ...font, background: WHITE, border: '1px solid #E4E1DA' }}>
            <div style={{ background: p.primary, color: p.on_primary, padding: '18px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <Logo brand={brand} onDark name={name} height={32} />
                <div>
                  <div style={{ fontWeight: 700 }}>{name}</div>
                  <div style={{ fontSize: 11, opacity: 0.85 }}>Account for Harper Construction</div>
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 10, opacity: 0.85, letterSpacing: 1 }}>BALANCE DUE</div>
                <div className="tnum" style={{ fontSize: 20, fontWeight: 700 }}>$13,260.00</div>
              </div>
            </div>
            <div style={{ padding: '12px 20px', display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
              <span>Invoice 1042 · due Nov 30</span>
              <span style={{ color: p.primary, fontWeight: 700 }}>Pay</span>
            </div>
          </div>
        </Frame>
      )}

      <p className="mb-brand-help" style={{ marginTop: 12 }}>
        The app itself keeps the Merit look; your logo shows at the top of the menu, with &ldquo;Powered by Merit Books&rdquo; beneath it.
      </p>
    </section>
  );
}
