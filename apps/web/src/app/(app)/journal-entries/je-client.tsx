'use client';

import { useState, useCallback } from 'react';
import { Button, PageHeader } from '@/components/ui';
import { JournalEntryList } from './je-list';
import { JournalEntryForm } from './je-form';
import { JeAiComposer } from './je-ai-composer';
import s from './je.module.css';

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
    <div className={s.stack}>
      <PageHeader
        title="Journal entries"
        description="Create, review and post manual journal entries to the general ledger."
        actions={
          !showCreate && !showCompose ? (
            <>
              <Button icon="ask" onClick={() => setShowCompose(true)}>
                Compose with AI
              </Button>
              <Button variant="primary" icon="plus" onClick={() => setShowCreate(true)}>
                New entry
              </Button>
            </>
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
