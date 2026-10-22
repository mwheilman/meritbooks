/**
 * Server access API: getAccess() (cached per request) plus everything client-safe.
 *   const access = await getAccess();
 *   if (can(access, 'projects.financials', 'view', companyId)) …
 */
export * from './client';
export { getAccess, getRealAccess, getAccessPreviewing, PREVIEW_COOKIE } from './server';
export { buildAccess, emptyAccess, deriveMoneyLevel, deriveJobScope, choosePersona, narrowToPersona, canPreview } from './derive';
export { requireCan, forbiddenBody, FORBIDDEN } from './guard';
export { packRoleTitle } from './titles';
export { denyUnless } from './route-guard';
