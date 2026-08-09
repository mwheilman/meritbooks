'use client';

import { useState, useCallback } from 'react';
import { Plus, Sparkles } from 'lucide-react';
import { PageHeader } from '@/components/ui';
import { BillList } from './bill-list';
import { BillForm } from './bill-form';
import { AutoFileModal } from './auto-file-modal';
import { BillsTabs } from './bills-tabs';

export function BillsClient() {
  const [showCreate, setShowCreate] = useState(false);
  const [showAutoFile, setShowAutoFile] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const handleSuccess = useCallback(() => {
    setShowCreate(false);
    setRefreshKey((k) => k + 1);
  }, []);

  const handleFiled = useCallback(() => {
    setShowAutoFile(false);
    setRefreshKey((k) => k + 1);
  }, []);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Bills"
        description="Vendor invoices with AI extraction and compliance tracking"
        actions={
          !showCreate ? (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowAutoFile(true)}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-500 transition-colors"
              >
                <Sparkles size={16} /> Auto-file invoice
              </button>
              <button
                onClick={() => setShowCreate(true)}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-500 transition-colors"
              >
                <Plus size={16} /> New Bill
              </button>
            </div>
          ) : undefined
        }
      />

      <BillsTabs />

      {showAutoFile && (
        <AutoFileModal onClose={() => setShowAutoFile(false)} onFiled={handleFiled} />
      )}

      {showCreate && (
        <BillForm
          onClose={() => setShowCreate(false)}
          onSuccess={handleSuccess}
        />
      )}

      <BillList key={refreshKey} />
    </div>
  );
}
