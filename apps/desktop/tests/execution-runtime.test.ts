import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DockerSandbox } from '../electron/runtime/sandbox';
import { RuntimeStore } from '../electron/runtime/store';
import { Knowledge, textPassages } from '../electron/runtime/knowledge';

describe('durable runtime', () => {
  it('migrates a populated v4 runtime and expires approvals on the next startup', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'aria-runtime-migration-'));
    const store = new RuntimeStore(directory);
    try {
      store.db.prepare(
        "INSERT INTO documents VALUES ('document', 'chat', NULL, 'notes.txt', 'version', 'ready')",
      ).run();
      store.db.exec(`
        DROP TABLE local_desktop_grant;
        DROP TABLE approval_receipts;
        DROP TABLE provider_checkpoints;
        DROP TABLE dispatch_receipts;
        DROP TABLE dispatch_turns;
        PRAGMA user_version = 4;
      `);
      store.close();
      expect(store.db.prepare('PRAGMA user_version').get()?.user_version).toBe(7);
      expect(store.db.prepare("SELECT name FROM documents WHERE id = 'document'").get())
        .toMatchObject({ name: 'notes.txt' });
      const approval = store.beginApproval({
        conversation: 'chat', request: 'request', step: 'step', operation: 'browser_submit',
      }, 'a'.repeat(64));
      store.close();
      store.finishApproval(approval, 'approved');
      expect(store.db.prepare('SELECT state FROM approval_receipts WHERE id = ?').get(approval))
        .toMatchObject({ state: 'expired' });
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('fences program children by owner and records interrupted reservations as uncertain', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'aria-program-journal-'));
    const store = new RuntimeStore(directory);
    try {
      const id = randomUUID();
      const parent = {
        type: 'runtime' as const, id: randomUUID(), requestId: 'request', conversationId: 'owner',
        assistantMessageId: 'turn', revision: 'revision', stepId: id, callId: id,
        operation: 'program.journal' as const,
        primary: { connectionId: randomUUID(), model: 'fixture', endpoint: 'https://fixture.test/v1' },
      };
      const provider = 'provider';
      store.journalProgram({ ...parent, input: { action: 'open', backend: 'managed', deadline: Date.now() + 5000 } }, provider);
      const reserve = { action: 'reserve', callId: 'child', tool: 'knowledge.search', version: '1', fingerprint: 'a'.repeat(64) };
      store.journalProgram({ ...parent, input: reserve }, provider);
      const child = { ...parent, programId: id, operation: 'knowledge.search' as const, callId: 'child', input: {} };
      expect(() => store.assertProgramChild(child, provider)).not.toThrow();
      expect(() => store.assertProgramChild({ ...child, conversationId: 'other' }, provider)).toThrow('not reserved');
      expect(() => store.journalProgram({ ...parent, input: reserve }, provider)).toThrow('already');
      store.close();
      expect(store.db.prepare('SELECT state FROM program_children WHERE program = ?').get(id)?.state).toBe('uncertain');
      expect(store.db.prepare('SELECT state FROM programs WHERE id = ?').get(id)?.state).toBe('uncertain');
      expect(() => store.assertProgramChild(child, provider)).toThrow('not reserved');
      store.deletePrograms('owner');
      expect(store.db.prepare('SELECT * FROM program_children').all()).toEqual([]);
      const finished = { ...parent, stepId: randomUUID(), requestId: 'next' };
      store.journalProgram({ ...finished, input: { action: 'open', backend: 'managed', deadline: Date.now() + 5000 } }, provider);
      expect(store.journalProgram({
        ...finished,
        input: { action: 'finish', state: 'complete', result: '{"data":"synthetic"}' },
      }, provider, Buffer.from('sealed fixture'))).toBe(true);
      store.close();
      expect(store.programResult('owner', finished.stepId)?.toString()).toBe('sealed fixture');
      expect(store.programResult('other', finished.stepId)).toBeUndefined();
      store.db.prepare('UPDATE program_results SET expires = 0').run();
      expect(store.programResult('owner', finished.stepId)).toBeUndefined();
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
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
      expect(() => store.begin(scope, null, ['revised command'])).toThrow('earlier outcome');
      expect(() => store.begin({ ...scope, assistantMessageId: 'new-turn' }, null, ['revised command'])).not.toThrow();
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
  it('exchanges bounded Computer Use messages with a separate offline Python process', async () => {
    const sandbox = new DockerSandbox(docker!);
    const signal = AbortSignal.timeout(20000);
    const requests: unknown[] = [];
    const script = [
      'import json, os, sys',
      'assert "lo" in os.listdir("/sys/class/net")',
      'with open("/proc/net/route") as routes: assert len(routes.readlines()) == 1',
      'assert not os.path.exists("/var/run/docker.sock")',
      'print(json.dumps({"request": "observe"}), flush=True)',
      'value = json.loads(sys.stdin.readline())',
      'print(json.dumps({"result": value["title"]}), flush=True)',
    ].join('\n');
    const result = await sandbox.computerScript(
      'aria-computer-test',
      script,
      async (item) => {
        requests.push(item);
        return { title: 'Verified broker round trip' };
      },
      signal,
    );
    expect(requests).toEqual([{ request: 'observe' }]);
    expect(result).toBe('Verified broker round trip');
  }, 25000);

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
