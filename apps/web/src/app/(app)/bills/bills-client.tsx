'use client';

import { useState, useCallback } from 'react';
import { Button, PageHeader } from '@/components/ui';
import { BillList } from './bill-list';
import { BillForm } from './bill-form';
import { AutoFileModal } from './auto-file-modal';
import { BillsTabs } from './bills-tabs';
import { InboxAddressCard } from '@/components/inbound-email/inbox-address-card';
import s from './bills.module.css';

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
    <div className={s.stack}>
      <PageHeader
        title="Bills"
        description="Vendor bills: read by AI, routed for approval, scheduled and paid."
        actions={
          !showCreate ? (
            <>
              <Button icon="upload" onClick={() => setShowAutoFile(true)}>
                Auto-file a bill
              </Button>
              <Button variant="primary" icon="plus" onClick={() => setShowCreate(true)}>
                New bill
              </Button>
            </>
          ) : undefined
        }
      />

      <BillsTabs />

      {/* AP inbox (FPB-ap-intake): the company's ap- address, Copy, Active / Not yet active. */}
      <InboxAddressCard purpose="ap" />

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
