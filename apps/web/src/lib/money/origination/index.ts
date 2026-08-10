/**
 * Money-out ORIGINATION lane (migration 143) — provider-agnostic rail hand-off.
 * One import surface for the interface, the SANDBOX adapter, the resolver, and the
 * DB service. See provider.ts for the hard "tracks-only, never posts" invariant.
 */

export * from './provider';
export { SandboxOriginationProvider, SANDBOX_DEFAULT_RETURN_CODE } from './sandbox';
export { resolveOriginationProvider } from './resolve';
export * from './service';
