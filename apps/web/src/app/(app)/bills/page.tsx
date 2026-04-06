'use client';

import { useState, useCallback } from 'react';
import { Plus } from 'lucide-react';
import { PageHeader } from '@/components/ui';
import { BillList } from './bill-list';
import { BillForm } from './bill-form';

export default function BillsPage() {
  const [showCreate, setShowCreate] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const handleSuccess = useCallback(() => {
    setShowCreate(false);
    setRefreshKey((k) => k + 1);
  }, []);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Bills"
        description="Vendor invoices with AI extraction and compliance tracking"
        actions={
          !showCreate ? (
            <button
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-500 transition-colors"
            >
              <Plus size={16} /> New Bill
            </button>
          ) : undefined
        }
      />

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
