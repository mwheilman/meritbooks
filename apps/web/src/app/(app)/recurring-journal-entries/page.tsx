import { redirect } from 'next/navigation';

export const metadata = { title: 'Recurring journal entries' };

// Retired standalone route. Recurring journal entries are now the "Recurring" tab of
// Journal Entries. Keep the URL working by redirecting into its new tab home.
export default function RecurringJournalEntriesPage() {
  redirect('/journal-entries?tab=recurring');
}
