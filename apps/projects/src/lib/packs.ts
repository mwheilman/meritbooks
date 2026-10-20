/**
 * Client-safe slice of @meritbooks/industry-packs: the closed vocabularies, labels
 * and DEFAULT_VOCAB. The package barrel also exports the plan compiler (node:crypto)
 * and the full manifest catalog, which must not reach browser bundles; server code
 * that needs getPack() imports the barrel directly (lib/pm/config.ts).
 */
export * from '@meritbooks/industry-packs/src/types';
export * from '@meritbooks/industry-packs/src/vocab';
export * from '@meritbooks/industry-packs/src/constants';
