/**
 * The `?qbo=<code>` outcomes the QuickBooks OAuth round-trip returns with, and their
 * plain-English messages. Client-safe (no next/server) — shared by the onboarding
 * wizard tile and the migration-connectors surface. The server side of the contract
 * is `QboReturnCode` in ./route-helpers (kept identical — return-codes.test.ts checks it).
 */

export type QboReturnCode = 'connected' | 'cancelled' | 'not_configured' | 'forbidden' | 'expired' | 'error';
const RETURN_CODES: readonly QboReturnCode[] = ['connected', 'cancelled', 'not_configured', 'forbidden', 'expired', 'error'];
export function isQboReturnCode(v: string | null | undefined): v is QboReturnCode {
  return !!v && (RETURN_CODES as readonly string[]).includes(v);
}

/** Plain-English message for the `?qbo=` code the OAuth round-trip returns with. */
export function qboReturnMessage(code: QboReturnCode, reason?: string | null): { tone: 'success' | 'info' | 'warning' | 'danger'; text: string } {
  switch (code) {
    case 'connected':
      return { tone: 'success', text: 'QuickBooks is connected. Click “Bring in my books” when you’re ready — nothing changes until you approve it.' };
    case 'cancelled':
      return { tone: 'info', text: 'You cancelled the QuickBooks sign-in, so nothing was connected. Try again, or export one report instead.' };
    case 'not_configured':
      return { tone: 'info', text: 'A direct QuickBooks connection isn’t switched on for this MeritBooks yet. Use the one-minute export below instead — it works just as well.' };
    case 'forbidden':
      return { tone: 'warning', text: 'Connecting QuickBooks needs someone who can manage integrations (usually the company admin). Ask them to connect it, or export the report below.' };
    case 'expired':
      return { tone: 'warning', text: 'The QuickBooks sign-in took too long and expired. Please click “Connect QuickBooks” again.' };
    case 'error':
    default:
      return { tone: 'danger', text: reason?.trim() || 'Something went wrong connecting QuickBooks. Please try again, or export the report below.' };
  }
}

