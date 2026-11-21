import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { MessageChannelMain } from 'electron';
import { z } from 'zod';
import {
  builtinSourceSkill,
  capabilityHostRequest,
  capabilityId,
  toolDiscoverySchema,
  type CapabilityHostReply,
  type CapabilityHostRequest,
  type SkillRef,
  type SkillSummary,
  type ToolDiscovery,
  type ToolPolicy,
} from '@aria/shared';
import {
  decodeSkillText,
  hash,
  inspectBundle,
  installedSkillSchema,
  readSkillFile,
} from './skill-bundles';
import { writeBrowserJson } from './web-settings-storage';

const settingsSchema = z.strictObject({
  revision: z.string().uuid(),
  discovery: toolDiscoverySchema,
  proof: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  disabled: z.array(capabilityId).max(1024),
  builtinEnabled: z.boolean(),
  skills: z.array(installedSkillSchema).max(127),
});

export class CapabilityStorage {
  private readonly file: string;
  private readonly root: string;
  private readonly journal: string;
  private data: z.infer<typeof settingsSchema> = {
    revision: randomUUID(),
    discovery: 'aria',
    disabled: [],
    builtinEnabled: true,
    skills: [],
  };
  private staged?: {
    token: string;
    expires: number;
    preview: Awaited<ReturnType<typeof inspectBundle>>;
  };
  private queue = Promise.resolve();

  constructor(directory: string) {
    this.file = path.join(directory, 'capabilities-v1.json');
    this.root = path.join(directory, 'approved-skills');
    this.journal = path.join(directory, 'tool-dispatch');
  }

  async load() {
    try {
      this.data = settingsSchema.parse(
        JSON.parse((await readSkillFile(this.file, 16 * 1024 * 1024)).toString('utf8')),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        await fs.copyFile(this.file, `${this.file}.recovery-${Date.now()}`).catch(() => undefined);
        this.data = { ...this.data, builtinEnabled: false };
      }
    }
  }

  policy(proof?: string): ToolPolicy {
    const active = this.data.skills.filter((item) => item.summary.enabled);
    return {
      revision: this.data.revision,
      discovery: this.data.discovery,
      disabled: this.data.disabled,
      nativeVerified: Boolean(proof && this.data.proof === proof),
      skills: [
        { ...builtinSourceSkill, enabled: this.data.builtinEnabled },
        ...active.map((skill) => skill.summary),
      ],
    };
  }

  skills(): SkillSummary[] {
    return [
      { ...builtinSourceSkill, enabled: this.data.builtinEnabled },
      ...this.data.skills.map((item) => item.summary),
    ];
  }

  private async save(update: Partial<typeof this.data>) {
    const next = settingsSchema.parse({ ...this.data, ...update, revision: randomUUID() });
    await writeBrowserJson(this.file, next);
    this.data = next;
  }

  setEnabled(id: string, enabled: boolean) {
    const disabled = new Set(this.data.disabled);
    if (enabled) disabled.delete(id);
    else disabled.add(id);
    return this.save({ disabled: [...disabled] });
  }

  setDiscovery(discovery: ToolDiscovery, proof?: string) {
    return this.save({ discovery, proof: discovery === 'openai-responses' ? proof : undefined });
  }

  async preview(source: string, kind: 'directory' | 'zip') {
    this.staged = undefined;
    const preview = await inspectBundle(source, kind);
    const token = randomUUID();
    this.staged = { token, preview, expires: Date.now() + 180_000 };
    setTimeout(() => {
      if (this.staged?.token === token) this.staged = undefined;
    }, 180_000).unref();
    return {
      token,
      skill: preview.manifest.summary,
      instructions: decodeSkillText(preview.entries.get(preview.manifest.instructions)!),
      resources: preview.manifest.entries.filter((item) => item.readable).map((item) => item.name),
    };
  }

  async approve(token: string) {
    const staged = this.staged;
    this.staged = undefined;
    if (!staged || staged.token !== token || staged.expires <= Date.now())
      throw new Error('This skill preview expired. Select the bundle again.');
    const { manifest, entries } = staged.preview;
    const existing = this.data.skills.find((item) => item.digest === manifest.digest);
    if (existing) return this.manage(existing.summary, 'enable');
    if (this.data.skills.length >= 127)
      throw new Error('Remove a skill before installing another.');
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const destination = path.join(this.root, manifest.digest);
    const pending = await fs.mkdtemp(path.join(this.root, 'pending-'));
    try {
      for (const [id, contents] of entries) {
        await fs.writeFile(path.join(pending, id), contents, { flag: 'wx', mode: 0o600 });
      }
      // The digest can already exist if Aria stopped after the rename and before saving settings.
      await fs.rm(destination, { recursive: true, force: true });
      await fs.rename(pending, destination);
      const skills = this.activate(manifest.summary, this.data.skills);
      await this.save({ skills: [...skills, manifest] });
    } finally {
      await fs.rm(pending, { recursive: true, force: true });
    }
  }

  private activate(ref: SkillRef, skills: typeof this.data.skills) {
    return skills.map((item) =>
      item.summary.id === ref.id
        ? { ...item, summary: { ...item.summary, enabled: item.summary.version === ref.version } }
        : item,
    );
  }

