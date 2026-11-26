import { createBroker } from './broker.ts';

const port = Number(process.env.PORT ?? 8080);
const counters = new Map<string, { count: number; elapsedMs: number }>();
const monitoring = setInterval(() => {
  if (!counters.size) return;
  process.stdout.write(JSON.stringify({ event: 'oauth_requests', measurements: Object.fromEntries(counters) }) + '\n');
  counters.clear();
}, 60_000);
monitoring.unref();

const server = createBroker({
  origin: process.env.ARIA_CONNECT_ORIGIN ?? '',
  clientId: process.env.GITHUB_CLIENT_ID ?? '',
  clientSecret: process.env.GITHUB_CLIENT_SECRET ?? '',
  observe: (route, status, elapsedMs) => {
    const key = route + '/' + status;
    const entry = counters.get(key) ?? { count: 0, elapsedMs: 0 };
    entry.count++;
    entry.elapsedMs += elapsedMs;
    counters.set(key, entry);
  },
});
server.listen(port, '0.0.0.0');
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close());
