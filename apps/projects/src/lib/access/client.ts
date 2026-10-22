/**
 * Client-safe access API (no server-only imports): types, can(), masking, (de)serialization.
 * Client components receive an AccessJson (prop or GET /api/access/me) and call accessFromJson().
 */
export * from './types';
export { can, companiesWith, canSeeCost, canSeeContract, canSeeRates } from './can';
export { maskMoney, seesAllMoney, metricVisible } from './mask';
export { MONEY_KEYS, MONEY_OBJECTS, type MoneyClass, type MoneyObject } from './money-keys';
export { accessFromJson, accessToJson, type AccessJson } from './serialize';
export { PERSONA_LABEL, PERSONA_TEMPLATE_GRANTS, CAPABILITY_ACTIONS, isPersonaKey } from './templates';
export { forbiddenMessage } from './guard';
