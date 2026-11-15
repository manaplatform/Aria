import { once } from 'node:events';
import net from 'node:net';
import { expect, it } from 'vitest';
import { BrowserProxy } from '../electron/browser/egress-proxy';

it('handles ECONNRESET on the client side after CONNECT takes the socket from the HTTP server', async () => {
  const proxy = new BrowserProxy();
  const port = await proxy.start();
  const upgraded = once(proxy['server'], 'connect');
  const client = net.createConnection(port, '127.0.0.1');
  client.on('error', () => client.destroy());
  try {
    await once(client, 'connect');
    client.write('CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
    const [, socket] = (await upgraded) as [unknown, net.Socket];
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    expect(() =>
      socket.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })),
    ).not.toThrow();
    await closed;
  } finally {
    client.destroy();
    proxy.close();
  }
});
