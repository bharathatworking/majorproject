import React from 'react';
import { DocumentList } from './DocumentList';
import type { DocumentIndexEntry, LLMAvailability } from '../../types';

type NavPage = 'dashboard' | 'reading' | 'progress' | 'settings';

interface SidebarProps {
  docs: DocumentIndexEntry[];
  activeId: string | null;
  nav: NavPage;
  availability: LLMAvailability | 'checking';
  collapsed: boolean;
  onToggleCollapse: () => void;
  onSwitchDoc: (id: string) => void;
  onRemoveDoc: (id: string) => void;
  onNav: (page: NavPage) => void;
  onNewDoc: () => void;
}

const NAV_ITEMS: { page: NavPage; icon: string; label: string }[] = [
  { page: 'dashboard', icon: '⊞', label: 'Dashboard' },
  { page: 'reading',   icon: '≡', label: 'Reading'   },
  { page: 'progress',  icon: '↗', label: 'Progress'  },
  { page: 'settings',  icon: '⚙', label: 'Settings'  },
];

const AVAILABILITY_CHIP: Record<LLMAvailability | 'checking', { label: string; cls: string }> = {
  checking:    { label: '⏳ Checking…',      cls: 'checking'   },
  available:   { label: '● Ollama Ready',    cls: 'available'  },
  unavailable: { label: '✗ Not reachable',   cls: 'unavailable'},
  downloadable:{ label: '↓ Downloadable',    cls: 'downloading'},
  downloading: { label: '↓ Downloading…',    cls: 'downloading'},
};

export function Sidebar({
  docs, activeId, nav, availability, collapsed,
  onToggleCollapse, onSwitchDoc, onRemoveDoc, onNav, onNewDoc,
}: SidebarProps) {
  const chip = AVAILABILITY_CHIP[availability];

  return (
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`} aria-label="Sidebar">
      {/* ── Header ── */}
      <div className="sidebar-header">
        {!collapsed && (
          <span className="sidebar-logo" aria-hidden="true">
            <span className="logo-text">Clarity</span>
          </span>
        )}
        <button
          className="sidebar-toggle"
          onClick={onToggleCollapse}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? '›' : '‹'}
        </button>
      </div>

      {/* ── New document ── */}
      <div className="sidebar-new-doc">
        <button className="btn-new-doc" onClick={onNewDoc} title="Add new document">
          <span aria-hidden="true">＋</span>
          {!collapsed && <span>New document</span>}
        </button>
      </div>

      {/* ── Recent documents ── */}
      {!collapsed && (
        <div className="sidebar-docs">
          <DocumentList
            docs={docs}
            activeId={activeId}
            onSwitch={onSwitchDoc}
            onRemove={onRemoveDoc}
          />
        </div>
      )}

      {/* ── Navigation ── */}
      <nav className="sidebar-nav" aria-label="Main navigation">
        {NAV_ITEMS.map(item => (
          <button
            key={item.page}
            className={`nav-item ${nav === item.page ? 'active' : ''}`}
            onClick={() => onNav(item.page)}
            aria-current={nav === item.page ? 'page' : undefined}
            title={collapsed ? item.label : undefined}
          >
            <span className="nav-icon" aria-hidden="true">{item.icon}</span>
            {!collapsed && <span className="nav-label">{item.label}</span>}
          </button>
        ))}
      </nav>

      {/* ── Ollama status ── */}
      <div className="sidebar-footer">
        <div className={`ollama-chip ollama-${chip.cls}`} title="Ollama AI model status">
          {!collapsed ? chip.label : chip.cls === 'available' ? '●' : '✗'}
        </div>
      </div>
    </aside>
  );
}
