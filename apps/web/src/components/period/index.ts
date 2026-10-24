/** The shared period picker (lib/period holds the pure model). */
export { PeriodPicker, type PeriodPickerProps } from './period-picker';
export { MonthGrid, type MonthGridProps } from './month-grid';
export { usePeriodParam, type UsePeriodParamOptions, type UsePeriodParamResult } from './use-period-param';
export { usePeriodContext, fallbackPeriodContext, type PeriodContextData } from './use-period-context';
export type { PeriodSelection, ResolvedPeriod, PeriodBasis, PeriodComparison, PeriodPresetId } from '@/lib/period/resolve';
