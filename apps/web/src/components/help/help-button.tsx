'use client';

/**
 * HelpButton — a quiet "?" that opens a page-specific help panel (merit-ui).
 *
 * It reads the current pathname, looks the route up in the help-content registry
 * (`lib/help/help-content.ts`), and shows a side panel over a Midnight scrim that
 * explains what the current page does, its key features, and any tips.
 *
 * Two entry points:
 *   - `HelpButton` (default)  — inline icon button for the page head (mounted once
 *     inside the shared PageHeader). Renders with `data-help-button="inline"`.
 *   - `HelpButtonFloating`     — a fixed, bottom-right variant for pages that do NOT
 *     use PageHeader. It self-suppresses when an inline HelpButton is already on the
 *     page, so it is safe to mount globally without ever double-rendering.
 *
 * Kit treatment: square buttons, the kit panel (head · scrolling body), the AI-free
 * "why" list for features, the Sky note for tips; Esc closes, focus is trapped and
 * returned to the trigger, aria-labelled dialog.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { createPortal } from 'react-dom';
import { Eyebrow, Icon, useFocusTrap } from '@meritbooks/merit-ui';
import { getHelpContent } from '@/lib/help/help-content';

interface HelpButtonProps {
  /** Optional extra classes on the trigger button. */
  className?: string;
}

/** The trigger + panel. Shared by both the inline and floating variants. */
function HelpButtonBase({ className, variant }: HelpButtonProps & { variant: 'inline' | 'floating' }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => setMounted(true), []);
  useFocusTrap(panelRef, open && mounted);

  const content = getHelpContent(pathname);
  const close = useCallback(() => setOpen(false), []);

  // Esc to close + lock body scroll while the panel is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, close]);

  return (
    <>
      <button
        type="button"
        data-help-button={variant}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Help for this page"
        title="Help for this page"
        className={['btn', 'btn--icon', variant === 'inline' ? 'btn--quiet' : 'mb-help-fab', className].filter(Boolean).join(' ')}
      >
        <Icon name="ask" />
      </button>

      {mounted && open
        ? createPortal(
            <div
              className="scrim scrim--fixed mb-side-scrim"
              role="presentation"
              onMouseDown={(e) => {
                if (e.target === e.currentTarget) close();
              }}
            >
              <div
                ref={panelRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="help-panel-title"
                tabIndex={-1}
                className="panel mb-side-panel"
                data-hotkeys="off"
              >
                <div className="panel-head">
                  <div className="row row--between">
                    <Eyebrow as="span">{['Help', content.title]}</Eyebrow>
                    <button type="button" className="btn btn--quiet btn--icon" onClick={close} aria-label="Close help">
                      <Icon name="x" />
                    </button>
                  </div>
                  <h2 id="help-panel-title" className="t-section" style={{ marginTop: 8, color: 'var(--ink)' }}>
                    {content.title}
                  </h2>
                </div>
                <div className="panel-body">
                  <section className="panel-sec">
                    <p className="t-body ink-2">{content.whatItDoes}</p>
                  </section>
                  {content.keyFeatures.length > 0 && (
                    <section className="panel-sec">
                      <div className="panel-sec-h">
                        <h3>What you can do here</h3>
                      </div>
                      <ul className="why">
                        {content.keyFeatures.map((feature, i) => (
                          <li key={i}>{feature}</li>
                        ))}
                      </ul>
                    </section>
                  )}
                  {content.tips && content.tips.length > 0 && (
                    <section className="panel-sec">
                      <div className="note note--panel">
                        <div className="note-kind">Tips</div>
                        <ul className="why">
                          {content.tips.map((tip, i) => (
                            <li key={i}>{tip}</li>
                          ))}
                        </ul>
                      </div>
                    </section>
                  )}
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

/** Inline "?" icon — mount inside the shared PageHeader. */
export function HelpButton(props: HelpButtonProps) {
  return <HelpButtonBase {...props} variant="inline" />;
}

/**
 * Fixed bottom-right "?" for pages without a PageHeader. Safe to mount globally:
 * it hides itself whenever an inline HelpButton is already on the page.
 */
export function HelpButtonFloating(props: HelpButtonProps) {
  const pathname = usePathname();
  const [suppressed, setSuppressed] = useState(false);

  // After render/navigation, check whether an inline help button exists.
  useLayoutEffect(() => {
    const hasInline = typeof document !== 'undefined' && !!document.querySelector('[data-help-button="inline"]');
    setSuppressed(hasInline);
  }, [pathname]);

  if (suppressed) return null;
  return <HelpButtonBase {...props} variant="floating" />;
}
