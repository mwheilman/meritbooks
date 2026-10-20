import type { ReactElement, SVGProps } from 'react';
import { iconId, type IconName } from './names';

type SymbolAttrs = Pick<SVGProps<SVGSymbolElement>, 'fill' | 'stroke' | 'strokeWidth' | 'strokeLinejoin' | 'strokeDasharray'>;

const STROKE: SymbolAttrs = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.5 };
const STROKE_ROUND: SymbolAttrs = { ...STROKE, strokeLinejoin: 'round' };

/**
 * Symbol bodies. Kit symbols are transcribed exactly from components.html;
 * attributes are the kit's (e.g. check is 1.75, drag is a fill).
 */
export const ICON_SYMBOLS: Readonly<Record<IconName, { attrs: SymbolAttrs; body: ReactElement }>> = {
  /* ------------------------------------------------ kit sprite (23) */
  search: { attrs: STROKE, body: <><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14" /></> },
  down: { attrs: STROKE, body: <path d="M4 6l4 4 4-4" /> },
  right: { attrs: STROKE, body: <path d="M3 8h10M9 4l4 4-4 4" /> },
  layers: { attrs: STROKE_ROUND, body: <><path d="M8 2 14 5 8 8 2 5Z" /><path d="M2 8.2l6 3 6-3" /><path d="M2 11.2l6 3 6-3" /></> },
  grid: {
    attrs: STROKE,
    body: <><rect x="2.5" y="2.5" width="4.5" height="4.5" /><rect x="9" y="2.5" width="4.5" height="4.5" /><rect x="2.5" y="9" width="4.5" height="4.5" /><rect x="9" y="9" width="4.5" height="4.5" /></>,
  },
  pin: { attrs: STROKE_ROUND, body: <><path d="M5.5 2h5l-.7 4.2L12 8.5H4l2.2-2.3Z" /><path d="M8 8.5V14" /></> },
  lock: { attrs: STROKE, body: <><rect x="3.5" y="7" width="9" height="6.5" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></> },
  drag: {
    attrs: { fill: 'currentColor' },
    body: <><rect x="5" y="3" width="2" height="2" /><rect x="9" y="3" width="2" height="2" /><rect x="5" y="7" width="2" height="2" /><rect x="9" y="7" width="2" height="2" /><rect x="5" y="11" width="2" height="2" /><rect x="9" y="11" width="2" height="2" /></>,
  },
  sliders: { attrs: STROKE, body: <><path d="M2 5h12M2 11h12" /><rect x="9" y="3" width="2.5" height="4" fill="#FFFFFF" /><rect x="4.5" y="9" width="2.5" height="4" fill="#FFFFFF" /></> },
  x: { attrs: STROKE, body: <path d="M4 4l8 8M12 4l-8 8" /> },
  check: { attrs: { ...STROKE, strokeWidth: 1.75 }, body: <path d="M3.5 8.5 6.5 11.5 12.5 4.5" /> },
  receipt: { attrs: STROKE_ROUND, body: <><path d="M4 2h8v12l-2-1.2L8 14l-2-1.2L4 14Z" /><path d="M6 6h4M6 9h4" /></> },
  bill: { attrs: STROKE_ROUND, body: <><path d="M4 2h5.5L12 4.5V14H4Z" /><path d="M6 7.5h4M6 10.5h3" /></> },
  none: { attrs: { ...STROKE, strokeDasharray: '2 2' }, body: <rect x="3" y="3" width="10" height="10" /> },
  eye: { attrs: STROKE, body: <><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" /><circle cx="8" cy="8" r="2" /></> },
  undo: { attrs: STROKE, body: <><path d="M5.5 3.5 2.5 6.5l3 3" /><path d="M2.5 6.5H10a3.5 3.5 0 0 1 0 7H7" /></> },
  plug: { attrs: STROKE, body: <><path d="M6 2v3.5M10 2v3.5M4 5.5h8v2a4 4 0 0 1-8 0Z" /><path d="M8 11.5V14" /></> },
  plus: { attrs: STROKE, body: <path d="M8 3v10M3 8h10" /> },
  flag: { attrs: STROKE_ROUND, body: <path d="M3.5 14V2.5h8l-1.5 3 1.5 3h-8" /> },
  ask: { attrs: STROKE_ROUND, body: <path d="M2.5 3h11v8H7l-3 2.5V11H2.5Z" /> },
  resize: { attrs: STROKE, body: <path d="M9 3h4v4M7 13H3V9M13 3 3 13" /> },
  history: { attrs: STROKE, body: <><path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9" /><path d="M2.5 2.5v2.5H5" /><path d="M8 5v3.2l2 1.3" /></> },
  book: { attrs: STROKE_ROUND, body: <><path d="M3 2.5h7.5L13 5v8.5H3Z" /><path d="M5.5 6.5h5M5.5 9h5M5.5 11.5h3" /></> },

  /* ------------------------------------------------ product symbols (drawn to spec) */
  calendar: { attrs: STROKE, body: <><rect x="2.5" y="3.5" width="11" height="10" /><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" /></> },
  clock: { attrs: STROKE, body: <><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3.2l2 1.3" /></> },
  truck: {
    attrs: STROKE_ROUND,
    body: <><path d="M1.5 3.5h8v7h-8Z" /><path d="M9.5 6h2.8l2.2 2.3v2.2h-5" /><circle cx="4.5" cy="12" r="1.5" /><circle cx="11.5" cy="12" r="1.5" /></>,
  },
  wrench: { attrs: STROKE_ROUND, body: <path d="M10.6 2.3a3.3 3.3 0 0 0-3.9 4.3L2.5 10.8l2.7 2.7 4.2-4.2a3.3 3.3 0 0 0 4.3-3.9L11.6 7.5l-2-.6-.6-2Z" /> },
  hammer: { attrs: STROKE_ROUND, body: <><path d="M4.5 2.5h7l2 1.5-2 1.5h-7Z" /><path d="M8 5.5V14" /></> },
  clipboard: { attrs: STROKE, body: <><path d="M5.5 3H3.5v11h9V3h-2" /><rect x="5.5" y="2" width="5" height="2.5" /><path d="M5.5 8h5M5.5 10.5h3.5" /></> },
  users: { attrs: STROKE, body: <><circle cx="6" cy="5.5" r="2.5" /><path d="M1.5 13.5a4.5 4.5 0 0 1 9 0" /><path d="M10 3.2a2.5 2.5 0 0 1 0 4.6M12 9.4a4.5 4.5 0 0 1 2.5 4.1" /></> },
  'map-pin': { attrs: STROKE_ROUND, body: <><path d="M8 14s4.5-4.2 4.5-7.5a4.5 4.5 0 0 0-9 0C3.5 9.8 8 14 8 14Z" /><circle cx="8" cy="6.5" r="1.5" /></> },
  camera: { attrs: STROKE_ROUND, body: <><path d="M2 5h3l1.2-1.8h3.6L11 5h3v8H2Z" /><circle cx="8" cy="8.8" r="2.3" /></> },
  box: { attrs: STROKE_ROUND, body: <><path d="M2.5 5 8 2.5 13.5 5v6.5L8 14l-5.5-2.5Z" /><path d="M2.5 5 8 7.5 13.5 5M8 7.5V14" /></> },
  factory: { attrs: STROKE_ROUND, body: <><path d="M2 13.5V7.5l3.5 2.2V7.5L9 9.7V3h3v10.5Z" /><path d="M1 13.5h14" /></> },
  home: { attrs: STROKE_ROUND, body: <><path d="M2.5 7.5 8 2.5l5.5 5v6h-11Z" /><path d="M6.5 13.5V10h3v3.5" /></> },
  building: { attrs: STROKE, body: <><rect x="3.5" y="2.5" width="9" height="11" /><path d="M6 5.5h1M9 5.5h1M6 8h1M9 8h1M7 13.5V11h2v2.5" /></> },
  'file-text': { attrs: STROKE_ROUND, body: <><path d="M4 2h5.5L12 4.5V14H4Z" /><path d="M9.5 2v2.5H12M6 7.5h4M6 10h4M6 12.5h2.5" /></> },
  dollar: { attrs: STROKE, body: <><path d="M8 2v12" /><path d="M11 4.8C10.4 4 9.3 3.5 8 3.5c-1.7 0-3 .9-3 2.2C5 8.9 11 7.1 11 10.3c0 1.3-1.3 2.2-3 2.2-1.4 0-2.6-.6-3.1-1.5" /></> },
  more: { attrs: { fill: 'currentColor' }, body: <><rect x="2.5" y="7" width="2" height="2" /><rect x="7" y="7" width="2" height="2" /><rect x="11.5" y="7" width="2" height="2" /></> },
  upload: { attrs: STROKE, body: <><path d="M8 10.5V2.5M4.5 6 8 2.5 11.5 6" /><path d="M2.5 10.5v3h11v-3" /></> },
  up: { attrs: STROKE, body: <path d="M4 10l4-4 4 4" /> },
  left: { attrs: STROKE, body: <path d="M13 8H3M7 4 3 8l4 4" /> },
};

/**
 * The sprite. Render once, near the top of <body> (root layout). Every <Icon/>
 * references it with <use href="#i-…">.
 */
export function IconSprite() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true" focusable="false">
      <defs>
        {(Object.keys(ICON_SYMBOLS) as IconName[]).map((name) => {
          const s = ICON_SYMBOLS[name];
          return (
            <symbol key={name} id={iconId(name)} viewBox="0 0 16 16" {...s.attrs}>
              {s.body}
            </symbol>
          );
        })}
      </defs>
    </svg>
  );
}
