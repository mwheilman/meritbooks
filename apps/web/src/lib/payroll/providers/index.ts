/**
 * Payroll providers — one import surface for the provider-agnostic seam.
 * SERVER-ONLY (the registry reads Vault secrets); pure helpers (types, earnings,
 * gusto-mappers) may be imported directly by tests.
 */
export * from './types';
export * from './earnings';
export { MockPayrollEngine, MOCK_CAPABILITIES, MOCK_EMPLOYEE_TAX_RATE, MOCK_EMPLOYER_TAX_RATE } from './mock';
export { CheckPayrollEngine, CHECK_CAPABILITIES, type CheckEngineConfig } from './check';
export {
  GustoPayrollProvider,
  GUSTO_CAPABILITIES,
  GUSTO_API_VERSION,
  GUSTO_DEMO_BASE_URL,
  GUSTO_PROD_BASE_URL,
  type GustoProviderConfig,
} from './gusto';
export { parseGustoTokens, type GustoTokens } from './gusto-mappers';
export { FilePayrollProvider, FILE_CAPABILITIES, type FileProviderConfig, type RegisterFileImport } from './file';
export {
  PAYROLL_PROVIDER_REGISTRY,
  listPayrollProviders,
  createPayrollProvider,
  resolvePayrollProvider,
  type PayrollProviderDescriptor,
  type ProviderConnectionContext,
} from './registry';
