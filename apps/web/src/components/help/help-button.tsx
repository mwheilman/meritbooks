'use client';

/**
 * HelpButton — a discrete "?" icon that opens a page-specific help panel.
 *
 * It reads the current pathname, looks the route up in the help-content
 * registry (`lib/help/help-content.ts`), and shows a slide-over panel that
 * explains what the current page does, its key features, and any tips.
 *
 * Two entry points:
 *   - `HelpButton` (default)  — inline icon, meant to live in the page header
 *     (mounted once inside the shared PageHeader, so every page that uses it
 *     gets the icon for free). Renders with `data-help-button="inline"`.
 *   - `HelpButtonFloating`     — a fixed, bottom-right variant for pages that do
 *     NOT use PageHeader. It self-suppresses when an inline HelpButton is
 *     already present on the page, so it is safe to mount globally in the app
 *     layout without ever double-rendering the icon.
 *
 * Design system: emerald accent, dark surfaces, Esc-to-close, focus returned to
 * the trigger, aria-labelled dialog.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { createPortal } from 'react-dom';
import { HelpCircle, X, Sparkles, Lightbulb, CheckCircle2 } from 'lucide-react';
import { clsx } from 'clsx';
import { getHelpContent } from '@/lib/help/help-content';

interface HelpButtonProps {
  /** Optional extra classes on the trigger button. */
  className?: string;
}

/** The trigger + panel. Shared by both the inline and floating variants. */
function HelpButtonBase({
  className,
  variant,
}: HelpButtonProps & { variant: 'inline' | 'floating' }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => setMounted(true), []);

  const content = getHelpContent(pathname);

  const close = useCallback(() => {
    setOpen(false);
    // Return focus to the trigger for keyboard users.
    triggerRef.current?.focus();
  }, []);

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

  // Move focus into the panel when it opens.
  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-help-button={variant}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Help for this page"
        title="Help for this page"
        className={clsx(
          variant === 'inline'
            ? 'flex h-8 w-8 items-center justify-center rounded-lg border border-slate-800 bg-surface-900 text-slate-400 hover:text-brand-400 hover:border-brand-500/40 transition-colors'
            : 'fixed bottom-5 right-5 z-40 flex h-11 w-11 items-center justify-center rounded-full border border-slate-700 bg-surface-900 text-slate-300 shadow-lg hover:text-brand-400 hover:border-brand-500/50 transition-colors',
          className
        )}
      >
        <HelpCircle size={variant === 'inline' ? 16 : 20} />
      </button>

      {mounted && open
        ? createPortal(
            <div
              className="fixed inset-0 z-[100] flex justify-end"
              role="presentation"
            >
              {/* Backdrop */}
              <div
                className="absolute inset-0 bg-black/50 backdrop-blur-[1px] animate-fade-in"
                onClick={close}
                aria-hidden="true"
              />

              {/* Panel */}
              <div
                ref={panelRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="help-panel-title"
                tabIndex={-1}
                className="relative h-full w-full max-w-md overflow-y-auto border-l border-slate-800 bg-surface-950 shadow-2xl outline-none animate-slide-in-right"
              >
                {/* Header */}
                <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-slate-800 bg-surface-950/95 px-5 py-4 backdrop-blur">
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-500/10">
                      <HelpCircle size={16} className="text-brand-400" />
                    </div>
                    <div>
                      <p className="text-2xs font-semibold uppercase tracking-wider text-brand-400">
                        Help
                      </p>
                      <h2
                        id="help-panel-title"
                        className="text-base font-semibold text-white tracking-tight"
                      >
                        {content.title}
                      </h2>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={close}
                    aria-label="Close help"
                    className="shrink-0 rounded-lg p-1.5 text-slate-500 hover:text-slate-200 hover:bg-white/[0.04] transition-colors"
                  >
                    <X size={18} />
                  </button>
                </div>

                {/* Body */}
                <div className="px-5 py-5 space-y-6">
                  {/* What it does */}
                  <section>
                    <p className="text-sm leading-relaxed text-slate-300">
                      {content.whatItDoes}
                    </p>
                  </section>

                  {/* Key features */}
                  {content.keyFeatures.length > 0 && (
                    <section>
                      <h3 className="mb-2.5 flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-slate-500">
                        <Sparkles size={12} className="text-brand-400" />
                        What you can do here
                      </h3>
                      <ul className="space-y-2">
                        {content.keyFeatures.map((feature, i) => (
                          <li key={i} className="flex items-start gap-2.5">
                            <CheckCircle2
                              size={15}
                              className="mt-0.5 shrink-0 text-brand-500"
                            />
                            <span className="text-sm leading-snug text-slate-300">
                              {feature}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}

                  {/* Tips */}
                  {content.tips && content.tips.length > 0 && (
                    <section className="rounded-xl border border-brand-500/15 bg-brand-500/[0.04] p-4">
                      <h3 className="mb-2.5 flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-brand-300">
                        <Lightbulb size={12} className="text-brand-400" />
                        Tips
                      </h3>
                      <ul className="space-y-2">
                        {content.tips.map((tip, i) => (
                          <li
                            key={i}
                            className="text-sm leading-snug text-slate-400"
                          >
                            {tip}
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}
                </div>
              </div>
            </div>,
            document.body
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
    const hasInline =
      typeof document !== 'undefined' &&
      !!document.querySelector('[data-help-button="inline"]');
    setSuppressed(hasInline);
  }, [pathname]);

  if (suppressed) return null;
  return <HelpButtonBase {...props} variant="floating" />;
}
