import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../cx';
import { chordKeys } from '../hotkeys/chords';

export interface KbdProps extends HTMLAttributes<HTMLElement> {
  /** Force the Midnight keycap outside the rail/bar/toast/keybar (which do it automatically). */
  dark?: boolean;
}

/** A keycap — the one 2px radius in the system. */
export function Kbd({ dark, className, ...rest }: KbdProps) {
  return <kbd className={cx('kbd', dark && 'kbd--dark', className)} {...rest} />;
}

export interface KeysProps {
  /** A chord in registry grammar: "mod+k", "shift+a", "g h", "j k" (printed as caps). */
  chord: string;
  /** The verb printed after the caps ("move", "approve"). */
  children?: ReactNode;
  className?: string;
}

/** Caps for a chord plus its verb: <Keys chord="j k">move</Keys> → [J][K] move. */
export function Keys({ chord, children, className }: KeysProps) {
  return (
    <span className={cx('keys', className)}>
      {chordKeys(chord).map((k, i) => (
        <Kbd key={i}>{k}</Kbd>
      ))}
      {children != null && <> {children}</>}
    </span>
  );
}

/** Print the caps of a chord inline (inside a button, a chip, the cmdk trigger). */
export function ChordCaps({ chord }: { chord: string }) {
  return (
    <>
      {chordKeys(chord).map((k, i) => (
        <Kbd key={i}>{k}</Kbd>
      ))}
    </>
  );
}

export interface KeyHint {
  chord: string;
  label: ReactNode;
}

/** A row of key hints on light ground (popover feet, captions). */
export function Keyhints({ hints, className }: { hints: ReadonlyArray<KeyHint>; className?: string }) {
  return (
    <div className={cx('keyhints', className)}>
      {hints.map((h) => (
        <Keys key={h.chord} chord={h.chord}>
          {h.label}
        </Keys>
      ))}
    </div>
  );
}

export interface KeybarProps {
  hints: ReadonlyArray<KeyHint>;
  /** Right-aligned note ("Nothing posts until you approve it"). */
  note?: ReactNode;
  className?: string;
}

/** The Midnight strip that closes every queue: J K move · X select · A approve … */
export function Keybar({ hints, note, className }: KeybarProps) {
  return (
    <div className={cx('keybar', className)} role="note" aria-label="Keyboard shortcuts">
      {hints.map((h) => (
        <Keys key={h.chord} chord={h.chord}>
          {h.label}
        </Keys>
      ))}
      {note != null && (
        <>
          <span className="sp" />
          <span>{note}</span>
        </>
      )}
    </div>
  );
}
