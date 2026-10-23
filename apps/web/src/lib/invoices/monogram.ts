/**
 * The letter mark shown when a company has no uploaded logo (hosted pay page, previews).
 * Skips brackets and punctuation, so "[SANDBOX] Coho Builders" → "C", not "[". Prefers
 * the first letter/digit of the first two real words ("Coho Builders" → "CB" when two
 * letters are asked for). Unicode-aware; never empty.
 */
const TAG = /^\s*[[(（【{<][^\])）】}>]*[\])）】}>]\s*/u;

export function monogram(name: string | null | undefined, letters: 1 | 2 = 1, fallback = 'I'): string {
  // A leading bracketed tag ("[SANDBOX]", "(TEST)") is a label, not part of the name.
  let s = (name ?? '').replace(TAG, '');
  if (!/[\p{L}\p{N}]/u.test(s)) s = name ?? '';
  const words = s.split(/\s+/).map((w) => w.match(/[\p{L}\p{N}]/u)?.[0] ?? '').filter(Boolean);
  if (words.length === 0) return fallback;
  return words.slice(0, letters).join('').toUpperCase();
}
