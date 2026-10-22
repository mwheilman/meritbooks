// Books' shared UI, on the Merit Suite kit (packages/merit-ui, Style Guide v2.3).
// The components below keep their pre-port props so every page keeps compiling;
// new screens should reach for the kit primitives re-exported at the bottom.
export { PageHeader } from './page-header';
export { ActiveCompanyIndicator } from './active-company-indicator';
export { MetricCard } from './metric-card';
export { DataTable, type Column } from './data-table';
export { StatusBadge } from './status-badge';
export { ConfidenceBar } from './confidence-bar';
export { EmptyState } from './empty-state';
export { CurrencyTag } from './currency-tag';
export { Skeleton, MetricCardSkeleton, TableSkeleton } from './skeleton';
export { ToastContainer } from './toast';

// Kit primitives — one import site for Books screens built on merit-ui.
export {
  Button,
  ButtonLink,
  ButtonRow,
  Field,
  Input,
  MoneyInput,
  Select,
  Textarea,
  Search,
  Check,
  Radio,
  Switch,
  Tabs,
  Seg,
  Bands,
  Pip,
  Status,
  Tag,
  InlineNotice,
  Meter,
  Conf,
  Eyebrow,
  Figure,
  KV,
  Ledger,
  Kbd,
  Keys,
  Keyhints,
  Icon,
  Panel,
  PanelSection,
  Drawer,
  Dialog,
  ConfirmDialog,
  Dash,
  Widget,
  WidgetState,
  toast,
} from '@meritbooks/merit-ui';
