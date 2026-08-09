import { redirect } from 'next/navigation';

// RETIRED — "Flagged Items" was a strict subset of the Inbox with a dead "Resolve
// All" action. Merged into the unified Inbox (flagged bank/receipt/bill items now
// live on the Inbox → Exceptions tab, which can resolve them inline). Kept as a
// redirect so existing links keep working.
export default function FlaggedRedirect() {
  redirect('/inbox');
}
