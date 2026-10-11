import React, { useState, useCallback } from 'react';
import type { DocumentIndexEntry } from '../../types';

interface DocumentListProps {
  docs: DocumentIndexEntry[];
  activeId: string | null;
  onSwitch: (id: string) => void;
  onRemove: (id: string) => void;
}

const SOURCE_ICON: Record<DocumentIndexEntry['source'], string> = {
  page: '🌐',
  paste: '📋',
  pdf: '📄',
};

export function DocumentList({ docs, activeId, onSwitch, onRemove }: DocumentListProps) {
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const handleRemoveClick = useCallback((e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (confirmId === id) {
      onRemove(id);
      setConfirmId(null);
    } else {
      setConfirmId(id);
    }
  }, [confirmId, onRemove]);

  if (docs.length === 0) {
    return (
      <div className="doc-list-empty">
        <p>No documents yet.<br />Click the Clarity icon on any page.</p>
      </div>
    );
  }

  return (
    <ul className="doc-list" role="list">
      {docs.map(doc => (
        <li
          key={doc.id}
          className={`doc-item ${doc.id === activeId ? 'active' : ''}`}
          onClick={() => { onSwitch(doc.id); setConfirmId(null); }}
          role="button"
          tabIndex={0}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSwitch(doc.id); } }}
          aria-label={`Switch to ${doc.title}`}
          aria-current={doc.id === activeId ? 'true' : undefined}
        >
          <span className="doc-icon" aria-hidden="true">{SOURCE_ICON[doc.source]}</span>
          <div className="doc-info">
            <span className="doc-title">{doc.title}</span>
            <span className="doc-meta">
              {timeAgo(doc.updatedAt)}
              {doc.hasResults && <span className="doc-badge">Simplified</span>}
            </span>
          </div>
          <button
            className={`doc-remove ${confirmId === doc.id ? 'confirming' : ''}`}
            onClick={e => handleRemoveClick(e, doc.id)}
            aria-label={confirmId === doc.id ? 'Click again to confirm removal' : `Remove ${doc.title}`}
            title={confirmId === doc.id ? 'Click again to confirm' : 'Remove'}
          >
            {confirmId === doc.id ? '!' : '×'}
          </button>
        </li>
      ))}
    </ul>
  );
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return 'yesterday';
  return `${days}d ago`;
}
