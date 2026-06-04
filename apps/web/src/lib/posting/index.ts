/**
 * Deterministic posting engine (GATE 2).
 *
 * Public surface:
 *   - postTransaction / buildTransactionLines — facts in → balanced entry (or
 *     editable draft) out, via the per-type template registry.
 *   - resolveRole / resolveCashSide / getAccountRef — account-role resolution.
 *   - debitCreditFor / normalBalanceFor — account-type-aware direction.
 *   - the transaction-type and payment-rail catalogs.
 */

export * from './account-direction';
export * from './transaction-types';
export {
  resolveRole,
  resolveCashSide,
  getAccountRef,
  PostingError,
  type AccountRoleKey,
  type AccountRef,
} from './account-roles';
export {
  buildTransactionLines,
  postTransaction,
  getTemplate,
  type PostingFacts,
  type TransactionTemplate,
} from './posting-templates';
export {
  resolveOrgId,
  recordBillPayment,
  recordCustomerPayment,
  reverseGlEntry,
  methodToRail,
  type RecordBillPaymentInput,
  type BillPaymentResult,
  type RecordCustomerPaymentInput,
  type CustomerPaymentResult,
  type PaymentApplication,
} from './lifecycle';
export {
  createSchedule,
  runDueSchedules,
  type ScheduleType,
  type CreateScheduleInput,
  type ScheduleRunResult,
} from './schedule-engine';
export { runDepreciation, type DepreciationRunResult } from './depreciation-engine';
export { runDueRecurring, type RecurringRunResult } from './recurring-engine';
export { recordAssetDisposal, type DisposeAssetInput, type DisposeAssetResult } from './asset-disposal';
export {
  recordPayrollRun,
  recordPayrollRemittance,
  type PayrollRunInput,
  type PayrollRunResult,
  type PayrollRemittanceInput,
  type PayrollComponent,
} from './payroll';
export {
  predictException,
  type ExceptionPrediction,
  type ExceptionTreatment,
  type PredictExceptionInput,
} from './exception-predictor';
export {
  recordAssetAcquisition,
  recordPrepaidPurchase,
  recordDeferredRevenue,
  type AssetAcquisitionInput,
  type PrepaidPurchaseInput,
  type DeferredRevenueInput,
  type ProvisionResult,
} from './provisioning';
export { runTaxDepreciation, bookTaxDifference, ensureTaxYearParams, type TaxDepreciationRunResult } from './tax-depreciation';
export {
  recognizesAtBilling,
  resolveBillingRevRecMethod,
  shouldDeferAtBilling,
} from './rev-rec-method';
export { proposePosting, type PostingIntent, type PostingProposal } from './intake';
