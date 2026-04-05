import { PageHeader } from '@/components/ui';
import { SettingsTabs } from './settings-tabs';

export default function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" description="Organization, integrations, and configuration" />
      <SettingsTabs />
    </>
  );
}
