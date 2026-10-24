/**
 * Number governance (Wave 3D). Importing this module installs the governance implementation
 * into the report engine's call points (lib/reports/engine/governance-hook.ts), so every
 * engine result — and every drill — is governed before it leaves the server.
 * lib/reports/engine/adapter.ts imports this module; in production an unregistered hook
 * throws (fail closed).
 *
 * Other server code (metrics, exports) calls `applyGovernance` + `filterByGovernance`
 * directly — see ./apply.ts.
 */

import { registerDrillGovernance, registerGovernance, registerMembership } from '@/lib/reports/engine/governance-hook';
import { governDrillRequest, governReportResult, membershipFor } from './engine-adapter';

registerGovernance((view, ctx) => governReportResult(view, ctx));
// Drills: release cut-off over every month of the range + server-side in-group windows.
registerDrillGovernance((req, ctx) => governDrillRequest(req, ctx));
// In-group windows are decided before aggregation (pre-acquisition exclusion).
registerMembership((req, ctx) => membershipFor(req, ctx));

export { applyGovernance } from './apply';
export { filterByGovernance, assertShown, isShown, GovernanceDeniedError } from './filter';
export { gateDrill, governDrillRequest, governReportResult, governResult, membershipFor, redactAmounts, windowsFromDecision } from './engine-adapter';
export type * from './types';
