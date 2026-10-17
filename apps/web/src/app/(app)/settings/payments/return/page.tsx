export const dynamic = 'force-dynamic';

import Link from 'next/link';

export default function PaymentsReturnPage() {
  return (
    <div style={{ maxWidth: 520, margin: '64px auto', textAlign: 'center', fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ fontSize: 20, fontWeight: 600, color: '#0A1628' }}>Payments setup submitted</h1>
      <p style={{ color: '#3D4F65', marginTop: 8, lineHeight: 1.5 }}>
        Stripe is reviewing the details. Card and bank payments turn on automatically once it finishes — usually within a few minutes.
      </p>
      <Link href="/settings/payments" style={{ display: 'inline-block', marginTop: 20, padding: '10px 18px', borderRadius: 8, background: '#2563EB', color: '#fff', textDecoration: 'none', fontWeight: 500 }}>
        Back to payment settings
      </Link>
    </div>
  );
}
