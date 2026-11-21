import { lookup } from 'node:dns/promises';
import http from 'node:http';
import net from 'node:net';
import { publicWebUrl, resolvePublicAddress } from '@aria/shared';

export class BrowserProxy {
  private readonly sockets = new Set<net.Socket>();
  private readonly server = http.createServer(
    { maxHeaderSize: 16_384, headersTimeout: 10_000 },
    (req, res) => {
      req.on('error', () => res.destroy());
      res.on('error', () => req.destroy());
      void this.forward(req, res).catch(() => {
        if (!res.destroyed && !res.headersSent)
          res.writeHead(403).end('Destination not available.');
        else res.destroy();
      });
    },
  );
  private starting?: Promise<number>;
  constructor() {
    this.server.maxConnections = 128;
    this.server.requestTimeout = 30_000;
    this.server.on('clientError', (_error, socket) => socket.destroy());
    this.server.on('connection', (socket) => {
      // CONNECT detaches Node's HTTP listeners. Keep the socket covered during DNS and tunneling.
      socket.on('error', () => socket.destroy());
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
    });
    this.server.on('connect', (request, client, head) => {
      void this.tunnel(request.url ?? '', client as net.Socket, head).catch(() => {
        if (!client.destroyed) client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      });
    });
  }

  start() {
    this.starting ??= new Promise<number>((resolve, reject) => {
      const failure = (error: Error) => {
        this.starting = undefined;
        reject(error);
      };
      this.server.once('error', failure);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.removeListener('error', failure);
        this.server.unref();
        resolve((this.server.address() as net.AddressInfo).port);
      });
    });
    return this.starting;
  }

  close() {
    for (const socket of this.sockets) socket.destroy();
    this.server.close();
    this.starting = undefined;
  }

  private async tunnel(target: string, client: net.Socket, head: Buffer) {
    if (!/^(?:\[[a-fA-F0-9:]+\]|[a-zA-Z0-9.-]+):443$/.test(target))
      throw new Error('Blocked destination.');
    const url = publicWebUrl(`https://${target}`);
    client.setTimeout(90_000, () => client.destroy());
    const address = await resolvePublicAddress(url.hostname, (host) => lookup(host, { all: true }));
    if (client.destroyed) return;
    const remote = net.connect({ host: address.address, family: address.family, port: 443 });
    const timeout = setTimeout(() => remote.destroy(), 10_000);
    remote.on('error', () => client.destroy());
    client.once('close', () => {
      clearTimeout(timeout);
      remote.destroy();
    });
    remote.once('close', () => {
      clearTimeout(timeout);
      client.destroy();
    });
    remote.once('connect', () => {
      clearTimeout(timeout);
      if (client.destroyed) {
        remote.destroy();
        return;
      }
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) remote.write(head);
      client.pipe(remote);
      remote.pipe(client);
    });
  }

  private async forward(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = publicWebUrl(req.url ?? '');
    if (url.protocol !== 'http:') throw new Error('Blocked destination.');
    const address = await resolvePublicAddress(url.hostname, (host) => lookup(host, { all: true }));
    if (res.destroyed) return;
    const headers = { ...req.headers, host: url.host };
    for (const name of [
      'proxy-authorization',
      'proxy-connection',
      'connection',
      'upgrade',
      'keep-alive',
    ]) {
      delete (headers as http.IncomingHttpHeaders)[name];
    }
    const outgoing = http.request(
      {
        host: address.address,
        family: address.family,
        port: 80,
        path: url.pathname + url.search,
        method: req.method,
        headers,
        agent: false,
        timeout: 20_000,
      },
      (reply) => {
        reply.on('error', () => res.destroy());
        if (res.destroyed) {
          reply.destroy();
          return;
        }
        try {
          res.writeHead(reply.statusCode ?? 502, reply.headers);
          reply.pipe(res);
        } catch {
          reply.destroy();
          res.destroy();
        }
      },
    );
    res.once('close', () => outgoing.destroy());
    outgoing.on('timeout', () => outgoing.destroy());
    outgoing.on('error', () => {
      if (!res.destroyed && !res.headersSent) res.writeHead(502).end();
      else res.destroy();
    });
    req.pipe(outgoing);
  }
}
