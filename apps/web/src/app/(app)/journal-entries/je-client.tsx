'use client';

import { useState, useCallback } from 'react';
import { Plus, Sparkles } from 'lucide-react';
import { PageHeader } from '@/components/ui';
import { JournalEntryList } from './je-list';
import { JournalEntryForm } from './je-form';
import { JeAiComposer } from './je-ai-composer';

export function JournalEntriesClient() {
  const [showCreate, setShowCreate] = useState(false);
  const [showCompose, setShowCompose] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const handleSuccess = useCallback(() => {
    setShowCreate(false);
    setShowCompose(false);
    setRefreshKey((k) => k + 1);
  }, []);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Journal Entries"
        description="Create, review, and post manual journal entries to the general ledger."
        actions={
          !showCreate && !showCompose ? (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowCompose(true)}
                className="flex items-center gap-2 px-4 py-2 rounded-lg border border-emerald-500/40 text-emerald-300 text-sm font-medium hover:bg-emerald-500/10 transition-colors"
              >
                <Sparkles size={16} /> Compose with AI
              </button>
              <button
                onClick={() => setShowCreate(true)}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-500 transition-colors"
              >
                <Plus size={16} /> New Entry
              </button>
            </div>
          ) : undefined
        }
      />

      {showCompose && (
        <JeAiComposer
          onClose={() => setShowCompose(false)}
          onSuccess={handleSuccess}
        />
      )}

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
