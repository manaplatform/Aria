import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import type { SettingsCategoryId, ToolSettings } from '@aria/shared';
import { refreshProvider, useProviderStore } from '../../stores/providerStore';
import { desktop } from '../../services/desktop';
import {
  getCategoryMeta,
  settingsCategories,
  settingsSearchIndex,
  type SettingsSearchItem,
} from './settingsRegistry';
import { SettingsStatus } from './components';

export function SettingsSearch({
  onSelect,
}: {
  onSelect: (category: SettingsCategoryId, settingId?: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [capabilities, setCapabilities] = useState<ToolSettings>();
  const registry = useProviderStore((state) => state.settings);
  const loadSearchData = () => {
    void refreshProvider();
    if (window.aria?.toolSettings) void desktop().toolSettings().then(setCapabilities).catch(() => undefined);
  };
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo<SettingsSearchItem[]>(() => {
    const term = query.trim().toLowerCase();
    if (!term) return [];
    const categoryMatches: SettingsSearchItem[] = settingsCategories
      .filter(
        (cat) =>
          cat.label.toLowerCase().includes(term) || cat.description.toLowerCase().includes(term),
      )
      .map((cat) => ({
        id: `cat-${cat.id}`,
        category: cat.id,
        title: cat.label,
        description: cat.description,
        keywords: [],
      }));
    const itemMatches = settingsSearchIndex.filter(
      (item) =>
        item.title.toLowerCase().includes(term) ||
        item.description.toLowerCase().includes(term) ||
        item.keywords.some((kw) => kw.toLowerCase().includes(term)),
    );
    const dynamic: SettingsSearchItem[] = [
      ...(registry?.connections.flatMap((connection) => [
        { id: `provider-${connection.id}`, category: 'providers' as const, title: connection.name, description: connection.baseUrl, keywords: ['provider', 'connection'], settingId: `settings-provider-${connection.id}` },
        ...connection.models.map((model) => ({ id: `model-${connection.id}-${model.id}`, category: 'models' as const, title: model.id, description: connection.name, keywords: ['model'], settingId: `settings-model-${connection.id}-${model.id}` })),
      ]) ?? []),
      ...(capabilities?.tools.map((tool) => ({ id: `tool-${tool.id}`, category: 'integrations' as const, title: tool.name, description: tool.description, keywords: [tool.id, 'tool'], settingId: `settings-tool-${tool.id}` })) ?? []),
      ...(capabilities?.skills.map((skill) => ({ id: `skill-${skill.id}-${skill.version}`, category: 'integrations' as const, title: skill.name, description: skill.description, keywords: [skill.id, 'skill'], settingId: `settings-skill-${skill.id}-${skill.version}` })) ?? []),
    ];
    const dynamicMatches = dynamic.filter((item) => [item.title, item.description, ...item.keywords].some((value) => value.toLowerCase().includes(term)));
    return [...itemMatches, ...dynamicMatches, ...categoryMatches].slice(0, 12);
  }, [query, registry, capabilities]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.matches('input, textarea, select, [contenteditable=true]');
      if (((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') || (event.key === '/' && !typing && !event.metaKey && !event.ctrlKey && !event.altKey)) {
        event.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  const choose = (item: SettingsSearchItem) => {
    onSelect(item.category, item.settingId);
    setOpen(false);
    setQuery('');
  };

  return (
    <div ref={containerRef} className="settings-search">
      <div className="settings-search-input-wrap">
        <Search size={15} aria-hidden="true" />
        <input
          ref={inputRef}
          type="search"
          aria-label="Search settings"
          placeholder="Search settings…"
          value={query}
          onFocus={() => { setOpen(true); loadSearchData(); }}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (!results.length) {
              if (event.key === 'Escape') {
                setOpen(false);
                setQuery('');
              }
              return;
            }
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setActiveIndex((index) => (index + 1) % results.length);
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActiveIndex((index) => (index - 1 + results.length) % results.length);
            } else if (event.key === 'Enter') {
              event.preventDefault();
              const chosen = results[activeIndex];
              if (chosen) choose(chosen);
            } else if (event.key === 'Escape') {
              setOpen(false);
            }
          }}
        />
        {query && (
          <button
            type="button"
            aria-label="Clear settings search"
            onClick={() => {
              setQuery('');
              inputRef.current?.focus();
            }}
          >
            <X size={14} />
          </button>
        )}
      </div>
      {open && query.trim() && (
        <div className="settings-search-results" role="listbox" aria-label="Matching settings">
          {results.length === 0 ? (
            <div className="settings-search-empty">No matching settings for “{query.trim()}”.</div>
          ) : (
            results.map((item, index) => {
              const meta = getCategoryMeta(item.category);
              return (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  data-active={index === activeIndex}
                  className="settings-search-item"
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => choose(item)}
                >
                  <div>
                    <strong>{item.title}</strong>
                    <span>{item.description}</span>
                  </div>
                  <SettingsStatus tone="accent">{meta.label}</SettingsStatus>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
