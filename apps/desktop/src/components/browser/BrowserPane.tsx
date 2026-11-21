import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { BrowserCommand, BrowserTab } from '@aria/shared';
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe2,
  Plus,
  RotateCw,
  Square,
  Star,
  X,
} from 'lucide-react';
import { Button, IconButton, Modal } from '../ui';
import { browserCommand, setBrowserMode, useBrowserStore } from '../../stores/browserStore';
import { setChatDraft } from '../../stores/chatStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { notify } from '../../stores/uiStore';

let layoutRevision = 0;

export function useBrowserSlot(conversationId: string | null, visible: boolean) {
  const slot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const bridge = window.aria;
    if (!bridge?.browserLayout) return;
    let frame = 0;
    const publish = () => {
      const covered = !!document.querySelector('[role="dialog"][data-state="open"]');
      const rect = visible && !covered ? slot.current?.getBoundingClientRect() : null;
      const bounds =
        rect && rect.width > 0 && rect.height > 0
          ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          : null;
      void bridge
        .browserLayout({ revision: ++layoutRevision, conversationId, bounds })
        .catch(() => undefined);
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(publish);
    };
    const observer = new ResizeObserver(schedule);
    if (slot.current) observer.observe(slot.current);
    const dialogs = new MutationObserver((records) => {
      if (
        records.some(
          (record) =>
            record.type === 'attributes' ||
            [...record.addedNodes, ...record.removedNodes].some(
              (node) =>
                node instanceof Element &&
                (node.matches('[role="dialog"]') || node.querySelector('[role="dialog"]')),
            ),
        )
      )
        schedule();
    });
    dialogs.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-state'],
    });
    window.addEventListener('resize', schedule);
    window.addEventListener('focus', schedule);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      dialogs.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('focus', schedule);
      void bridge
        .browserLayout({ revision: ++layoutRevision, conversationId, bounds: null })
        .catch(() => undefined);
    };
  }, [conversationId, visible]);
  return slot;
}

type SharedContent = { text: string; kind: 'share-link' | 'share-selection' };

function SharePreview({ content, close }: { content: SharedContent | null; close: () => void }) {
  return (
    <Modal
      open={content !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title="Share with Aria"
      description="Add this content to the chat draft for review before sending."
    >
      <blockquote className="browser-share-preview">{content?.text}</blockquote>
      <Button
        variant="primary"
        onClick={() => {
          if (!content) return;
          const chat = useWorkspaceStore.getState().data.chat;
          const draft =
            chat.conversations.find((entry) => entry.id === chat.selectedId)?.draft ??
            chat.newDraft;
          const text =
            content.kind === 'share-selection'
              ? `Website selection:\n${content.text
                  .split(/\r?\n/)
                  .map((line) => `> ${line}`)
                  .join('\n')}`
              : content.text;
          const next = [draft, text].filter(Boolean).join('\n\n');
          if (next.length > 100_000) {
            notify('The chat draft is too long to add this selection.', true);
            return;
          }
          setChatDraft(next, chat.selectedId);
          if (useBrowserStore.getState().mode === 'browser') setBrowserMode('split');
          close();
          requestAnimationFrame(() => window.dispatchEvent(new Event('aria:focus-chat')));
        }}
      >
        Add to draft
      </Button>
    </Modal>
  );
}

function AddressBar({ tab }: { tab?: BrowserTab }) {
  const [input, setInput] = useState(tab?.url || '');
  const [editing, setEditing] = useState(false);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!input.trim()) return;
    void browserCommand(tab ? { kind: 'navigate', tabId: tab.id, input } : { kind: 'open', input });
    setEditing(false);
  };
  return (
    <form className="browser-address-form" onSubmit={submit}>
      <input
        aria-label="Address or search"
        placeholder="Enter an address or search"
        maxLength={2000}
        value={editing ? input : tab?.url || ''}
        readOnly={tab?.profile === 'ai'}
        onFocus={(event) => {
          setInput(tab?.url || '');
          setEditing(true);
          event.target.select();
        }}
        onBlur={() => setEditing(false)}
        onChange={(event) => setInput(event.target.value)}
      />
    </form>
  );
}

