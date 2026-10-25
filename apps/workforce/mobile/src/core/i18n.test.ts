import { describe, expect, it } from 'vitest';
import { MONEY_WORDS_OK, STRINGS, langFromLocale, placeholders, translate, type StringKey } from './i18n';

describe('EN/ES strings', () => {
  const keys = Object.keys(STRINGS.en) as StringKey[];
  it('every key has Spanish text with the same placeholders', () => {
    for (const k of keys) {
      expect(STRINGS.es[k], k).toBeTruthy();
      expect(placeholders(STRINGS.es[k]), k).toEqual(placeholders(STRINGS.en[k]));
    }
  });
  it('fills placeholders and picks the language from the phone', () => {
    expect(translate('en', 'waiting', { n: 3 })).toBe('3 waiting');
    expect(translate('es', 'waiting', { n: 3 })).toBe('3 pendientes');
    expect(langFromLocale('es-MX')).toBe('es');
    expect(langFromLocale('en-US')).toBe('en');
    expect(langFromLocale(undefined)).toBe('en');
  });
  it('no money words on any field screen string, except the few listed on purpose', () => {
    const money = /\$|cost of|price|margin|budget|contract value|rate\b|presupuesto|margen|precio|tarifa/i;
    for (const k of keys) {
      if (MONEY_WORDS_OK.has(k)) continue;
      expect(STRINGS.en[k], k).not.toMatch(money);
      expect(STRINGS.es[k], k).not.toMatch(money);
    }
    // the exceptions are real (a stale entry would hide a regression)
    for (const k of MONEY_WORDS_OK) expect(`${STRINGS.en[k]} ${STRINGS.es[k]}`, k).toMatch(money);
    expect(MONEY_WORDS_OK.size).toBeLessThanOrEqual(8);
  });
});
