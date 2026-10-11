import React, { useState, useRef, useCallback } from 'react';
import { createDocumentFromPaste } from '../../lib/input/paste';
import { createDocumentFromPDF } from '../../lib/input/pdf';
import type { ClarityDocument } from '../../types';

type DialogTab = 'paste' | 'pdf';

interface NewDocDialogProps {
  onClose: () => void;
  /** Called with the newly created document. Parent handles navigation. */
  onSuccess: (doc: ClarityDocument) => void;
}

export function NewDocDialog({ onClose, onSuccess }: NewDocDialogProps) {
  const [tab,       setTab]       = useState<DialogTab>('paste');
  const [pasteText, setPasteText] = useState('');
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState<string | null>(null);
  const [dragOver,  setDragOver]  = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Paste submission ────────────────────────────────────────────────────────
  const handlePasteSubmit = async () => {
    setError(null);
    setLoading(true);
    try {
      const doc = await createDocumentFromPaste(pasteText);
      onSuccess(doc);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  // ── PDF file handling ───────────────────────────────────────────────────────
  const handleFile = useCallback(async (file: File) => {
    setError(null);
    setLoading(true);
    try {
      const doc = await createDocumentFromPDF(file);
      onSuccess(doc);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);  // keep dialog open on PDF error so user can try another
    }
  }, [onSuccess]);

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
    // Reset so same file can be picked again if needed
    e.target.value = '';
  }, [handleFile]);

  const charCount = pasteText.length;
  const pasteReady = charCount >= 50;

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div
      className="dialog-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Add new document"
    >
      <div className="dialog" onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="dialog-header">
          <h2>New document</h2>
          <button className="dialog-close" onClick={onClose} aria-label="Close" disabled={loading}>×</button>
        </div>

        {/* Tabs */}
        <div className="dialog-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={tab === 'paste'}
            className={tab === 'paste' ? 'active' : ''}
            onClick={() => { setTab('paste'); setError(null); }}
            disabled={loading}
          >
            📋 Paste text
          </button>
          <button
            role="tab"
            aria-selected={tab === 'pdf'}
            className={tab === 'pdf' ? 'active' : ''}
            onClick={() => { setTab('pdf'); setError(null); }}
            disabled={loading}
          >
            📄 Upload PDF
          </button>
        </div>

        {/* Body */}
        <div className="dialog-body">

          {/* Error banner */}
          {error && (
            <div className="dialog-error" role="alert">
              {error}
            </div>
          )}

          {/* ── Paste tab ── */}
          {tab === 'paste' && (
            <div className="dialog-tab-content">
              <textarea
                className="paste-textarea"
                placeholder="Paste the text you want to simplify here…"
                rows={10}
                value={pasteText}
                onChange={e => setPasteText(e.target.value)}
                disabled={loading}
                autoFocus
                aria-label="Text to simplify"
              />
              <div className="paste-footer">
                <span className={`char-count ${pasteReady ? '' : 'char-count-low'}`}>
                  {charCount} chars {pasteReady ? '✓' : `(need ${50 - charCount} more)`}
                </span>
              </div>
            </div>
          )}

          {/* ── PDF tab ── */}
          {tab === 'pdf' && (
            <div
              className={`pdf-drop-zone ${dragOver ? 'drag-over' : ''} ${loading ? 'loading' : ''}`}
              onDragOver={e => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={e => { e.preventDefault(); setDragOver(false); }}
              onDrop={handleDrop}
              aria-label="Drop PDF here or click Browse"
            >
              {loading ? (
                <div className="pdf-loading-state">
                  <span className="spinner" aria-hidden="true" />
                  <span>Extracting text…</span>
                </div>
              ) : (
                <>
                  <span className="pdf-drop-icon" aria-hidden="true">📄</span>
                  <p className="pdf-drop-label">Drop a PDF here</p>
                  <span className="pdf-drop-or">or</span>
                  <button
                    className="btn-secondary"
                    onClick={() => fileInputRef.current?.click()}
                    type="button"
                  >
                    Browse files
                  </button>
                  <p className="dialog-hint">Text-based PDFs only — scanned images are not supported.</p>
                </>
              )}

              {/* Hidden file input */}
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,application/pdf"
                style={{ display: 'none' }}
                onChange={handleFileInput}
                aria-hidden="true"
              />
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="dialog-footer">
          <button className="btn-secondary" onClick={onClose} disabled={loading}>
            Cancel
          </button>
          {tab === 'paste' && (
            <button
              className="btn-primary"
              onClick={handlePasteSubmit}
              disabled={loading || !pasteReady}
              title={!pasteReady ? `Need at least 50 characters (have ${charCount})` : ''}
            >
              {loading ? <><span className="spinner" style={{ width: 12, height: 12 }} /> Adding…</> : 'Add document'}
            </button>
          )}
        </div>

      </div>
    </div>
  );
}
