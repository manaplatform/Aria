import { randomUUID } from 'node:crypto';
import { ZipWriter, Uint8ArrayReader, Uint8ArrayWriter } from '@zip.js/zip.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { MessageChannelMain } from 'electron';
import { z } from 'zod';
import {
  builtinSourceSkill,
  capabilityHostRequest,
  capabilityId,
  executionLimits,
  openAIRuntimeFeatureSchema,
  type OpenAIRuntimeFeature,
  type RuntimeResult,
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
import { RuntimeError } from './runtime/store';
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
  disabledExamples: z.array(capabilityId).max(8).optional(),
  nativeRuntimeProofs: z
    .partialRecord(openAIRuntimeFeatureSchema, z.string().regex(/^[a-f0-9]{64}$/))
    .optional(),
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
  private examples: Awaited<ReturnType<typeof inspectBundle>>[] = [];

  private exampleSummaries(): SkillSummary[] {
    return this.examples.map(({ manifest }) => ({
      ...manifest.summary,
      provenance: 'builtin',
      enabled: !this.data.disabledExamples?.includes(manifest.summary.id),
    }));
  }

  constructor(directory: string) {
    this.file = path.join(directory, 'capabilities-v1.json');
    this.root = path.join(directory, 'approved-skills');
    this.journal = path.join(directory, 'tool-dispatch');
  }

  async load() {
    const bundled = path.join(__dirname, '../skills');
    const examples = await Promise.allSettled(
      ['spreadsheet-summary', 'chart-generation', 'pdf-report', 'pdf-inspection'].map((name) =>
        inspectBundle(path.join(bundled, name), 'directory'),
      ),
    );
    this.examples = examples.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
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
      ...(proof &&
        this.data.nativeRuntimeProofs && {
          nativeRuntime: Object.entries(this.data.nativeRuntimeProofs)
            .filter(([, verified]) => proof === verified)
            .map(([feature]) => openAIRuntimeFeatureSchema.parse(feature)),
        }),
      skills: [
        { ...builtinSourceSkill, enabled: this.data.builtinEnabled },
        ...this.exampleSummaries(),
        ...active.map((skill) => skill.summary),
      ],
    };
  }

  skills(): SkillSummary[] {
    return [
      { ...builtinSourceSkill, enabled: this.data.builtinEnabled },
      ...this.exampleSummaries(),
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

  verifyNativeRuntime(feature: OpenAIRuntimeFeature, proof?: string) {
    const proofs = { ...this.data.nativeRuntimeProofs };
    if (proof) proofs[feature] = proof;
    else delete proofs[feature];
    return this.save({ nativeRuntimeProofs: proofs });
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
    if (
      this.examples.some(
        ({ manifest }) =>
          manifest.summary.id === ref.id && manifest.summary.version === ref.version,
      )
    ) {
      if (action === 'remove') throw new Error('Disable the built-in skill from Settings.');
      const disabled = new Set(this.data.disabledExamples ?? []);
      if (action === 'disable') disabled.add(ref.id);
      else disabled.delete(ref.id);
      return this.save({ disabledExamples: [...disabled] });
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

  private findExample(ref: SkillRef) {
    return this.data.disabledExamples?.includes(ref.id)
      ? undefined
      : this.examples.find(
          ({ manifest }) =>
            manifest.summary.id === ref.id && manifest.summary.version === ref.version,
        );
  }

  async read(ref: SkillRef, resourceId: string | undefined, offset: number, signal: AbortSignal) {
    const example = this.findExample(ref);
    const current =
      example?.manifest ??
      this.data.skills.find(
        (item) =>
          item.summary.id === ref.id &&
          item.summary.version === ref.version &&
          item.summary.enabled,
      );
    const entry = current?.entries.find((item) =>
      resourceId ? item.readable && item.id === resourceId : item.id === current.instructions,
    );
    if (!current || !entry || (!resourceId && offset)) return;
    const filename = path.join(this.root, current.digest, entry.id);
    if (
      !example &&
      (await fs.realpath(filename)) !==
        path.join(await fs.realpath(this.root), current.digest, entry.id)
    )
      return;
    const bytes = example?.entries.get(entry.id) ?? (await readSkillFile(filename));
    signal.throwIfAborted();
    if (hash(bytes) !== entry.digest) return;
    const content = decodeSkillText(bytes);
    if (offset > content.length) return;
    let end = Math.min(content.length, offset + 12_000);
    if (/[\uD800-\uDBFF]/u.test(content.charAt(end - 1))) end--;
    return {
      text: content.slice(offset, end),
      ...(!resourceId && {
        scripts: current.entries
          .filter((item) => /^scripts\/[^/]+\.(py|sh)$/u.test(item.name))
          .map(({ id, name }) => ({ id, name })),
        resources: current.entries
          .filter((item) => item.readable)
          .map(({ id, name }) => ({ id, name })),
      }),
      ...(end < content.length && { nextOffset: end }),
    };
  }

  async executionScript(ref: SkillRef, id: string, signal: AbortSignal) {
    const example = this.findExample(ref);
    const current =
      example?.manifest ??
      this.data.skills.find(
        (item) =>
          item.summary.id === ref.id &&
          item.summary.version === ref.version &&
          item.summary.enabled,
      );
    const entry = current?.entries.find((item) => item.id === id);
    const extension = /^scripts\/[^/]+\.(py|sh)$/u.exec(entry?.name ?? '')?.[1];
    if (!current || !entry || !extension) return;
    const filename = path.join(this.root, current.digest, entry.id);
    if (
      !example &&
      (await fs.realpath(filename)) !==
        path.join(await fs.realpath(this.root), current.digest, entry.id)
    )
      return;
    const bytes = example?.entries.get(entry.id) ?? (await readSkillFile(filename));
    signal.throwIfAborted();
    if (hash(bytes) !== entry.digest) return;
    return { ...entry, bytes, extension };
  }

  async hostedBundle(ref: SkillRef, signal: AbortSignal) {
    const example = this.findExample(ref);
    const manifest =
      example?.manifest ??
      this.data.skills.find(
        (item) =>
          item.summary.id === ref.id &&
          item.summary.version === ref.version &&
          item.summary.enabled,
      );
    if (!manifest) return;
    const entries = manifest.entries.filter((entry) => entry.id !== manifest.instructions);
    if (entries.reduce((size, entry) => size + entry.bytes, 0) > 1_000_000)
      throw new Error('This skill is too large to mount inline.');
    const root = example ? undefined : await fs.realpath(this.root);
    const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
    for (const entry of entries) {
      signal.throwIfAborted();
      const filename = path.join(this.root, manifest.digest, entry.id);
      if (!example && (await fs.realpath(filename)) !== path.join(root!, manifest.digest, entry.id))
        return;
      const bytes = example?.entries.get(entry.id) ?? (await readSkillFile(filename));
      if (hash(bytes) !== entry.digest) return;
      await writer.add(
        `${manifest.summary.name}/${entry.name}`,
        new Uint8ArrayReader(new Uint8Array(bytes)),
      );
    }
    const data = Buffer.from(await writer.close()).toString('base64');
    signal.throwIfAborted();
    return {
      type: 'inline' as const,
      name: manifest.summary.name,
      description: manifest.summary.description,
      source: { type: 'base64' as const, media_type: 'application/zip' as const, data },
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
  runtime?: (
    request: Extract<CapabilityHostRequest, { type: 'runtime' }>,
    signal: AbortSignal,
  ) => Promise<RuntimeResult>,
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
    const signal = AbortSignal.any([
      parent,
      controller.signal,
      AbortSignal.timeout(request.type === 'runtime' ? executionLimits.operationMs : 5000),
    ]);
    const execute = async (): Promise<CapabilityHostReply> => {
      const { id } = request;
      if (request.type === 'runtime') {
        if (
          !runtime ||
          request.voiceSessionId ||
          storage.policy().disabled.includes(request.operation)
        )
          return { id, ok: false, code: 'PERMISSION_DENIED' };
        if (Buffer.byteLength(JSON.stringify(request.input)) > 48_000)
          return { id, ok: false, code: 'INVALID_ARGUMENT' };
        const result = await runtime(request, signal);
        return { id, ok: true, runtime: result };
      }
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
        (error: unknown) => {
          if (signal.aborted) return;
          send(
            error instanceof RuntimeError
              ? {
                  id: request.id,
                  ok: false,
                  code: error.code,
                  message: error.message.slice(0, 400),
                }
              : {
                  id: request.id,
                  ok: false,
                  code: 'EXECUTION_FAILED',
                  message:
                    'The desktop could not complete this operation. Check input availability and runtime settings.',
                },
          );
        },
      )
      .finally(() => active.delete(request.id));
  });
  port1.start();
  return { port: port2, close };
}
