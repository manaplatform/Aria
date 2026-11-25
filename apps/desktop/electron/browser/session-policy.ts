import { dialog, type Session, type WebContents, type BrowserWindow } from 'electron';
import { publicWebUrl } from '@aria/shared';
import type { BrowserProxy } from './egress-proxy';

export interface FormPermit {
  contentsId: number;
  url: string;
  body: string;
  consumed: boolean;
}
export class BrowserSessionPolicy {
  readonly permissions = new Map<string, { origin: string; permission: string }>();
  permit?: FormPermit;
  private offline = false;
  private authenticationOrigin?: string;

  constructor(
    readonly session: Session,
    readonly ai: boolean,
    private readonly foreground: () => { contents: WebContents; window: BrowserWindow } | undefined,
    private readonly changed: () => void,
  ) {}

  async install(proxy: BrowserProxy) {
    if (
      typeof this.session.getUserAgent === 'function' &&
      typeof this.session.setUserAgent === 'function'
    ) {
      const cleanAgent = this.session
        .getUserAgent()
        .replace(/\s+(?:Aria|Electron)\/[^\s]+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (cleanAgent) this.session.setUserAgent(cleanAgent);
    }
    const port = await proxy.start();
    await this.session.setProxy({
      mode: 'fixed_servers',
      proxyRules: `http://127.0.0.1:${port}`,
      proxyBypassRules: '<-loopback>',
    });
    await this.session.closeAllConnections();
    this.session.webRequest.onBeforeRequest((details, callback) => {
      if (this.authenticationOrigin) {
        try {
          const origin = publicWebUrl(details.url).origin;
          callback({
            cancel:
              origin !== this.authenticationOrigin ||
              !['GET', 'HEAD', 'POST'].includes(details.method),
          });
        } catch {
          callback({ cancel: true });
        }
        return;
      }
      if (this.offline) {
        callback({ cancel: true });
        return;
      }
      try {
        if (details.url === 'about:blank') {
          callback({ cancel: false });
          return;
        }
        const url = publicWebUrl(this.ai ? details.url : details.url.replace(/^wss:/, 'https:'));
        if (!this.ai || ['GET', 'HEAD'].includes(details.method)) {
          callback({ cancel: false });
          return;
        }
        const permit = this.permit;
        const upload = details.uploadData;
        if (
          permit &&
          !permit.consumed &&
          details.webContentsId === permit.contentsId &&
          details.resourceType === 'mainFrame' &&
          details.method === 'POST' &&
          url.href === permit.url &&
          upload?.length === 1 &&
          upload[0].bytes &&
          !upload[0].file &&
          !upload[0].blobUUID &&
          Buffer.from(upload[0].bytes).toString('utf8') === permit.body
        ) {
          permit.consumed = true;
          callback({ cancel: false });
          return;
        }
      } catch {
        /* Block unrecognized schemes and hosts. */
      }
      callback({ cancel: true });
    });
    if (this.ai) {
      this.session.webRequest.onBeforeSendHeaders((details, callback) => {
        const headers = { ...details.requestHeaders };
        for (const key of Object.keys(headers))
          if (
            ['authorization', 'proxy-authorization'].includes(key.toLowerCase()) ||
            (key.toLowerCase() === 'cookie' && !this.authenticationOrigin)
          )
            delete headers[key];
        callback({ requestHeaders: headers });
      });
      this.session.webRequest.onHeadersReceived((details, callback) => {
        const headers = { ...details.responseHeaders };
        for (const key of Object.keys(headers))
          if (key.toLowerCase() === 'set-cookie' && !this.authenticationOrigin) delete headers[key];
        callback({ responseHeaders: headers });
      });
    }
    this.session.setDevicePermissionHandler(() => false);
    this.session.setDisplayMediaRequestHandler((_request, callback) => callback({}));
    this.session.setPermissionCheckHandler((contents, permission, origin, details) => {
      const foreground = this.foreground();
      return (
        !this.ai &&
        !!foreground &&
        contents === foreground.contents &&
        details.isMainFrame &&
        this.permissions.has(this.key(contents, origin, permission))
      );
    });
    this.session.setPermissionRequestHandler((contents, permission, callback, details) => {
      const foreground = this.foreground();
      if (
        this.ai ||
        !foreground ||
        contents !== foreground.contents ||
        !details.isMainFrame ||
        !['geolocation', 'notifications', 'fullscreen'].includes(permission)
      ) {
        callback(false);
        return;
      }
      let origin: string;
      try {
        origin = publicWebUrl(details.requestingUrl).origin;
        if (origin !== publicWebUrl(contents.getURL()).origin || !origin.startsWith('https:')) {
          callback(false);
          return;
        }
      } catch {
        callback(false);
        return;
      }
      const key = this.key(contents, origin, permission);
      if (this.permissions.has(key)) {
        callback(true);
        return;
      }
      void dialog
        .showMessageBox(foreground.window, {
          type: 'question',
          buttons: ['Deny', 'Allow'],
          defaultId: 0,
          cancelId: 0,
          message: `Allow ${permission} on ${origin}?`,
        })
        .then(({ response }) => {
          const allowed =
            response === 1 &&
            !contents.isDestroyed() &&
            this.foreground()?.contents === contents &&
            new URL(contents.getURL()).origin === origin;
          if (allowed) {
            this.permissions.set(key, { origin, permission });
            this.changed();
          }
          return allowed;
        })
        .then(callback, () => callback(false));
    });
    this.session.on('will-download', (event, item, contents) => {
      if (this.ai || this.foreground()?.contents !== contents) {
        event.preventDefault();
        return;
      }
      const name = [...item.getFilename()].filter((char) => char.charCodeAt(0) >= 32).join('');
      const base = name.replace(/[<>:"/\\|?*]/g, '_').slice(0, 150);
      item.setSaveDialogOptions({
        defaultPath: base || 'download',
        title: 'Save website download',
      });
    });
  }

  async quarantine() {
    this.authenticationOrigin = undefined;
    this.offline = true;
    this.permit = undefined;
    await this.session.closeAllConnections();
  }

  authenticate(origin: string) {
    const target = publicWebUrl(origin);
    if (!this.ai || target.protocol !== 'https:')
      throw new Error('Private authentication requires a public HTTPS origin.');
    this.authenticationOrigin = target.origin;
  }

  private key(contents: WebContents, origin: string, permission: string) {
    if (contents.isDestroyed()) return '';
    try {
      if (publicWebUrl(contents.getURL()).origin === origin) return `${origin} ${permission}`;
    } catch {
      /* No public origin. */
    }
    return '';
  }
}
