import { redirect } from 'next/navigation';

// RETIRED — "Needs Attention" was merged into the unified Inbox. The inline-resolve
// behavior lives on in the Inbox → Exceptions tab (see inbox/exceptions-queue.tsx).
// Kept as a redirect so existing deep links keep working.
export default function ExceptionsRedirect() {
  redirect('/inbox?tab=exceptions');
}