export function BrowserPane({ slot }: { slot: React.RefObject<HTMLDivElement> }) {
  const state = useBrowserStore((store) => store.state);
  const tab = state.tabs.find(({ id }) => id === state.selected);
  const personal = tab?.profile === 'personal';
  const [panel, setPanel] = useState<'find' | 'history' | 'bookmarks' | null>(null);
  const [query, setQuery] = useState('');
  const [preview, setPreview] = useState<SharedContent | null>(null);
  const command = (kind: Extract<BrowserCommand, { tabId: string }>['kind']) => {
    if (tab) void browserCommand({ kind, tabId: tab.id } as BrowserCommand);
  };
  const share = async (kind: 'share-link' | 'share-selection') => {
    if (!tab) return;
    const text = await browserCommand({ kind, tabId: tab.id });
    if (text) setPreview({ text, kind });
    else
      notify(
        kind === 'share-selection'
          ? 'Select text on the page first.'
          : 'This tab has no page link.',
        true,
      );
  };
  const find = (next: string, forward = true) => {
    if (tab) void browserCommand({ kind: 'find', tabId: tab.id, query: next, forward });
  };
  const open = (url?: string) => void browserCommand({ kind: 'open', input: url });
  return (
    <section className="browser-pane" aria-label="Aria browser">
      <div className="browser-tabs" role="group" aria-label="Browser tabs">
        {state.tabs.map((item) => (
          <div
            key={item.id}
            className={item.id === state.selected ? 'browser-tab active' : 'browser-tab'}
          >
            <button
              aria-pressed={item.id === state.selected}
              title={item.title}
              onClick={() => void browserCommand({ kind: 'select', tabId: item.id })}
            >
              {item.icon ? <img src={item.icon} alt="" /> : <Globe2 size={13} />}
              <span>
                {item.profile === 'ai' ? 'AI · ' : ''}
                {item.title}
              </span>
            </button>
            <IconButton
              label={`Close tab ${item.title}`}
              onClick={() => void browserCommand({ kind: 'close', tabId: item.id })}
            >
              <X size={13} />
            </IconButton>
          </div>
        ))}
        <IconButton label="New browser tab" onClick={() => open()}>
          <Plus size={17} />
        </IconButton>
      </div>
      <div className="browser-toolbar">
        <IconButton
          label="Browser back"
          disabled={!personal || !tab?.back}
          onClick={() => command('back')}
        >
          <ArrowLeft size={16} />
        </IconButton>
        <IconButton
          label="Browser forward"
          disabled={!personal || !tab?.forward}
          onClick={() => command('forward')}
        >
          <ArrowRight size={16} />
        </IconButton>
        <IconButton
          label={tab?.loading ? 'Stop loading' : 'Reload page'}
          disabled={!personal || (!tab?.url && !tab?.loading)}
          onClick={() => command(tab?.loading ? 'stop' : 'reload')}
        >
          {tab?.loading ? <Square size={14} /> : <RotateCw size={15} />}
        </IconButton>
        <AddressBar key={tab?.id ?? 'blank'} tab={tab} />
        <IconButton
          label="Toggle bookmark"
          disabled={!personal || !tab?.url}
          onClick={() => command('bookmark')}
        >
          <Star size={16} />
        </IconButton>
        <IconButton
          label="Open page externally"
          disabled={!tab?.url}
          onClick={() => command('external')}
        >
          <ExternalLink size={15} />
        </IconButton>
      </div>
      <div className="browser-actions">
        {(['find', 'bookmarks', 'history'] as const).map((item) => (
          <Button
            size="sm"
            variant="ghost"
            key={item}
            aria-pressed={panel === item}
            disabled={item === 'find' && !personal}
            onClick={() => {
              if (panel === 'find' && item === 'find') find('');
              setPanel(panel === item ? null : item);
            }}
          >
            {item[0].toUpperCase() + item.slice(1)}
          </Button>
        ))}
        {personal && tab && (
          <div className="browser-zoom" aria-label="Browser zoom">
            {([-1, 0, 1] as const).map((delta) => (
              <Button
                key={delta}
                size="sm"
                variant="ghost"
                aria-label={delta ? (delta < 0 ? 'Zoom out' : 'Zoom in') : 'Reset zoom'}
                onClick={() => void browserCommand({ kind: 'zoom', delta, tabId: tab.id })}
              >
                {delta === -1 ? '−' : delta === 1 ? '+' : `${tab.zoom}%`}
              </Button>
            ))}
          </div>
        )}
        {tab?.url && (
          <Button variant="ghost" size="sm" onClick={() => void share('share-link')}>
            Share link
          </Button>
        )}
        {personal && tab?.url && (
          <Button variant="ghost" size="sm" onClick={() => void share('share-selection')}>
            Share selection
          </Button>
        )}
        {tab?.profile === 'ai' && tab.url && (
          <Button variant="ghost" size="sm" onClick={() => open(tab.url)}>
            Open in Personal
          </Button>
        )}
      </div>
      {panel === 'find' && personal && (
        <form
          className="browser-toolbar"
          onSubmit={(event) => {
            event.preventDefault();
            find(query);
          }}
        >
          <input
            aria-label="Find in page"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              find(event.target.value);
            }}
            maxLength={200}
          />
          <Button size="sm" type="button" onClick={() => find(query, false)}>
            Previous
          </Button>
          <Button size="sm" type="submit">
            Next
          </Button>
          {tab.matches && (
            <output aria-live="polite">
              {tab.matches.index} / {tab.matches.count}
            </output>
          )}
        </form>
      )}
      {(panel === 'history' || panel === 'bookmarks') && (
        <div className="browser-library" aria-label={panel}>
          {!state[panel].length && (
            <span>No {panel === 'history' ? 'history' : 'bookmarks'} saved.</span>
          )}
          {state[panel].map((entry) => (
            <Button
              key={entry.url}
              variant="ghost"
              size="sm"
              title={entry.url}
              onClick={() => {
                open(entry.url);
                setPanel(null);
              }}
            >
              {entry.title}
            </Button>
          ))}
        </div>
      )}
      {tab?.loading && (
        <div className="browser-loading" role="progressbar" aria-label="Loading page" />
      )}
      {state.warning && (
        <p className="browser-status" role="status">
          {state.warning}
        </p>
      )}
      {tab?.error && (
        <div className="browser-status" role="alert">
          {tab.error}{' '}
          {tab.crashed && (
            <Button size="sm" onClick={() => command('recover')}>
              Recover tab
            </Button>
          )}
        </div>
      )}
      <div ref={slot} className="browser-viewport" aria-label="Website content">
        {!tab?.url && !tab?.loading && !tab?.error && (
          <div className="browser-empty">
            <Globe2 size={28} />
            <p>Enter a web address to get started.</p>
          </div>
        )}
      </div>
      <SharePreview content={preview} close={() => setPreview(null)} />
    </section>
  );
}
