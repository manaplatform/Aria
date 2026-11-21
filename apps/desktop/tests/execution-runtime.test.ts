import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DockerSandbox } from '../electron/runtime/sandbox';
import { RuntimeStore } from '../electron/runtime/store';
import { Knowledge, textPassages } from '../electron/runtime/knowledge';

describe('durable runtime', () => {
  it('recovers pending attempts as uncertain and rejects their replay', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'aria-runtime-'));
    const store = new RuntimeStore(directory);
    try {
      const scope = {
        conversationId: 'owned',
        assistantMessageId: 'turn',
        requestId: 'first',
        stepId: randomUUID(),
        callId: 'call',
        operation: 'shell.run',
      };
      const id = store.begin(scope, null, ['stable command']);
      store.close();
      expect(store.db.prepare('SELECT state FROM attempts WHERE id = ?').get(id)?.state).toBe(
        'uncertain',
      );
      expect(() => store.begin({ ...scope, requestId: 'retry' }, null, ['stable command'])).toThrow(
        'earlier outcome',
      );
      expect(() => store.begin(scope, null, ['revised command'])).not.toThrow();
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('indexes an exact phrase incrementally and retires evidence for a replaced version', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'aria-knowledge-'));
    const store = new RuntimeStore(directory);
    let extractions = 0;
    const knowledge = new Knowledge(store, async (_asset, bytes) => {
      extractions++;
      return textPassages(bytes);
    });
    try {
      const id = randomUUID();
      const bytes = Buffer.from('Supply agreement\nEarly termination requires written notice.');
      const file = {
        asset: { id, name: 'contract.txt', mimeType: 'text/plain', size: bytes.length },
        bytes,
      };
      const signal = AbortSignal.timeout(1000);
      const document = await knowledge.index(file, { conversation: 'owned' }, signal);
      expect(await knowledge.index(file, { conversation: 'owned' }, signal)).toBe(document);
      expect(extractions).toBe(1);
      const query = { query: 'written notice', mode: 'phrase' as const };
      expect(knowledge.find('owned', [document], query)[0]).toMatchObject({
        fileId: id,
        name: 'contract.txt',
        location: { kind: 'lines', start: 1, end: 2 },
      });
      expect(knowledge.find('unrelated', [], query)).toEqual([]);
      await knowledge.index(
        { ...file, bytes: Buffer.from('Superseded agreement') },
        { conversation: 'owned' },
        signal,
      );
      expect(knowledge.find('owned', [document], query)).toEqual([]);
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

const docker = process.env.ARIA_TEST_DOCKER_ENDPOINT;
describe.skipIf(!docker)('real Aria sandbox', () => {
  it('reuses a workspace, records actual output, and denies unsafe artifact paths', async () => {
    const sandbox = new DockerSandbox(docker!);
    const id = randomUUID();
    const signal = AbortSignal.timeout(25000);
    try {
      await sandbox.create(id, 'aria-test', signal);
      await sandbox.stage(id, 'inputs', 'sales.csv', Buffer.from('value\n42\n'), signal);
      const result = await sandbox.run(
        id,
        [
          '/bin/sh',
          '-c',
          'cat /workspace/inputs/sales.csv; printf error >&2; test ! -w /workspace/inputs/sales.csv; test ! -e /var/run/docker.sock; ls /sys/class/net; echo result >/workspace/outputs/result.txt',
        ],
        signal,
        4000,
      );
      expect(result.code).toBe(0);
      expect(result.stdout.toString()).toContain('42');
      expect(result.stdout.toString()).toContain('lo');
      expect(result.stdout.toString()).not.toContain('eth0');
      expect(result.stderr.toString()).toBe('error');
      expect((await sandbox.output(id, 'result.txt', signal)).toString()).toBe('result\n');
      const next = await sandbox.run(
        id,
        ['/bin/sh', '-c', 'ln -s /etc/passwd /workspace/outputs/link; exit 19'],
        signal,
        4000,
      );
      expect(next.code).toBe(19);
      await expect(sandbox.output(id, 'link', signal)).rejects.toThrow('regular file');
      await expect(sandbox.output(id, '../working/file', signal)).rejects.toThrow();
    } finally {
      await sandbox.remove(id);
    }
  }, 30_000);

  it('keeps partial output on timeout and destroys the workspace', async () => {
    const sandbox = new DockerSandbox(docker!);
    const id = randomUUID();
    const signal = AbortSignal.timeout(15000);
    try {
      await sandbox.create(id, 'aria-test', signal);
      const result = await sandbox.run(
        id,
        ['/bin/sh', '-c', 'printf started; sleep 100 & wait'],
        signal,
        1200,
      );
      expect(result.timedOut).toBe(true);
      expect(result.stdout.toString()).toContain('started');
      await expect(sandbox.output(id, 'deleted.txt', signal)).rejects.toThrow('regular file');
    } finally {
      await sandbox.remove(id);
    }
  }, 20_000);
});
