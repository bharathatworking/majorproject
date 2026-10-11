import React, { useEffect, useState } from 'react';

export interface ToastItem {
  id: string;
  message: string;
  type?: 'info' | 'success' | 'error';
}

interface ToastProps {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
}

const TOAST_DURATION_MS = 4000;

export function ToastContainer({ toasts, onDismiss }: ToastProps) {
  return (
    <div className="toast-container" role="status" aria-live="polite">
      {toasts.map(t => (
        <Toast key={t.id} item={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function Toast({ item, onDismiss }: { item: ToastItem; onDismiss: (id: string) => void }) {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(item.id), TOAST_DURATION_MS);
    return () => clearTimeout(timer);
  }, [item.id, onDismiss]);

  return (
    <div className={`toast toast-${item.type ?? 'info'}`}>
      <span className="toast-msg">{item.message}</span>
      <button className="toast-close" onClick={() => onDismiss(item.id)} aria-label="Dismiss">×</button>
    </div>
  );
}
