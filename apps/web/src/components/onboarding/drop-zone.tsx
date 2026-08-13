'use client';

/**
 * DropZone — the drag-and-drop empty state behind "drop-and-parse" (design spec §3):
 * "Have debt? Drop the loan doc." A calm target that accepts a drop OR a click-to-
 * browse, and hands the raw File list back to the caller (which owns parsing).
 *
 * Accessibility: a real labelled file input drives the click/keyboard path (Tab +
 * Enter/Space open the picker); the drop surface adds pointer drag/drop on top. The
 * visible label is associated with the input via `htmlFor`.
 */

import { type ReactNode, useCallback, useId, useRef, useState } from 'react';
import { UploadCloud } from 'lucide-react';
import { clsx } from 'clsx';

export interface DropZoneProps {
  /** Primary instruction, e.g. "Drop your WIP schedule". */
  label: string;
  /** Secondary hint under the label, e.g. "CSV / PDF · we parse it". */
  hint?: ReactNode;
  /** `accept` attribute for the file input (e.g. ".csv,text/csv" or ".pdf"). */
  accept?: string;
  /** Allow selecting more than one file. */
  multiple?: boolean;
  /** Called with the dropped/selected files (never empty). */
  onFiles: (files: File[]) => void;
  /** Disable the whole surface (e.g. prerequisites unmet). */
  disabled?: boolean;
  className?: string;
}

export function DropZone({
  label, hint, accept, multiple = false, onFiles, disabled = false, className,
}: DropZoneProps) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const emit = useCallback((list: FileList | null) => {
    if (!list || list.length === 0) return;
    onFiles(Array.from(list));
  }, [onFiles]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (disabled) return;
    emit(e.dataTransfer.files);
  }, [disabled, emit]);

  return (
    <label
      htmlFor={inputId}
      onDragOver={(e) => { if (!disabled) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className={clsx(
        'block rounded-2xl border-2 border-dashed px-6 py-10 text-center transition-colors',
        'focus-within:ring-2 focus-within:ring-brand-500/60',
        disabled
          ? 'border-slate-800 bg-surface-900/40 opacity-60 cursor-not-allowed'
          : dragging
            ? 'border-brand-500/70 bg-brand-500/[0.05] cursor-pointer'
            : 'border-slate-700 bg-surface-900 hover:border-brand-500/50 cursor-pointer',
        className,
      )}
    >
      <input
        id={inputId}
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        className="sr-only"
        onChange={(e) => { emit(e.target.files); e.target.value = ''; }}
      />
      <UploadCloud size={26} className="mx-auto mb-2.5 text-slate-500" aria-hidden />
      <p className="text-sm font-medium text-slate-200">{label}</p>
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </label>
  );
}