  async manage(ref: SkillRef, action: 'enable' | 'disable' | 'remove') {
    if (ref.id === builtinSourceSkill.id && ref.version === builtinSourceSkill.version) {
      if (action === 'remove') throw new Error('Disable the built-in skill from Settings.');
      return this.save({ builtinEnabled: action === 'enable' });
    }
    const current = this.data.skills.find(
      (item) => item.summary.id === ref.id && item.summary.version === ref.version,
    );
    if (!current) throw new Error('This installed skill version is unavailable.');
    const skills =
      action === 'enable'
        ? this.activate(ref, this.data.skills)
        : action === 'remove'
          ? this.data.skills.filter((item) => item !== current)
          : this.data.skills.map((item) =>
              item === current ? { ...item, summary: { ...item.summary, enabled: false } } : item,
            );
    await this.save({ skills });
    if (action === 'remove')
      await fs.rm(path.join(this.root, current.digest), { recursive: true, force: true });
  }

  async read(ref: SkillRef, resourceId: string | undefined, offset: number, signal: AbortSignal) {
    const current = this.data.skills.find(
      (item) =>
        item.summary.id === ref.id && item.summary.version === ref.version && item.summary.enabled,
    );
    const entry = current?.entries.find((item) =>
      resourceId ? item.readable && item.id === resourceId : item.id === current.instructions,
    );
    if (!current || !entry || (!resourceId && offset)) return;
    const filename = path.join(this.root, current.digest, entry.id);
    if (
      (await fs.realpath(filename)) !==
      path.join(await fs.realpath(this.root), current.digest, entry.id)
    )
      return;
    const bytes = await readSkillFile(filename);
    signal.throwIfAborted();
    if (hash(bytes) !== entry.digest) return;
    const content = decodeSkillText(bytes);
    if (offset > content.length) return;
    let end = Math.min(content.length, offset + 12_000);
    if (/[\uD800-\uDBFF]/u.test(content.charAt(end - 1))) end--;
    return {
      text: content.slice(offset, end),
      ...(!resourceId && {
        resources: current.entries
          .filter((item) => item.readable)
          .map(({ id, name }) => ({ id, name })),
      }),
      ...(end < content.length && { nextOffset: end }),
    };
  }

  reserve(
    conversationId: string,
    turn: string,
    attempt: string,
    fingerprint: string,
    signal: AbortSignal,
  ) {
    const operation = this.queue.then(async () => {
      signal.throwIfAborted();
      const directory = path.join(this.journal, hash(conversationId), hash(turn));
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const owner = path.join(directory, 'attempt');
      try {
        await writeOnce(owner, hash(attempt));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if ((await fs.readFile(owner, 'utf8')) !== hash(attempt)) return false;
      }
      signal.throwIfAborted();
      try {
        await writeOnce(path.join(directory, hash(fingerprint)), '');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw error;
      }
      signal.throwIfAborted();
      return true;
    });
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}

async function writeOnce(filename: string, content: string) {
  const file = await fs.open(filename, 'wx', 0o600);
  try {
    await file.writeFile(content);
    await file.sync();
  } finally {
    await file.close();
  }
}

export function openCapabilityBridge(
  storage: CapabilityStorage,
  revision: string,
  authorize: (request: CapabilityHostRequest) => AbortSignal | undefined,
) {
  const { port1, port2 } = new MessageChannelMain();
  const active = new Map<string, AbortController>();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    active.forEach((controller) => controller.abort());
    active.clear();
    port1.close();
  };
  port1.on('close', close);
  port1.on('message', ({ data }) => {
    if (closed) return;
    const cancellation = z.strictObject({ cancel: z.string().uuid() }).safeParse(data);
    if (cancellation.success) {
      active.get(cancellation.data.cancel)?.abort();
      return;
    }
    const parsed = capabilityHostRequest.safeParse(data);
    if (!parsed.success || active.has(parsed.data.id)) return;
    const request = parsed.data;
    const send = (reply: CapabilityHostReply) => {
      if (!closed) {
        try {
          port1.postMessage(reply);
        } catch {
          close();
        }
      }
    };
    const parent =
      request.revision === revision && storage.policy().revision === revision
        ? authorize(request)
        : undefined;
    if (!parent || parent.aborted || active.size >= 16) {
      send({ id: request.id, ok: false, code: 'PERMISSION_DENIED' });
      return;
    }
    const controller = new AbortController();
    active.set(request.id, controller);
    const signal = AbortSignal.any([parent, controller.signal, AbortSignal.timeout(5000)]);
    const execute = async (): Promise<CapabilityHostReply> => {
      const { id } = request;
      if (request.type === 'skill') {
        const content = await storage.read(
          request.skill,
          request.resourceId,
          request.offset,
          signal,
        );
        return content ? { id, ok: true, content } : { id, ok: false, code: 'PERMISSION_DENIED' };
      }
      const logicalTurn = request.voiceSessionId
        ? `${request.assistantMessageId}/${request.requestId}`
        : request.assistantMessageId;
      return (await storage.reserve(
        request.conversationId,
        logicalTurn,
        request.requestId,
        request.fingerprint,
        signal,
      ))
        ? { id, ok: true }
        : { id, ok: false, code: 'DUPLICATE_DISPATCH' };
    };
    void execute()
      .then(
        (reply) => {
          if (!signal.aborted) send(reply);
        },
        () => {
          if (!signal.aborted) send({ id: request.id, ok: false, code: 'CAPABILITY_UNAVAILABLE' });
        },
      )
      .finally(() => active.delete(request.id));
  });
  port1.start();
  return { port: port2, close };
}
