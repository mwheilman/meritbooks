'use client';

import { useState, useCallback } from 'react';
import { Plus } from 'lucide-react';
import { PageHeader } from '@/components/ui';
import { JournalEntryList } from './je-list';
import { JournalEntryForm } from './je-form';

export default function JournalEntriesPage() {
  const [showCreate, setShowCreate] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const handleSuccess = useCallback(() => {
    setShowCreate(false);
    setRefreshKey((k) => k + 1);
  }, []);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Journal Entries"
        description="Create, review, and post manual journal entries to the general ledger."
        actions={
          !showCreate ? (
            <button
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-500 transition-colors"
            >
              <Plus size={16} /> New Entry
            </button>
          ) : undefined
        }
      />

      {showCreate && (
        <JournalEntryForm
          onClose={() => setShowCreate(false)}
          onSuccess={handleSuccess}
        />
      )}

      <JournalEntryList key={refreshKey} />
    </div>
  );
}
