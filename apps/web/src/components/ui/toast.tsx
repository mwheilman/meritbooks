'use client';

import { CheckCircle, XCircle, X } from 'lucide-react';
import { clsx } from 'clsx';
import { useToast, type Toast } from '@/hooks/use-toast';

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  return (
    <div
      className={clsx(
        'flex items-center gap-3 px-4 py-3 rounded-lg shadow-lg border backdrop-blur-sm',
        'animate-in slide-in-from-right-full fade-in duration-300',
        toast.type === 'success' && 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300',
        toast.type === 'error' && 'bg-red-500/10 border-red-500/20 text-red-300',
      )}
    >
      {toast.type === 'success' ? (
        <CheckCircle size={16} className="shrink-0 text-emerald-400" />
      ) : (
        <XCircle size={16} className="shrink-0 text-red-400" />
      )}
      <p className="text-sm flex-1">{toast.message}</p>
      <button
        onClick={onDismiss}
        className="shrink-0 p-0.5 rounded hover:bg-white/10 transition-colors"
      >
        <X size={14} className="text-slate-500" />
      </button>
    </div>
  );
}

export function ToastContainer() {
  const { toasts, removeToast } = useToast();

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
      {toasts.map((toast) => (
        <ToastItem
          key={toast.id}
          toast={toast}
          onDismiss={() => removeToast(toast.id)}
        />
      ))}
    </div>
  );
}
