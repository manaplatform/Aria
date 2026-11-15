import { createHash, randomUUID } from 'node:crypto';
import {
  dialog,
  nativeImage,
  session,
  shell,
  WebContentsView,
  type BrowserWindow,
  type Rectangle,
} from 'electron';
import {
  browserToolArgs,
  publicWebUrl,
  webUrlSchema,
  type BrowserCommand,
  type BrowserLayout,
  type BrowserRequest,
  type BrowserState,
  type BrowserTab,
  type WebPolicy,
} from '@aria/shared';
import { BrowserProxy } from './egress-proxy';
import { inspectPage } from './page-inspector';
import { BrowserSessionPolicy } from './session-policy';
import { BrowserStateStorage, type BrowserDiskState } from './state-storage';

class BrowserError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
type Tab = {
  state: BrowserTab;
  owner?: string;
  documentId: string;
  runId?: string;
  view: WebContentsView;
  profile: BrowserSessionPolicy;
  findId?: number;
  findQuery?: string;
  submissions?: { requestId: string; fingerprints: Set<string> };
  queue: Promise<unknown>;
  lifetime: AbortController;
};

function whenActive<T>(promise: Promise<T>, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export class BrowserController {
  private readonly proxy = new BrowserProxy();
  private readonly tabs = new Map<string, Tab>();
  private readonly storage: BrowserStateStorage;
  private readonly profiles = new Map<string, Promise<BrowserSessionPolicy>>();
  private readonly personalProfiles = new Set<BrowserSessionPolicy>();
  private readonly partitionNonce = randomUUID();
  private selected: string | null = null;
  private conversationId: string | null = null;
  private window?: BrowserWindow;
  private visible?: Tab;
  private layout?: BrowserLayout;
  private layoutRevision = -1;
  private disk: BrowserDiskState = {
    version: 1,
    history: [],
    bookmarks: [],
    tabs: [],
    selected: -1,
  };
  private pending = 0;
  private restoreGeneration = 0;
  private privacyEpoch = 0;
  private readonly aiSelected = new Map<string, string>();
  private personalSelected: string | null = null;

  constructor(
    directory: string,
    private readonly policy: () => WebPolicy,
  ) {
    this.storage = new BrowserStateStorage(directory);
  }

  async load() {
    this.disk = await this.storage.read();
    this.disk.history = this.disk.history.filter((entry) => Date.now() - entry.at < 30 * 86400_000);
  }

  attach(window: BrowserWindow) {
    this.window = window;
    const generation = ++this.restoreGeneration;
    const reposition = () => {
      if (this.window === window) this.place();
    };
    window.on('resize', reposition);
    window.on('enter-full-screen', reposition);
    window.on('leave-full-screen', reposition);
    window.on('minimize', reposition);
    window.on('restore', reposition);
    if (!this.policy().restoreTabs || !this.policy().enabled) return;
    const urls = [...this.disk.tabs];
    const index = this.disk.selected;
    void (async () => {
      const restored: Tab[] = [];
      for (const url of urls) {
        if (this.restoreGeneration !== generation || window.isDestroyed()) return;
        const tab = await this.create();
        restored.push(tab);
        void this.navigate(tab, url).catch(() => undefined);
      }
      if (!this.selected && restored.length) this.select(restored[index] ?? restored[0]);
    })().catch(() => undefined);
  }

  resetRenderer() {
    this.layoutRevision = -1;
    this.layout = undefined;
    this.conversationId = null;
    this.selected = this.personalSelected;
    this.place();
  }

  async detach() {
    ++this.restoreGeneration;
    this.layoutRevision = -1;
    this.layout = undefined;
    this.place();
    for (const tab of [...this.tabs.values()]) this.closeTab(tab);
    this.conversationId = null;
    this.selected = null;
    this.personalSelected = null;
    this.aiSelected.clear();
    this.window = undefined;
    await this.storage.flush();
  }

  close() {
    this.proxy.close();
  }

  async applyPolicy(previous: WebPolicy) {
    const current = this.policy();
    if (!current.aiBrowser || !current.enabled)
      for (const tab of [...this.tabs.values()]) if (tab.owner) this.closeTab(tab);
    if (!current.enabled || previous.persistentSiteData !== current.persistentSiteData) {
      ++this.privacyEpoch;
      for (const tab of [...this.tabs.values()]) if (!tab.owner) this.closeTab(tab);
    }
    if (previous.persistentSiteData && !current.persistentSiteData)
      await session.fromPartition('persist:aria-web-personal').clearData();
    if (!current.history) this.disk.history = [];
    if (!current.restoreTabs) {
      this.disk.tabs = [];
      this.disk.selected = -1;
    }
    await this.storage.save(this.disk);
    this.changed();
  }

  pruneConversations(conversations: { id: string }[]) {
    const ids = new Set(conversations.map(({ id }) => id));
    for (const tab of this.tabs.values()) if (tab.owner && !ids.has(tab.owner)) this.closeTab(tab);
  }

  state(): BrowserState {
    const tabs = [...this.tabs.values()].filter(
      (tab) => !tab.owner || tab.owner === this.conversationId,
    );
    return {
      tabs: tabs.map((tab) => ({ ...tab.state })),
      selected: this.selected,
      history: this.policy().history ? this.disk.history : [],
      bookmarks: this.disk.bookmarks,
      permissions: [
        ...new Map(
          [...this.personalProfiles].flatMap((profile) => [...profile.permissions]),
        ).values(),
      ],
      warning: this.storage.warning,
    };
  }

  private changed() {
    if (this.window && !this.window.isDestroyed() && !this.window.webContents.isDestroyed())
      this.window.webContents.send('aria:browser-state-update', this.state());
  }

  setLayout(layout: BrowserLayout) {
    if (this.layoutRevision >= layout.revision) return;
    this.layoutRevision = layout.revision;
    const previous = this.conversationId;
    this.layout = layout;
    this.conversationId = layout.conversationId;
    if (previous !== this.conversationId) {
      this.selected =
        (this.conversationId && this.aiSelected.get(this.conversationId)) || this.personalSelected;
      this.changed();
    }
    this.place();
  }

  private place() {
    const window = this.window;
    if (!window || window.isDestroyed()) {
      this.visible = undefined;
      return;
    }
    const tab = this.selected && this.tabs.get(this.selected);
    const rect = this.layout?.bounds;
    const view =
      tab &&
      !tab.state.crashed &&
      (!tab.owner || tab.owner === this.conversationId) &&
      rect &&
      (tab.state.url || tab.state.loading) &&
      !window.isMinimized()
        ? tab
        : undefined;
    if (this.visible && this.visible !== view)
      window.contentView.removeChildView(this.visible.view);
    if (view && rect) {
      const [width, height] = window.getContentSize();
      const zoom = window.webContents.zoomFactor;
      const x = Math.max(0, Math.min(width, Math.round(rect.x * zoom)));
      const y = Math.max(0, Math.min(height, Math.round(rect.y * zoom)));
      const bounds: Rectangle = {
        x,
        y,
        width: Math.max(0, Math.min(width - x, Math.round(rect.width * zoom))),
        height: Math.max(0, Math.min(height - y, Math.round(rect.height * zoom))),
      };
      if (this.visible !== view) window.contentView.addChildView(view.view);
      view.view.setBounds(bounds);
    }
    this.visible = view;
  }

  private select(tab: Tab) {
    if (tab.owner && tab.owner !== this.conversationId) return;
    this.selected = tab.state.id;
    if (tab.owner) this.aiSelected.set(tab.owner, tab.state.id);
    else {
      this.personalSelected = tab.state.id;
      if (this.conversationId) this.aiSelected.delete(this.conversationId);
    }
    this.place();
    this.changed();
    if (!tab.owner) this.persist();
  }

  private persist() {
    if (this.policy().restoreTabs) {
      const personal = [...this.tabs.values()].filter(
        (tab) => !tab.owner && webUrlSchema.safeParse(tab.state.url).success,
      );
      this.disk.tabs = personal.map((tab) => tab.state.url);
      this.disk.selected = personal.findIndex((tab) => tab.state.id === this.personalSelected);
    }
    void this.storage.save(this.disk).catch(() => this.changed());
  }

  async flush() {
    await this.storage.flush();
  }

  private async profile(owner?: string) {
    const name = owner
      ? `aria-ai-${this.partitionNonce}-${randomUUID()}`
      : this.policy().persistentSiteData
        ? 'persist:aria-web-personal'
        : `aria-web-${this.partitionNonce}`;
    const cached = this.profiles.get(name);
    if (cached) return cached;
    const profile = new BrowserSessionPolicy(
      session.fromPartition(name, { cache: !owner }),
      !!owner,
      () =>
        this.visible && this.window
          ? { contents: this.visible.view.webContents, window: this.window }
          : undefined,
      () => this.changed(),
    );
    const pending = profile.install(this.proxy).then(() => {
      if (!owner) this.personalProfiles.add(profile);
      return profile;
    });
    if (!owner) {
      this.profiles.set(name, pending);
      void pending.catch(() => this.profiles.delete(name));
    }
    return pending;
  }

  private async create(owner?: string) {
    const window = this.window;
    const epoch = this.privacyEpoch;
    if (
      !window ||
      window.isDestroyed() ||
      !this.policy().enabled ||
      (owner && !this.policy().aiBrowser)
    )
      throw new BrowserError('UNAVAILABLE', 'Browser access is disabled in Settings.');
    const count = [...this.tabs.values()].filter((tab) => !!tab.owner === !!owner).length;
    if (count + this.pending >= (owner ? 4 : 12))
      throw new BrowserError('TAB_LIMIT', 'Close a browser tab before opening another.');
    this.pending++;
    let profile: BrowserSessionPolicy;
    try {
      profile = await this.profile(owner);
    } finally {
      this.pending--;
    }
    if (
      window !== this.window ||
      window.isDestroyed() ||
      epoch !== this.privacyEpoch ||
      !this.policy().enabled ||
      (owner && !this.policy().aiBrowser)
    )
      throw new BrowserError('UNAVAILABLE', 'The browser window changed.');
    const view = new WebContentsView({
      webPreferences: {
        session: profile.session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webviewTag: false,
        devTools: false,
        spellcheck: !owner,
      },
    });
    const id = randomUUID();
    const tab: Tab = {
      view,
      owner,
      profile,
      documentId: randomUUID(),
      queue: Promise.resolve(),
      lifetime: new AbortController(),
      state: {
        id,
        profile: owner ? 'ai' : 'personal',
        url: '',
        title: 'New tab',
        loading: false,
        back: false,
        forward: false,
        zoom: 100,
      },
    };
    const wc = view.webContents;
    wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    const check = (event: { url: string; isMainFrame?: boolean; preventDefault: () => void }) => {
      if (webUrlSchema.safeParse(event.url).success) return;
      event.preventDefault();
      if (event.isMainFrame !== false) {
        tab.state.error = 'This destination is blocked by the browser settings.';
        this.changed();
      }
    };
    wc.on('will-frame-navigate', check);
    wc.on('will-redirect', check);
    if (owner) {
      wc.on('before-input-event', (event) => event.preventDefault());
      wc.on('before-mouse-event', (event, input) => {
        if (input.type !== 'mouseWheel') event.preventDefault();
      });
    } else {
      wc.on('context-menu', (_event, details) => {
        if (!this.window || !details.linkURL || !webUrlSchema.safeParse(details.linkURL).success)
          return;
        const url = details.linkURL;
        void dialog
          .showMessageBox(this.window, {
            message: 'Open link in a new tab?',
            detail: url,
            buttons: ['Cancel', 'Open'],
            cancelId: 0,
          })
          .then(({ response }) => {
            if (response === 1 && this.tabs.get(id) === tab)
              return this.command({ kind: 'open', input: url });
          })
          .catch(() => undefined);
      });
    }
    wc.on('did-start-navigation', ({ isMainFrame }) => {
      if (isMainFrame) {
        tab.documentId = randomUUID();
        tab.runId = undefined;
        tab.state.error = undefined;
      }
    });
    const completed = (url: string) => {
      tab.documentId = randomUUID();
      tab.runId = undefined;
      tab.state.url = webUrlSchema.safeParse(url).success ? url : '';
      tab.state.back = wc.navigationHistory.canGoBack();
      tab.state.forward = wc.navigationHistory.canGoForward();
      tab.state.icon = undefined;
      if (!owner && tab.state.url && this.policy().history) {
        const entry = {
          url: tab.state.url,
          title: (wc.getTitle() || url).slice(0, 300),
          at: Date.now(),
        };
        this.disk.history = [
          entry,
          ...this.disk.history.filter(
            (item) => item.url !== entry.url && Date.now() - item.at < 30 * 86400_000,
          ),
        ].slice(0, 1000);
      }
      if (!owner) this.persist();
      this.changed();
    };
    wc.on('did-navigate', (_event, url, status) => {
      if (status >= 400) {
        tab.state.error = `The page returned HTTP ${status}.`;
        this.changed();
      } else completed(url);
    });
    wc.on('did-navigate-in-page', (_event, url, main) => {
      if (main) completed(url);
    });
    wc.on('did-start-loading', () => {
      tab.state.loading = true;
      this.place();
      this.changed();
    });
    wc.on('did-stop-loading', () => {
      tab.state.loading = false;
      this.place();
      this.changed();
    });
    wc.on('page-title-updated', (_event, title) => {
      tab.state.title = title.slice(0, 300) || 'Web page';
      if (!owner && this.disk.history[0]?.url === tab.state.url) {
        this.disk.history[0].title = tab.state.title;
        this.persist();
      }
      this.changed();
    });
    wc.on('page-favicon-updated', (_event, urls) => {
      const documentId = tab.documentId;
      const apply = (icon: string) => {
        if (tab.documentId === documentId && this.tabs.has(id)) {
          tab.state.icon = icon;
          this.changed();
        }
      };
      const inline = urls.find((url) =>
        /^data:image\/png;base64,[A-Za-z0-9+/=]{1,12000}$/.test(url),
      );
      if (inline) {
        apply(inline);
        return;
      }
      if (!owner) {
        const url = urls.find(
          (candidate) =>
            webUrlSchema.safeParse(candidate).success &&
            tab.state.url &&
            new URL(candidate).origin === new URL(tab.state.url).origin,
        );
        if (url)
          void this.favicon(tab, url)
            .then((icon) => {
              if (icon) apply(icon);
            })
            .catch(() => undefined);
      }
    });
    wc.on('did-fail-load', (_event, code, description, _url, main) => {
      if (main && code !== -3) {
        tab.state.error = description.slice(0, 140);
        this.changed();
      }
    });
    wc.on('found-in-page', (_event, result) => {
      if (tab.findId === result.requestId) {
        tab.state.matches = { count: result.matches, index: result.activeMatchOrdinal };
        this.changed();
      }
    });
    wc.on('render-process-gone', () => {
      tab.lifetime.abort();
      tab.state.crashed = true;
      tab.state.loading = false;
      tab.state.error = 'The page stopped responding.';
      tab.runId = undefined;
      this.place();
      if (!wc.isDestroyed()) wc.close({ waitForBeforeUnload: false });
      this.changed();
    });
    wc.on('destroyed', () => {
      if (this.tabs.has(id) && !tab.state.crashed) {
        tab.lifetime.abort();
        tab.state.crashed = true;
        tab.state.loading = false;
        tab.state.error = 'The page closed unexpectedly.';
        this.place();
        this.changed();
      }
    });
    this.tabs.set(id, tab);
    this.changed();
    return tab;
  }

  private async favicon(tab: Tab, url: string) {
    const response = await tab.profile.session.fetch(url, {
      signal: AbortSignal.timeout(3000),
      redirect: 'error',
      credentials: 'omit',
    });
    const reader = response.body?.getReader();
    if (!reader) return;
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      if (
        !response.ok ||
        !/^image\/(png|vnd\.microsoft\.icon|x-icon)/i.test(
          response.headers.get('content-type') || '',
        )
      )
        return;
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        size += result.value.length;
        if (size > 32_768) return;
        chunks.push(result.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    const bytes = Buffer.concat(chunks);
    // Accept only bounded PNG dimensions before passing bytes to the decoder.
    if (
      bytes.length < 24 ||
      !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bytes.readUInt32BE(16) > 128 ||
      bytes.readUInt32BE(20) > 128
    )
      return;
    const image = nativeImage.createFromBuffer(bytes);
    if (!image.isEmpty()) return image.resize({ width: 18, height: 18 }).toDataURL();
  }

  private closeTab(tab: Tab) {
    this.tabs.delete(tab.state.id);
    tab.lifetime.abort();
    if (this.personalSelected === tab.state.id)
      this.personalSelected =
        [...this.tabs.values()].find((candidate) => !candidate.owner)?.state.id ?? null;
    if (tab.owner && this.aiSelected.get(tab.owner) === tab.state.id)
      this.aiSelected.delete(tab.owner);
    if (this.selected === tab.state.id) this.selected = this.personalSelected;
    this.place();
    const contents = tab.view.webContents;
    if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
    if (tab.owner)
      void tab.profile.session
        .closeAllConnections()
        .then(() => tab.profile.session.clearData())
        .catch(() => undefined);
    this.changed();
  }

  private url(input: string) {
    if (/^https?:\/\//i.test(input)) return publicWebUrl(input).href;
    if (/^[\w.-]+\.[a-z]{2,}(?:\/[^\s]*)?$/i.test(input))
      return publicWebUrl(`https://${input}`).href;
    if (/^[\w+.-]+:\/\//.test(input))
      throw new BrowserError('BLOCKED_URL', 'Use a public HTTP or HTTPS address.');
    if (!this.policy().addressSearch)
      throw new BrowserError(
        'SEARCH_DISABLED',
        'Enable address bar search in Settings → Web & Browser.',
      );
    const url = new URL('https://search.brave.com/search');
    url.searchParams.set('q', input);
    return url.href;
  }

  private async navigate(tab: Tab, url: string, signal?: AbortSignal) {
    const contents = tab.view.webContents;
    const destination = publicWebUrl(url);
    signal?.throwIfAborted();
    const stop = () => {
      if (!contents.isDestroyed()) contents.stop();
    };
    signal?.addEventListener('abort', stop, { once: true });
    try {
      const loading = contents.loadURL(destination.href);
      if (signal) await whenActive(loading, signal);
      else await loading;
      if (tab.state.error) throw new BrowserError('NAVIGATION_FAILED', tab.state.error);
    } catch (error) {
      if (!signal?.aborted && !contents.isDestroyed()) {
        tab.state.error ??= 'The page could not be loaded.';
        this.changed();
      }
      throw error;
    } finally {
      signal?.removeEventListener('abort', stop);
    }
  }

  async command(command: BrowserCommand): Promise<string | void> {
    if (command.kind === 'open') {
      const url = command.input ? this.url(command.input) : undefined;
      const tab = await this.create();
      this.select(tab);
      if (url) void this.navigate(tab, url).catch(() => undefined);
      return;
    }
    if (command.kind === 'clear-history') {
      this.disk.history = [];
      this.persist();
      this.changed();
      return;
    }
    if (command.kind === 'clear-site-data' || command.kind === 'revoke-permissions') {
      if (command.kind === 'clear-site-data' && this.window) {
        const decision = await dialog.showMessageBox(this.window, {
          message: 'Clear personal browsing data?',
          detail: 'This closes personal tabs and signs you out of sites in Aria.',
          buttons: ['Cancel', 'Clear site data'],
          cancelId: 0,
        });
        if (decision.response !== 1) return;
      }
      const clearing = command.kind === 'clear-site-data';
      if (clearing) {
        ++this.privacyEpoch;
        for (const tab of this.tabs.values()) if (!tab.owner) this.closeTab(tab);
        this.persist();
      }
      for (const value of this.profiles.values()) {
        const profile = await value;
        profile.permissions.clear();
        if (clearing) await profile.session.clearData();
      }
      if (clearing && !this.profiles.has('persist:aria-web-personal'))
        await session.fromPartition('persist:aria-web-personal').clearData();
      this.changed();
      return;
    }
    if (!('tabId' in command)) return;
    const tab = this.tabs.get(command.tabId);
    if (!tab || (tab.owner && tab.owner !== this.conversationId)) return;
    if (command.kind === 'close') {
      this.closeTab(tab);
      this.persist();
      return;
    }
    if (command.kind === 'select') {
      this.select(tab);
      return;
    }
    if (command.kind === 'share-link') return tab.state.url;
    if (command.kind === 'recover') {
      const url = tab.state.url;
      const owner = tab.owner;
      this.closeTab(tab);
      const next = await this.create(owner);
      this.select(next);
      if (url) void this.navigate(next, url).catch(() => undefined);
      return;
    }
    if (tab.state.crashed || tab.view.webContents.isDestroyed()) return;
    const contents = tab.view.webContents;
    if (command.kind === 'external') return shell.openExternal(publicWebUrl(tab.state.url).href);
    if (command.kind === 'share-selection') {
      const current = tab.documentId;
      const data = await whenActive(
        inspectPage(contents, { op: 'selected', documentId: current }),
        AbortSignal.timeout(3000),
      );
      if (tab.documentId !== current)
        throw new BrowserError('STALE_PAGE', 'The page changed. Select the text again.');
      return data.selected;
    }
    if (tab.owner) return;
    if (command.kind === 'navigate')
      void this.navigate(tab, this.url(command.input)).catch(() => undefined);
    else if (command.kind === 'back' && contents.navigationHistory.canGoBack())
      contents.navigationHistory.goBack();
    else if (command.kind === 'forward' && contents.navigationHistory.canGoForward())
      contents.navigationHistory.goForward();
    else if (command.kind === 'reload' && tab.state.url)
      void this.navigate(tab, tab.state.url).catch(() => undefined);
    else if (command.kind === 'stop') contents.stop();
    else if (command.kind === 'bookmark' && tab.state.url) {
      const match = this.disk.bookmarks.some(({ url }) => url === tab.state.url);
      this.disk.bookmarks = match
        ? this.disk.bookmarks.filter(({ url }) => url !== tab.state.url)
        : [
            { url: tab.state.url, title: tab.state.title, at: Date.now() },
            ...this.disk.bookmarks,
          ].slice(0, 500);
      this.persist();
      this.changed();
    } else if (command.kind === 'zoom') {
      const zoom = command.delta
        ? Math.max(50, Math.min(200, tab.state.zoom + command.delta * 10))
        : 100;
      contents.setZoomFactor(zoom / 100);
      tab.state.zoom = zoom;
      this.changed();
    } else if (command.kind === 'find') {
      if (!command.query) {
        contents.stopFindInPage('clearSelection');
        tab.findQuery = undefined;
        tab.state.matches = undefined;
        this.changed();
      } else {
        tab.findId = contents.findInPage(command.query, {
          forward: command.forward,
          findNext: tab.findQuery === command.query,
        });
        tab.findQuery = command.query;
      }
    }
  }

  async execute(request: BrowserRequest, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.policy().enabled || !this.policy().aiBrowser)
      throw new BrowserError('UNAVAILABLE', 'AI browsing is disabled in Settings.');
    const args = browserToolArgs[request.op].parse(request.args) as {
      tabId?: string;
      documentId?: string;
      url?: string;
      elementId?: string;
      delta?: number;
      query?: string;
      selection?: boolean;
      value?: string;
      fields?: { elementId: string; value: string }[];
    };
    const output = (data: Record<string, unknown>, tab?: Tab, screenshot?: Buffer) => {
      const text = JSON.stringify(data);
      if (text.length > 12_000)
        throw new BrowserError('RESULT_LIMIT', 'Try inspecting less of the page.');
      return {
        ok: true as const,
        text,
        url: tab?.state.url || undefined,
        title: tab?.state.title,
        screenshot: screenshot && new Uint8Array(screenshot),
      };
    };
    const owner = request.conversationId;
    if (request.op === 'browser_get_tabs')
      return output({
        tabs: [...this.tabs.values()]
          .filter((tab) => tab.owner === owner)
          .map((tab) => ({ tabId: tab.state.id, url: tab.state.url, title: tab.state.title })),
      });
    if (request.op === 'browser_open') {
      if (!args.url) throw new BrowserError('INVALID_URL', 'Use a validated public URL.');
      const tab = await this.create(owner);
      if (signal.aborted) {
        this.closeTab(tab);
        signal.throwIfAborted();
      }
      this.select(tab);
      try {
        await this.navigate(tab, args.url, AbortSignal.any([signal, AbortSignal.timeout(20_000)]));
      } catch (error) {
        this.closeTab(tab);
        throw error;
      }
      return output({ tabId: tab.state.id, url: tab.state.url }, tab);
    }
    const tab = args.tabId && this.tabs.get(args.tabId);
    if (!tab || tab.owner !== owner || tab.state.crashed)
      throw new BrowserError('TAB_UNAVAILABLE', 'The tab is unavailable in this conversation.');
    const active = AbortSignal.any([signal, tab.lifetime.signal]);
    const work = tab.queue.then(async () => {
      active.throwIfAborted();
      const contents = tab.view.webContents;
      if (request.op === 'browser_switch_tab') {
        this.select(tab);
        return output({ tabId: tab.state.id });
      }
      if (request.op === 'browser_navigate') {
        if (!args.url) throw new BrowserError('INVALID_URL', 'Use a validated public URL.');
        await this.navigate(tab, args.url, AbortSignal.any([active, AbortSignal.timeout(20_000)]));
        return output({ tabId: tab.state.id, url: tab.state.url }, tab);
      }
      const documentId = tab.documentId;
      const snapshot = () => {
        if (
          tab.documentId !== documentId ||
          contents.isDestroyed() ||
          contents.isLoadingMainFrame()
        )
          throw new BrowserError('STALE_PAGE', 'Inspect the current page again.');
      };
      const inspect = async (command: Parameters<typeof inspectPage>[1], timeout = active) => {
        timeout.throwIfAborted();
        snapshot();
        const result = await whenActive(inspectPage(contents, command), timeout);
        snapshot();
        if (result.error)
          throw new BrowserError(
            result.error,
            result.error === 'STALE_ELEMENT'
              ? 'Inspect the current page again.'
              : 'Complete this action yourself in a Personal tab.',
          );
        return result;
      };
      const timed = () => AbortSignal.any([active, AbortSignal.timeout(20_000)]);
      if (request.op === 'browser_get_page') {
        const value = await inspect({ op: 'inspect', documentId }, timed());
        tab.runId = request.requestId;
        const elements = [];
        let capacity = 9000;
        for (const element of value.elements ?? []) {
          const link =
            element.href && webUrlSchema.safeParse(element.href).success ? element.href : undefined;
          const candidate = { ...element, href: link };
          capacity -= JSON.stringify(candidate).length + 80;
          if (capacity < 0) break;
          elements.push(candidate);
        }
        return output(
          { tabId: tab.state.id, documentId, url: tab.state.url, title: tab.state.title, elements },
          tab,
        );
      }
      if (args.documentId !== documentId || tab.runId !== request.requestId)
        throw new BrowserError('STALE_PAGE', 'Inspect the current page again.');
      const action = { documentId, elementId: args.elementId };
      if (request.op === 'browser_extract' || request.op === 'browser_scroll') {
        const data = await inspect(
          {
            ...action,
            op: request.op === 'browser_extract' ? 'extract' : 'scroll',
            delta: args.delta,
            query: args.query,
            selection: args.selection,
          },
          timed(),
        );
        return output({ tabId: tab.state.id, documentId, ...data }, tab);
      }
      if (request.op === 'browser_screenshot') {
        const check = await inspect({ op: 'screenshot', documentId }, timed());
        if (check.sensitive)
          throw new BrowserError(
            'PRIVATE_PAGE',
            'Screenshot capture is unavailable on pages with editable fields.',
          );
        const image = await whenActive(
          contents.capturePage(undefined, { stayHidden: true }),
          timed(),
        );
        snapshot();
        const size = image.getSize();
        const side = Math.max(size.width, size.height);
        const scaled =
          side > 1024
            ? image.resize(size.width >= size.height ? { width: 1024 } : { height: 1024 })
            : image;
        const bytes = scaled.toPNG();
        if (!bytes.length || bytes.length > 1024 * 1024)
          throw new BrowserError(
            'RESULT_LIMIT',
            'The screenshot could not be captured within its size limit.',
          );
        return output({ tabId: tab.state.id, documentId, captured: true }, tab, bytes);
      }
      if (request.op === 'browser_submit') {
        const plan = await inspect({ ...action, op: 'plan', fields: args.fields }, timed());
        if (!plan.action || !plan.body)
          throw new BrowserError('MANUAL_ACTION_REQUIRED', 'Complete this form in a Personal tab.');
        const fields = new URLSearchParams(plan.body);
        const fingerprint = JSON.stringify([plan.action, plan.body]);
        const digest = createHash('sha256').update(fingerprint).digest('hex');
        if (tab.submissions?.requestId !== request.requestId)
          tab.submissions = { requestId: request.requestId, fingerprints: new Set() };
        if (tab.submissions.fingerprints.has(digest))
          throw new BrowserError(
            'ALREADY_SUBMITTED',
            'The form was already dispatched. Check the website for its outcome.',
          );
        await this.approve(
          tab,
          'Submit form',
          plan.action,
          [...fields].map(([key, value]) => `${key}: ${value}`).join('\n'),
          active,
        );
        snapshot();
        const permit = {
          contentsId: contents.id,
          url: plan.action,
          body: plan.body,
          consumed: false,
        };
        active.throwIfAborted();
        tab.profile.permit = permit;
        try {
          const submitted = await whenActive(
            inspectPage(contents, { ...action, op: 'submit', fields: args.fields, fingerprint }),
            timed(),
          ).catch((error) => {
            if (!permit.consumed) throw error;
            return { error: undefined };
          });
          if (submitted.error)
            throw new BrowserError(submitted.error, 'The form changed. Inspect it again.');
          if (!permit.consumed) {
            await whenActive(
              new Promise<void>((resolve) => {
                const start = Date.now();
                const timer = setInterval(() => {
                  if (active.aborted || permit.consumed || Date.now() - start >= 1200) {
                    clearInterval(timer);
                    resolve();
                  }
                }, 30);
              }),
              active,
            );
          }
          if (!permit.consumed)
            throw new BrowserError('NOT_SUBMITTED', 'The verified form did not send a request.');
          return output({ tabId: tab.state.id, status: 'dispatched_outcome_unverified' }, tab);
        } finally {
          if (permit.consumed) tab.submissions.fingerprints.add(digest);
          tab.profile.permit = undefined;
        }
      }
      const observed = await inspect({ ...action, op: 'describe' }, timed());
      if (request.op === 'browser_click' && observed.element?.href) {
        await this.navigate(tab, observed.element.href, timed());
        return output({ tabId: tab.state.id, url: tab.state.url }, tab);
      }
      if (request.op === 'browser_type' && !observed.element?.editable)
        throw new BrowserError(
          'MANUAL_ACTION_REQUIRED',
          'Complete this field yourself in a Personal tab.',
        );
      await this.approve(
        tab,
        request.op === 'browser_type' ? 'Fill field' : 'Click control',
        tab.state.url,
        `${observed.element?.label || observed.element?.tag || 'Page control'}${args.value === undefined ? '' : `\nValue: ${args.value}`}`,
        active,
      );
      await inspect(
        {
          ...action,
          op: request.op === 'browser_type' ? 'type' : 'click',
          value: args.value,
          fingerprint: observed.fingerprint,
        },
        timed(),
      );
      return output({ tabId: tab.state.id, documentId, status: 'action_dispatched' }, tab);
    });
    tab.queue = work.catch(() => undefined);
    return whenActive(work, active);
  }

  private async approve(
    tab: Tab,
    action: string,
    destination: string,
    detail: string,
    signal: AbortSignal,
  ) {
    if (
      !this.window ||
      this.window.isDestroyed() ||
      this.conversationId !== tab.owner ||
      this.selected !== tab.state.id
    )
      throw new BrowserError(
        'APPROVAL_UNAVAILABLE',
        'Bring this conversation and AI tab to the foreground.',
      );
    const documentId = tab.documentId;
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
    const decision = await whenActive(
      dialog.showMessageBox(this.window, {
        message: action,
        detail: `${destination}\n\n${detail}`.slice(0, 8000),
        type: 'question',
        buttons: ['Deny', 'Approve once'],
        cancelId: 0,
        defaultId: 0,
        signal: deadline,
      }),
      deadline,
    );
    deadline.throwIfAborted();
    if (decision.response !== 1)
      throw new BrowserError('APPROVAL_DENIED', 'The user did not approve this action.');
    if (
      this.conversationId !== tab.owner ||
      this.selected !== tab.state.id ||
      tab.documentId !== documentId
    )
      throw new BrowserError('STALE_PAGE', 'The tab changed while approval was pending.');
  }
}
