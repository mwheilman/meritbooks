/**
 * Clerk restyled to the Merit Suite (Style Guide v2.3): Electric is the only action
 * colour, square geometry, DM Sans, Syne for the card title. Palette hexes only.
 * (Same values as apps/projects — one suite, one sign-in.)
 */
export const clerkAppearance = {
  variables: {
    colorPrimary: '#2563EB',
    colorText: '#0A1628',
    colorTextSecondary: '#3D4F65',
    colorBackground: '#FFFFFF',
    colorInputBackground: '#FFFFFF',
    colorInputText: '#0A1628',
    colorDanger: '#B42318',
    colorSuccess: '#1F6E50',
    colorWarning: '#8A5A00',
    colorNeutral: '#0A1628',
    fontFamily: 'var(--font-dm-sans, "DM Sans"), system-ui, sans-serif',
    fontFamilyButtons: 'var(--font-dm-sans, "DM Sans"), system-ui, sans-serif',
    fontSize: '13px',
    borderRadius: '0px',
  },
  elements: {
    card: { boxShadow: 'none', border: '1px solid #E1E5EA' },
    formButtonPrimary: { fontWeight: 600, textTransform: 'none' as const, boxShadow: 'none' },
    headerTitle: { fontFamily: 'var(--font-syne, "Syne"), sans-serif', fontWeight: 700, color: '#2563EB' },
    footerActionLink: { color: '#2563EB', fontWeight: 500 },
    userButtonAvatarBox: { width: '32px', height: '32px', borderRadius: '0px' },
  },
};
