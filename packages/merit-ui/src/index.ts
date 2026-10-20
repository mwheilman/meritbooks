/**
 * @meritbooks/merit-ui — the Merit Suite design system (Style Guide v2.3).
 *
 * Fonts are a separate entry ("@meritbooks/merit-ui/fonts"); the Tailwind
 * preset is "@meritbooks/merit-ui/preset"; CSS is under "/styles/*".
 */

// utilities
export { cx, cssVars } from './cx';
export * from './format';

// root provider (Link, router, the one hotkey registry)
export { MeritProvider, useMeritUI, AppLink, type MeritProviderProps, type LinkComponent, type LinkProps } from './provider';

// brand
export { Lockup, type LockupProps } from './brand/Lockup';
export {
  LOCKUP_BASE_PATH,
  LOCKUP_MIN_HEIGHT,
  LOCKUP_VARIANTS,
  LOCKUP_VIEWBOX,
  PRODUCT_NAMES,
  lockupFile,
  lockupSize,
  lockupStem,
  type LockupForm,
  type LockupModule,
  type LockupVariant,
} from './brand/lockups';
export { pageTitle, titleTemplate } from './brand/pageTitle';

// icons
export { Icon, type IconProps } from './icons/Icon';
export { IconSprite, ICON_SYMBOLS } from './icons/sprite';
export { ICON_NAMES, KIT_ICON_NAMES, PRODUCT_ICON_NAMES, iconId, type IconName } from './icons/names';

// hotkeys
export { HotkeyProvider, useHotkey, useHotkeyRegistry, type HotkeyProviderProps, type UseHotkeyOptions } from './hotkeys/HotkeyProvider';
export {
  createHotkeyRegistry,
  isIsolatedTarget,
  isTypingTarget,
  HotkeyConflictError,
  type HotkeyBinding,
  type HotkeyEvent,
  type HotkeyRegistry,
  type HotkeyRegistryOptions,
  type RegisteredHotkey,
} from './hotkeys/registry';
export { ariaKeyshortcuts, chordKeys, eventStroke, normalizeChord, parseChord, type KeyEventLike, type KeyStroke } from './hotkeys/chords';

// shell
export { AppShell, SupportBand, ViewAsBand, type AppShellProps, type Density, type SessionBandProps } from './shell/AppShell';
export { Rail, RailFoot, RailGroup, RailLink, RailNav, type RailFootProps, type RailGroupProps, type RailLinkProps, type RailNavProps, type RailProps } from './shell/Rail';
export { Bar, CmdkTrigger, ContextChip, Crumbs, SyncStatus, type CmdkTriggerProps, type ContextChipProps, type Crumb } from './shell/Bar';
export { ContextLine, Page, PageHead, type ContextLineItem, type ContextLineProps, type PageHeadProps } from './shell/Page';
export {
  ContextSwitcher,
  productsGroup,
  type ContextSwitcherProps,
  type ProductLink,
  type SwitcherGroup,
  type SwitcherItem,
} from './shell/ContextSwitcher';
export {
  activeHref,
  filterNav,
  navChords,
  type Disclosure,
  type FilteredNavGroup,
  type NavFilter,
  type NavGroup,
  type NavItem,
  type ShellContext,
} from './shell/nav';

