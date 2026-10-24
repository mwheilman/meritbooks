/**
 * Field theme (Merit Suite palette): white background, dark ink, 18 pt minimum body text, 56 pt
 * minimum touch targets (works with gloves), main actions at the bottom within thumb reach.
 */
export const color = {
  bg: '#FFFFFF',
  ink: '#0A1628',
  body: '#0A1628',
  muted: '#3D4F65',
  line: '#CCD3DB',
  faint: '#F5F3EF',
  sky: '#EBF2FE',
  primary: '#2563EB',
  onPrimary: '#FFFFFF',
  ok: '#1F6E50',
  okBg: '#E7F3EE',
  warn: '#8A5A00',
  warnBg: '#FFF4DC',
  danger: '#B42318',
  dangerBg: '#FDECEA',
} as const;

export const size = {
  /** Minimum body text. */
  body: 18,
  label: 18,
  title: 24,
  hero: 30,
  /** Minimum touch target. */
  target: 56,
  bigButton: 76,
  gutter: 16,
  gap: 12,
  radius: 4,
} as const;

export const font = {
  regular: { fontSize: size.body, lineHeight: 26, color: color.body },
  strong: { fontSize: size.body, lineHeight: 26, color: color.ink, fontWeight: '700' as const },
  muted: { fontSize: size.body, lineHeight: 26, color: color.muted },
  title: { fontSize: size.title, lineHeight: 30, color: color.ink, fontWeight: '700' as const },
  hero: { fontSize: size.hero, lineHeight: 36, color: color.ink, fontWeight: '800' as const },
  eyebrow: { fontSize: 16, lineHeight: 22, color: color.muted, fontWeight: '700' as const, letterSpacing: 0.6, textTransform: 'uppercase' as const },
} as const;
