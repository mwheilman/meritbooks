import { BrandLockup } from '@/components/brand/brand-mark';

export default function SetupLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-surface-950 flex flex-col">
      <header className="border-b border-shell-line bg-shell px-6 py-3.5">
        <BrandLockup tone="onDark" size={28} />
      </header>
      <main className="flex-1 flex items-start justify-center px-6 py-12">
        <div className="w-full max-w-lg">{children}</div>
      </main>
    </div>
  );
}