// primitives
export { Button, ButtonLink, ButtonRow, type ButtonLinkProps, type ButtonProps, type ButtonSize, type ButtonVariant } from './primitives/Button';
export { ChordCaps, Kbd, Keybar, Keyhints, Keys, type KbdProps, type KeybarProps, type KeyHint, type KeysProps } from './primitives/Kbd';
export {
  Field,
  Input,
  MoneyInput,
  Search,
  Select,
  Textarea,
  type FieldProps,
  type InputProps,
  type MoneyInputProps,
  type SearchProps,
  type SelectProps,
  type TextareaProps,
} from './primitives/Field';
export { Check, Radio, Switch, type CheckProps } from './primitives/Choice';
export { Bands, Seg, Tabs, type BandItem, type BandsProps, type SegProps, type TabItem, type TabsProps } from './primitives/Tabs';
export {
  InlineNotice,
  Pip,
  STATUS_WORDS,
  Status,
  Tag,
  type InlineNoticeProps,
  type NoticeTone,
  type PipKind,
  type StatusKind,
  type StatusProps,
  type TagProps,
  type TagTone,
} from './primitives/Status';
export {
  Conf,
  LOW_CONFIDENCE,
  Meter,
  StageMeter,
  countStrokes,
  scoreStrokes,
  stepStrokes,
  type ConfProps,
  type MeterProps,
  type StageMeterProps,
  type Stroke,
} from './primitives/Meter';
export { Eyebrow, Figure, KV, Ledger, Sl, joinSl, type EyebrowProps, type FigureProps, type KVItem } from './primitives/Text';

// ai
export {
  Basis,
  Evidence,
  Note,
  NoteLinkProvider,
  NotePanel,
  NoteRef,
  Notes,
  Why,
  useNoteLink,
  type BasisProps,
  type EvidenceProps,
  type NotePanelProps,
  type NoteProps,
  type NotesProps,
  type WhyItem,
} from './ai/Note';
export { EvidenceMismatchError, assertEvidenceTies, evidenceSum, formatEvidenceValue, type EvidenceRow } from './ai/evidence';
export { AiPaused, type AiPausedProps } from './ai/AiPaused';

// overlays
export { ConfirmDialog, Dialog, Scrim, type ConfirmDialogProps, type DialogProps, type ScrimProps } from './overlays/Dialog';
export { Drawer, Panel, PanelSection, type DrawerProps, type PanelProps, type PanelSectionProps } from './overlays/Panel';
export { Popover, PopoverFoot, PopoverGroup, PopoverHead, PopoverItem, PopoverList, type PopoverItemProps, type PopoverProps } from './overlays/Popover';
export { HoverPeekCard, placePeekCard, useHoverPeek, type HoverPeekCardProps, type PeekAnchor, type PeekPlacementInput } from './overlays/HoverPeek';
export { ToastRegion, useToasts } from './overlays/Toast';
export {
  TOAST_LIMIT,
  createToastStore,
  toast,
  toastStore,
  type ToastAction,
  type ToastItem,
  type ToastOptions,
  type ToastStore,
  type ToastTone,
} from './overlays/toast-store';
export { focusableIn, useFocusTrap, useMounted } from './overlays/focus';

// tables
export {
  BulkBar,
  QueueTable,
  type BulkBarProps,
  type QueueAction,
  type QueueColumn,
  type QueueGroup,
  type QueueRowState,
  type QueueTableProps,
} from './tables/QueueTable';
export {
  StatementFigure,
  StatementTable,
  StatementTieError,
  assertStatementTies,
  type StatementColumn,
  type StatementRow,
  type StatementTableProps,
} from './tables/StatementTable';
export { ListPager, pagerState, type ListPagerProps, type PagerState } from './tables/ListPager';

// dashboard
export { Dash, WIDGET_SIZES, Widget, WidgetState, type DashProps, type WidgetProps, type WidgetStateSpec } from './dash/Dash';

// hooks
export { useDebounce, useEscapeKey, useListKeynav, type UseListKeynav, type UseListKeynavOptions } from './hooks/basic';
export { api, createApiClient, withParams, type ApiClient, type ApiError, type ApiResponse, type QueryParams } from './hooks/api';
export {
  ScopeParamsProvider,
  mergeScope,
  useMutation,
  useQuery,
  useScopeParams,
  type UseMutationResult,
  type UseQueryOptions,
  type UseQueryResult,
} from './hooks/useQuery';

/** The next/font CSS variables the adapter and preset expect on <html>. */
export const FONT_VARIABLES = { display: '--font-syne', text: '--font-dm-sans' } as const;
