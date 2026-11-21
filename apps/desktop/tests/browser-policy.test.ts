import { expect, it, vi } from 'vitest';
import type { OnBeforeRequestListenerDetails, Session, WebContents } from 'electron';
import { BrowserSessionPolicy } from '../electron/browser/session-policy';
import type { BrowserProxy } from '../electron/browser/egress-proxy';

vi.mock('electron', () => ({ dialog: { showMessageBox: vi.fn() } }));

it('blocks private destinations, strips AI credentials, and consumes only the exact approved form request', async () => {
  const requestHook = vi.fn();
  const headersHook = vi.fn();
  const permissionHook = vi.fn();
  const hook = vi.fn();
  const session = {
    setProxy: vi.fn(),
    closeAllConnections: vi.fn(),
    webRequest: {
      onBeforeRequest: requestHook,
      onBeforeSendHeaders: headersHook,
      onHeadersReceived: hook,
    },
    setDevicePermissionHandler: hook,
    setDisplayMediaRequestHandler: hook,
    setPermissionCheckHandler: hook,
    setPermissionRequestHandler: permissionHook,
    on: hook,
  } as unknown as Session;
  const policy = new BrowserSessionPolicy(
    session,
    true,
    () => undefined,
    () => undefined,
  );
  await policy.install({ start: async () => 4000 } as BrowserProxy);
  expect(session.setProxy).toHaveBeenCalledWith(
    expect.objectContaining({
      mode: 'fixed_servers',
      proxyBypassRules: '<-loopback>',
    }),
  );
  const allow = (request: Partial<OnBeforeRequestListenerDetails>) => {
    const callback = vi.fn();
    requestHook.mock.calls[0][0](request, callback);
    return callback.mock.calls[0][0].cancel === false;
  };
  const form: Partial<OnBeforeRequestListenerDetails> = {
    url: 'https://example.com/submit',
    method: 'POST',
    webContentsId: 5,
    resourceType: 'mainFrame',
    uploadData: [{ bytes: Buffer.from('title=Allowed') }],
  };
  expect(allow({ url: 'http://127.0.0.1/', method: 'GET' })).toBe(false);
  expect(allow({ url: 'wss://example.com/submit', method: 'GET' })).toBe(false);
  expect(allow(form)).toBe(false);
  const permit = { contentsId: 5, url: form.url!, body: 'title=Allowed', consumed: false };
  policy.permit = permit;
  expect(allow({ ...form, webContentsId: 6 })).toBe(false);
  expect(allow({ ...form, resourceType: 'xhr' })).toBe(false);
  expect(allow({ ...form, uploadData: [{ bytes: Buffer.from('title=Changed') }] })).toBe(false);
  expect(permit.consumed).toBe(false);
  expect(allow(form)).toBe(true);
  expect(permit.consumed).toBe(true);
  expect(allow(form)).toBe(false);

  const headers = vi.fn();
  headersHook.mock.calls[0][0](
    {
      requestHeaders: { Cookie: 'secret', AUTHORIZATION: 'secret', Accept: 'text/html' },
    },
    headers,
  );
  expect(headers).toHaveBeenCalledWith({ requestHeaders: { Accept: 'text/html' } });
  const permission = vi.fn();
  permissionHook.mock.calls[0][0]({} as WebContents, 'geolocation', permission, {
    isMainFrame: true,
  });
  expect(permission).toHaveBeenCalledWith(false);
});
