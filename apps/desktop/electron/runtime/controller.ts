import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import {
  evidenceSchema,
  executionLimits,
  runtimeOperations,
  runtimeSettingsSchema,
  workspaceFilename,
  type CapabilityHostRequest,
  type MediaAsset,
  type ExecutionHistoryEntry,
  type RuntimeArgs,
  type RuntimeResult,
  type RuntimeRegistry,
  type RuntimeSettings,
} from '@aria/shared';
import { z } from 'zod';
import type { CapabilityStorage } from '../capability-storage';
import type { MediaStorage } from '../media-storage';
import { downloadVerified } from './downloads';
import { extractDocument } from './extraction';
import { LocalEmbeddings, embeddingRevision } from './embeddings';
import { DocumentLibrary } from './library';
import { Knowledge, type SearchFile } from './knowledge';
import { RemoteEmbeddings } from './remote-embeddings';
import { DockerSandbox, sandboxImage } from './sandbox';
import { digest, RuntimeError, RuntimeStore } from './store';

type RuntimeRequest = Extract<CapabilityHostRequest, { type: 'runtime' }>;
type Grant = (title: string, detail: string, signal: AbortSignal) => Promise<boolean>;

function checked<T>(result: { success: true; data: T } | { success: false }): T {
  if (!result.success) throw new RuntimeError('INVALID_ARGUMENT', 'The runtime input is invalid.');
  return result.data;
}

function renderCommandOutput(bytes: Buffer) {
  const text = stripVTControlCharacters(bytes.toString('utf8'));
  return Array.from(text, (character) => {
    const code = character.charCodeAt(0);
    return code === 9 || code === 10 || (code >= 32 && code !== 127) ? character : '';
  })
    .join('')
    .replace(
      /((?:Bearer |(?:api[_-]?key|token|password)\s*[:=]\s*)["']?)[^'"\s,;]{6,}/gi,
      '$1[redacted]',
    );
}

export class DesktopRuntime {
  readonly store: RuntimeStore;
  readonly knowledge: Knowledge;
  readonly library: DocumentLibrary;
  readonly embeddings: LocalEmbeddings;
  private engine?: DockerSandbox;
  private readonly busy = new Set<string>();
  private readonly grants = new Map<string, Set<string>>();
  private readonly unavailable = new Set<string>();
  private readonly verified = new Set<string>();
  private sweepTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly directory: string,
    private readonly assets: MediaStorage,
    private readonly skills: CapabilityStorage,
    private readonly scopeAssets: (conversation: string) => ReadonlySet<string>,
    private readonly approve: Grant,
    private readonly providerIdentity: () => string | undefined,
    private readonly resolveRegistry: () => Promise<RuntimeRegistry>,
  ) {
    this.store = new RuntimeStore(directory);
    this.knowledge = new Knowledge(this.store, extractDocument);
    this.library = new DocumentLibrary(directory, this.store);
    this.embeddings = new LocalEmbeddings(directory);
  }

  history(): ExecutionHistoryEntry[] {
    return this.store.db
      .prepare(
        'SELECT id, operation, state, started, elapsed, exit_code FROM attempts ORDER BY started DESC LIMIT 50',
      )
      .all()
      .map((row) => ({
        id: String(row.id),
        operation: String(row.operation),
        state: String(row.state),
        started: Number(row.started),
        elapsed: row.elapsed === null ? null : Number(row.elapsed),
        exitCode: row.exit_code === null ? null : Number(row.exit_code),
      }));
  }

  settings() {
    return this.store.settings;
  }

  async configure(value: RuntimeSettings) {
    const next = runtimeSettingsSchema.parse(value);
    const previous = this.store.settings;
    if (
      next.embeddingTarget &&
      JSON.stringify(next.embeddingTarget) !== JSON.stringify(previous.embeddingTarget)
    ) {
      const remote = RemoteEmbeddings.resolve(await this.resolveRegistry(), next.embeddingTarget);
      await remote.embed(['Aria synthetic embedding verification'], AbortSignal.timeout(18000));
    }
    if (previous.engineSocket !== next.engineSocket) await this.sweep(true);
    this.store.settings = next;
    await this.expireArtifacts();
  }

  private sandbox() {
    const { engineSocket } = this.store.settings;
    if (!this.engine || this.engine.endpoint !== engineSocket)
      this.engine = new DockerSandbox(engineSocket);
    return this.engine;
  }

  async inspect(signal: AbortSignal) {
    const engine = this.sandbox();
    const probe = await engine.probe(AbortSignal.any([signal, AbortSignal.timeout(8000)]));
    return {
      backend: 'managed',
      os: probe.os,
      architecture: probe.architecture,
      image: sandboxImage,
      runtime: 'POSIX shell and Python; exact version is verified on session creation',
      network: 'offline',
      commandMs: this.store.settings.commandMs,
    };
  }

  async dispatch(request: RuntimeRequest, signal: AbortSignal): Promise<RuntimeResult> {
    if (request.voiceSessionId)
      throw new RuntimeError('PERMISSION_DENIED', 'Open desktop chat to use the runtime.');
    signal.throwIfAborted();
    if (request.operation === 'artifacts.publish') await this.expireArtifacts();
    switch (request.operation) {
      case 'hosted.resources': {
        const ident = z
          .string()
          .regex(/^\/(containers|files|vector_stores)\/[A-Za-z0-9_-]{4,100}$/);
        const operation = checked(
          z
            .discriminatedUnion('action', [
              z.strictObject({ action: z.literal('pending') }),
              z.strictObject({ action: z.literal('register'), path: ident }),
              z.strictObject({ action: z.literal('deleted'), path: ident }),
            ])
            .safeParse(request.input),
        );
        const provider = this.providerIdentity();
        if (!provider || new URL(request.primary.endpoint).origin !== 'https://api.openai.com')
          throw new RuntimeError(
            'PERMISSION_DENIED',
            'A verified hosted provider scope is required.',
          );
        const db = this.store.db;
        if (operation.action === 'pending') {
          const pending = db
            .prepare(
              'SELECT path FROM hosted_resources WHERE provider = ? AND conversation = ? AND request <> ? ORDER BY created LIMIT 24',
            )
            .all(provider, request.conversationId, request.requestId);
          return { data: { pending: pending.map((row) => String(row.path)) } };
        }
        if (operation.action === 'register')
          db.prepare('INSERT OR IGNORE INTO hosted_resources VALUES (?, ?, ?, ?, ?)').run(
            operation.path,
            provider,
            request.conversationId,
            request.requestId,
            Date.now(),
          );
        else
          db.prepare(
            'DELETE FROM hosted_resources WHERE path = ? AND provider = ? AND conversation = ?',
          ).run(operation.path, provider, request.conversationId);
        return {};
      }
      case 'knowledge.record_native': {
        const input = checked(
          evidenceSchema.omit({ id: true }).array().max(6).safeParse(request.input.evidence),
        );
        const verified = [];
        for (const item of input) {
          const file = await this.getScoped(request.conversationId, item.fileId);
          if (
            item.provenance !== 'openai' ||
            item.version !== digest(file.bytes) ||
            item.name !== file.asset.name
          )
            throw new RuntimeError(
              'PERMISSION_DENIED',
              'An OpenAI citation does not match its approved file version.',
            );
          const id = randomUUID();
          const document = `${request.conversationId}/${item.fileId}`;
          const db = this.store.db;
          db.prepare("INSERT OR IGNORE INTO documents VALUES (?, ?, NULL, ?, ?, 'provider')").run(
            document,
            request.conversationId,
            file.asset.name,
            item.version,
          );
          const evidence = { ...item, id };
          db.prepare('INSERT INTO evidence VALUES (?, ?, ?, ?, ?)').run(
            id,
            request.conversationId,
            document,
            item.version,
            JSON.stringify(evidence),
          );
          verified.push(evidence);
        }
        return { evidence: verified, privateContent: true };
      }
      case 'knowledge.prepare_search': {
        const { fileIds } = checked(runtimeOperations[request.operation].safeParse(request.input));
        return this.approveUpload(
          request,
          fileIds,
          'index these documents with OpenAI File Search',
          signal,
        );
      }
      case 'shell.inspect':
        return { data: await this.inspect(signal) };
      case 'files.read_document': {
        const { fileId, offset } = checked(
          runtimeOperations[request.operation].safeParse(request.input),
        );
        const file = await this.getScoped(request.conversationId, fileId);
        await this.allowContent(request, [file], signal);
        return this.knowledge.read(file, offset ?? 0, signal);
      }
      case 'knowledge.list': {
        const semantic =
          Boolean(this.store.settings.embeddingTarget) || (await this.embeddings.available());
        return {
          data: {
            modes: semantic ? ['keyword', 'phrase', 'semantic', 'hybrid'] : ['keyword', 'phrase'],
            collections: this.library
              .list(true)
              .map(({ id, name, files }) => ({ id, name, files: files.length })),
          },
        };
      }
      case 'knowledge.search':
        return this.search(
          request,
          checked(runtimeOperations[request.operation].safeParse(request.input)),
          signal,
        );
      case 'shell.open': {
        const input = checked(runtimeOperations[request.operation].safeParse(request.input));
        if (input.backend === 'openai-hosted') {
          const destinations = input.allowDomains?.join(', ') || 'Network access disabled';
          const references =
            input.hostedSkills?.map((skill) => `${skill.skill_id}@${skill.version}`) ?? [];
          const inline = input.inlineSkills?.map((skill) => `${skill.id}@${skill.version}`) ?? [];
          const authorization = await this.approveUpload(
            request,
            input.inputs ?? [],
            `open an OpenAI-hosted Shell workspace
Network: ${destinations}
Skills: ${[...references, ...inline].join(', ') || 'none'}`,
            signal,
          );
          const inlineSkills = [];
          for (const ref of input.inlineSkills ?? []) {
            const bundle = await this.skills.hostedBundle(ref, signal);
            if (!bundle)
              throw new RuntimeError(
                'PERMISSION_DENIED',
                'The approved skill version changed or is unavailable.',
              );
            inlineSkills.push(bundle);
          }
          return { ...authorization, data: { ...authorization.data, inlineSkills } };
        }
        if (input.allowDomains?.length || input.hostedSkills?.length || input.inlineSkills?.length)
          throw new RuntimeError(
            'INVALID_ARGUMENT',
            'Hosted skills and domain grants apply only to a hosted workspace.',
          );
        return this.open(request, input, signal);
      }
      case 'shell.run': {
        const input = checked(runtimeOperations[request.operation].safeParse(request.input));
        return this.lock(input.sessionId, () =>
          this.run(
            request,
            input.sessionId,
            input.commands.map((command) => ['/bin/sh', '-c', command]),
            input.timeoutMs,
            signal,
          ),
        );
      }
      case 'shell.fetch': {
        const input = checked(runtimeOperations[request.operation].safeParse(request.input));
        return this.lock(input.sessionId, async () => {
          const engine = this.authorizeSession(request, input.sessionId);
          if (
            !(await this.approve(
              'Download a workspace file?',
              `Download the approved file from ${new URL(input.url).origin} into this conversation's isolated workspace.\n\nURL: ${input.url.slice(0, 500)}\nSHA-256: ${input.sha256}`,
              signal,
            ))
          )
            throw new RuntimeError('PERMISSION_DENIED', 'The workspace download was declined.');
          signal.throwIfAborted();
          const attempt = this.store.begin(request, input.sessionId, [request.operation, input]);
          try {
            const bytes = await downloadVerified(input.url, input.sha256, signal);
            await engine.stage(input.sessionId, 'inputs', input.name, bytes, signal);
            this.store.finish(attempt, 'completed');
            return { data: { path: `/workspace/inputs/${input.name}`, size: bytes.byteLength } };
          } catch (error) {
            this.store.finish(attempt, signal.aborted ? 'uncertain' : 'failed');
            throw error;
          }
        });
      }
      case 'skills.run_script': {
        const input = checked(runtimeOperations[request.operation].safeParse(request.input));
        return this.lock(input.sessionId, async () => {
          const engine = this.authorizeSession(request, input.sessionId);
          const script = await this.skills.executionScript(input.skill, input.scriptId, signal);
          if (!script)
            throw new RuntimeError(
              'PERMISSION_DENIED',
              'The selected script version is unavailable.',
            );
          if (
            !(await this.approve(
              'Run a reviewed skill script?',
              `Skill: ${input.skill.id}\nScript: ${script.name}\nVersion: ${input.skill.version}\nEnvironment: offline Aria workspace`,
              signal,
            ))
          )
            throw new RuntimeError('PERMISSION_DENIED', 'Skill execution was declined.');
          signal.throwIfAborted();
          const name = `${script.digest}.${script.extension}`;
          await this.stage(
            input.sessionId,
            input.scriptId,
            name,
            script.bytes,
            engine,
            signal,
            'skills',
          );
          return this.run(
            request,
            input.sessionId,
            [
              [
                script.extension === 'py' ? 'python3' : '/bin/sh',
                `/workspace/skills/${name}`,
                ...(input.arguments ?? []),
              ],
            ],
            input.timeoutMs,
            signal,
          );
        });
      }
      case 'artifacts.publish': {
        const input = checked(runtimeOperations[request.operation].safeParse(request.input));
        return this.lock(input.sessionId, async () => {
          const engine = this.authorizeSession(request, input.sessionId);
          const bytes = await engine.output(input.sessionId, input.filename, signal);
          const version = digest(bytes);
          const existing = this.store.db
            .prepare(
              `
            SELECT id FROM artifacts WHERE conversation = ? AND request = ? AND session = ?
              AND filename = ? AND version = ? AND state = 'available'
          `,
            )
            .get(
              request.conversationId,
              request.requestId,
              input.sessionId,
              input.filename,
              version,
            );
          if (existing) {
            const { asset } = await this.assets.get(String(existing.id));
            return { artifact: { ...asset, storage: 'desktop' } };
          }
          const counts = this.store.db
            .prepare(
              `
            SELECT
              COALESCE(SUM(CASE WHEN request = ? THEN 1 ELSE 0 END), 0) AS per_turn,
              COALESCE(SUM(size), 0) AS total
            FROM artifacts WHERE state = 'available'
          `,
            )
            .get(request.requestId);
          if (Number(counts?.per_turn) >= 4 || Number(counts?.total) + bytes.length > 512_000_000)
            throw new RuntimeError(
              'BUDGET_EXCEEDED',
              'The generated file limit was reached. Remove earlier files or publish fewer outputs.',
            );
          const extension = path.extname(input.filename).toLowerCase();
          const textual = /\.(txt|md|csv|tsv|json|html|py|js|ts|sh|css|xml|yaml|yml|sql)$/i.test(
            extension,
          );
          if (extension === '.json')
            JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
          const asset = await this.assets.put(
            bytes,
            input.filename,
            textual ? 'text/plain' : undefined,
          );
          try {
            if (['.pdf', '.xlsx', '.docx', '.pptx'].includes(extension)) {
              await extractDocument(asset, bytes, signal).catch((error: unknown) => {
                if (!(
                  extension === '.pdf' &&
                  error instanceof RuntimeError &&
                  error.message.includes('requires OCR')
                ))
                  throw error;
              });
            }
            signal.throwIfAborted();
            this.recordArtifact(
              asset,
              bytes,
              request.conversationId,
              request.requestId,
              request.stepId,
              input.sessionId,
              'managed',
            );
            return { artifact: { ...asset, storage: 'desktop' } };
          } catch (error) {
            await this.assets.remove(asset.id);
            throw error;
          }
        });
      }
    }
    throw new RuntimeError(
      'CAPABILITY_UNAVAILABLE',
      'The operation requires a different desktop runtime driver.',
    );
  }

  private async getScoped(conversation: string, id: string) {
    if (
      !this.scopeAssets(conversation).has(id) &&
      !this.store.db
        .prepare(
          "SELECT 1 FROM artifacts WHERE id = ? AND conversation = ? AND state = 'available'",
        )
        .get(id, conversation)
    )
      throw new RuntimeError(
        'PERMISSION_DENIED',
        'This file does not belong to the authorized conversation.',
      );
    return this.assets.get(id);
  }

  private async approveUpload(
    request: RuntimeRequest,
    ids: string[],
    action: string,
    signal: AbortSignal,
  ) {
    const files = await Promise.all(
      [...new Set(ids)].map((id) => this.getScoped(request.conversationId, id)),
    );
    if (
      !(await this.approve(
        'Authorize an OpenAI-hosted operation?',
        `Allow Aria to ${action}. OpenAI receives the full contents of these files.

${
  files
    .map(({ asset }) => asset.name)
    .join('\n')
    .slice(0, 900) || 'No input files selected.'
}`,
        signal,
      ))
    )
      throw new RuntimeError('PERMISSION_DENIED', 'The OpenAI-hosted operation was declined.');
    signal.throwIfAborted();
    const attempt = this.store.begin(request, null, [request.operation, request.input]);
    this.store.finish(attempt, 'authorized');
    return {
      data: {
        versions: Object.fromEntries(files.map(({ asset, bytes }) => [asset.id, digest(bytes)])),
      },
      privateContent: files.length > 0,
    };
  }

  private async allowContent(request: RuntimeRequest, files: SearchFile[], signal: AbortSignal) {
    const fingerprint = digest(
      JSON.stringify([
        request.primary,
        files.map(({ asset, bytes }) => [asset.id, digest(bytes)]).sort(),
      ]),
    );
    const grants = this.grants.get(request.requestId) ?? new Set<string>();
    if (!grants.has(fingerprint)) {
      if (
        !(await this.approve(
          'Share document content with the configured model?',
          `Allow excerpts or command results derived from the selected files in this turn and its active workspace to ${new URL(request.primary.endpoint).origin}.\n\n${files
            .map(({ asset }) => asset.name)
            .join('\n')
            .slice(0, 900)}`,
          signal,
        ))
      )
        throw new RuntimeError(
          'PERMISSION_DENIED',
          'Sharing document content with the model was declined.',
        );
      signal.throwIfAborted();
      this.grants.set(request.requestId, grants.add(fingerprint));
    }
  }

  release(requestId: string) {
    this.grants.delete(requestId);
  }

  private async search(
    request: RuntimeRequest,
    input: RuntimeArgs<'knowledge.search'>,
    signal: AbortSignal,
  ) {
    const semantic = input.mode === 'semantic' || input.mode === 'hybrid';
    const target = this.store.settings.embeddingTarget;
    const remote =
      semantic && target
        ? RemoteEmbeddings.resolve(await this.resolveRegistry(), target)
        : undefined;
    if (semantic && !remote && !(await this.embeddings.available()))
      throw new RuntimeError(
        'CAPABILITY_UNAVAILABLE',
        'Select a verified embedding backend for semantic and hybrid search.',
      );
    const files: (SearchFile & { collection?: string })[] = [];
    if (input.collectionIds?.length) {
      const authorized = new Map(
        this.library.list(true).map((collection) => [collection.id, collection]),
      );
      for (const id of new Set(input.collectionIds)) {
        const collection = authorized.get(id);
        if (!collection)
          throw new RuntimeError(
            'PERMISSION_DENIED',
            'A selected knowledge collection is unavailable.',
          );
        for (const file of collection.files) {
          if (input.fileIds && !input.fileIds.includes(file.id)) continue;
          if (files.length >= 16)
            throw new RuntimeError(
              'BUDGET_EXCEEDED',
              'Select up to sixteen files for a single library search.',
            );
          files.push({ ...(await this.library.get(id, file.id)), collection: id });
        }
      }
    } else {
      const fileIds = [
        ...new Set(input.fileIds ?? [...this.scopeAssets(request.conversationId)].slice(-8)),
      ];
      for (const id of fileIds) {
        const file = await this.getScoped(request.conversationId, id);
        if (
          file.asset.mimeType === 'text/plain' ||
          (file.asset.mimeType.startsWith('application/') &&
            file.asset.mimeType !== 'application/zip')
        )
          files.push(file);
      }
    }
    if (files.reduce((size, file) => size + file.bytes.length, 0) > 80_000_000)
      throw new RuntimeError('BUDGET_EXCEEDED', 'Choose a smaller document scope for this search.');
    if (files.length) await this.allowContent(request, files, signal);
    const indexStarted = Date.now();
    const indexed: string[] = [];
    const problems: string[] = [];
    for (const file of files) {
      signal.throwIfAborted();
      try {
        indexed.push(
          await this.knowledge.index(
            file,
            file.collection
              ? { collection: file.collection }
              : { conversation: request.conversationId },
            signal,
          ),
        );
      } catch (error) {
        signal.throwIfAborted();
        problems.push(
          `${file.asset.name}: ${error instanceof RuntimeError ? error.message : 'Extraction failed.'}`,
        );
      }
    }
    const indexMs = Date.now() - indexStarted;
    if (remote && indexed.length) {
      if (
        !(await this.approve(
          'Send passages to the configured embedding provider?',
          `Allow Aria to send the search query and passages from these documents to ${remote.origin} to build vectors.

${files
  .map(({ asset }) => asset.name)
  .join(' • ')
  .slice(0, 900)}`,
          signal,
        ))
      )
        throw new RuntimeError('PERMISSION_DENIED', 'The embedding transfer was declined.');
      signal.throwIfAborted();
    }
    const retrievalStart = Date.now();
    const dense = semantic
      ? await this.knowledge.semantic(
          indexed,
          input.query,
          remote?.revision ?? embeddingRevision,
          (texts, deadline) =>
            remote ? remote.embed(texts, deadline) : this.embeddings.embed(texts, deadline),
          signal,
        )
      : undefined;
    const evidence = this.knowledge.find(request.conversationId, indexed, input, dense);
    return {
      evidence,
      privateContent: files.length > 0,
      data: {
        searched: indexed.length,
        results: evidence.length,
        problems,
        indexMs,
        retrievalMs: Date.now() - retrievalStart,
      },
    };
  }

  private async open(
    request: RuntimeRequest,
    input: RuntimeArgs<'shell.open'>,
    signal: AbortSignal,
  ) {
    const engine = this.sandbox();
    await engine.probe(AbortSignal.any([signal, AbortSignal.timeout(8000)]));
    await this.sweep();
    const db = this.store.db;
    const files: SearchFile[] = [];
    for (const id of new Set(input.inputs ?? []))
      files.push(await this.getScoped(request.conversationId, id));
    if (files.length) await this.allowContent(request, files, signal);
    const identity = this.providerIdentity();
    const binding = identity ? digest(`${identity}/${request.revision}`) : null;
    let id = String(
      db
        .prepare(
          "SELECT id FROM sessions WHERE conversation = ? AND engine = ? AND provider = ? AND state = 'active' ORDER BY touched DESC LIMIT 1",
        )
        .get(request.conversationId, engine.endpoint, binding)?.id ?? '',
    );
    if (id && !(await engine.owns(id, engine.profile(this.directory), signal))) {
      await this.retire(id, engine);
      id = '';
    }
    let environment: Record<string, unknown> | undefined;
    if (!id) {
      if (
        Number(
          db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE state = 'active'").get()?.count,
        ) >= executionLimits.workspaces
      )
        throw new RuntimeError('BUDGET_EXCEEDED', 'All runtime workspaces are in use.');
      id = randomUUID();
      db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, 'active')").run(
        id,
        request.conversationId,
        engine.endpoint,
        binding,
        Date.now(),
        Date.now(),
      );
      try {
        environment = await engine.create(id, engine.profile(this.directory), signal);
      } catch (error) {
        await this.retire(id, engine);
        throw error;
      }
      this.sweepTimer ??= setInterval(() => {
        void this.sweep().catch(() => undefined);
      }, 60_000);
      this.sweepTimer.unref();
    }
    this.verified.add(id);
    const workspaceId = id;
    return this.lock(id, async () => {
      this.authorizeSession(request, workspaceId);
      const paths: { id: string; path: string }[] = [];
      for (const { asset, bytes } of files) {
        const suffix = path
          .extname(asset.name)
          .slice(0, 12)
          .replace(/[^a-zA-Z.0-9]/g, '');
        const simple = asset.name.replace(/[^\p{L}\p{N}_. -]/gu, '_').slice(0, 100);
        const name = workspaceFilename.safeParse(simple).success
          ? `${asset.id}-${simple}`
          : `${asset.id}${suffix}`;
        await this.stage(workspaceId, asset.id, name, bytes, engine, signal);
        paths.push({ id: asset.id, path: `/workspace/inputs/${name}` });
      }
      return {
        data: {
          sessionId: workspaceId,
          backend: input.backend,
          ...environment,
          inputs: paths,
          workingDirectory: '/workspace/working',
          outputDirectory: '/workspace/outputs',
        },
        privateContent: files.length > 0,
      };
    });
  }

  private async stage(
    id: string,
    file: string,
    name: string,
    bytes: Buffer,
    engine: DockerSandbox,
    signal: AbortSignal,
    area: 'inputs' | 'skills' = 'inputs',
  ) {
    const version = digest(bytes);
    const old = this.store.db
      .prepare('SELECT version FROM staged_inputs WHERE session = ? AND asset = ?')
      .get(id, file);
    if (old?.version === version) return;
    if (old)
      throw new RuntimeError(
        'PERMISSION_DENIED',
        'The version of the staged file changed. Start a fresh workspace.',
      );
    try {
      await engine.stage(id, area, name, bytes, signal);
      signal.throwIfAborted();
      this.store.db
        .prepare('INSERT INTO staged_inputs VALUES (?, ?, ?, ?, ?)')
        .run(id, file, name, version, area);
    } catch (error) {
      await this.retire(id, engine);
      throw error;
    }
  }

  private authorizeSession(request: RuntimeRequest, id: string) {
    const engine = this.sandbox();
    const identity = this.providerIdentity();
    const binding = identity ? digest(`${identity}/${request.revision}`) : null;
    const found = this.store.db
      .prepare(
        "SELECT 1 FROM sessions WHERE id = ? AND conversation = ? AND engine = ? AND provider = ? AND state = 'active' AND touched > ?",
      )
      .get(
        id,
        request.conversationId,
        engine.endpoint,
        binding,
        Date.now() - executionLimits.idleMs,
      );
    if (!found || this.unavailable.has(id) || !this.verified.has(id))
      throw new RuntimeError(
        'CAPABILITY_UNAVAILABLE',
        'This authorized workspace expired or is unavailable. Prepare a fresh workspace.',
      );
    const scoped = this.scopeAssets(request.conversationId);
    const staged = this.store.db
      .prepare("SELECT asset FROM staged_inputs WHERE session = ? AND area = 'inputs'")
      .all(id);
    const artifactScope = this.store.db.prepare(
      'SELECT state FROM artifacts WHERE id = ? AND conversation = ?',
    );
    if (
      staged.some((file) => {
        const record = artifactScope.get(file.asset, request.conversationId);
        return record ? record.state !== 'available' : !scoped.has(String(file.asset));
      })
    )
      throw new RuntimeError(
        'PERMISSION_DENIED',
        'An input was removed from this workspace scope.',
      );
    this.store.db.prepare('UPDATE sessions SET touched = ? WHERE id = ?').run(Date.now(), id);
    return engine;
  }

  private async lock<T>(id: string, operation: () => Promise<T>) {
    if (this.busy.has(id))
      throw new RuntimeError(
        'CAPABILITY_UNAVAILABLE',
        'The workspace is busy with another operation.',
      );
    this.busy.add(id);
    try {
      return await operation();
    } finally {
      this.busy.delete(id);
    }
  }

  private async run(
    request: RuntimeRequest,
    id: string,
    commands: string[][],
    requestedMs: number | undefined,
    signal: AbortSignal,
  ) {
    const engine = this.authorizeSession(request, id);
    const maxMs = Math.min(requestedMs ?? 30_000, this.store.settings.commandMs);
    const started = Date.now();
    const results: Record<string, unknown>[] = [];
    let exit: number | null = null;
    let problem: RuntimeResult['commandProblem'];
    // Each command is journaled separately so a changed batch cannot replay an earlier side effect.
    for (const command of commands) {
      const remaining = maxMs - (Date.now() - started);
      if (remaining <= 0) break;
      const attempt = this.store.begin(request, id, [id, command]);
      const start = Date.now();
      try {
        const result = await engine.run(id, command, signal, remaining);
        exit = result.code;
        const outcome = result.timedOut
          ? 'timeout'
          : result.aborted
            ? 'cancelled'
            : exit === null
              ? 'uncertain'
              : 'exit';
        this.store.finish(
          attempt,
          outcome === 'exit' ? (exit === 0 ? 'completed' : 'failed') : outcome,
          exit ?? undefined,
        );
        if (result.recycled) await this.retire(id, engine);
        results.push({
          attemptId: attempt,
          outcome,
          exitCode: exit,
          durationMs: Date.now() - start,
          stdout: renderCommandOutput(result.stdout),
          stderr: renderCommandOutput(result.stderr),
          truncated: result.truncated,
          workspaceAvailable: !result.recycled,
        });
        if (outcome !== 'exit' || exit !== 0) {
          problem =
            outcome === 'timeout'
              ? {
                  code: 'TIMEOUT',
                  message: 'The command timed out. Available partial output was captured.',
                }
              : outcome === 'cancelled'
                ? { code: 'CANCELLED', message: 'The command was cancelled.' }
                : outcome === 'uncertain'
                  ? {
                      code: 'OUTCOME_UNCERTAIN',
                      message: 'The runtime could not verify the command outcome.',
                    }
                  : {
                      code: 'EXECUTION_FAILED',
                      message: `The command exited with status ${exit}.`,
                    };
          break;
        }
      } catch (error) {
        this.store.finish(attempt, 'uncertain');
        await this.retire(id, engine);
        throw error;
      }
    }
    return {
      data: {
        sessionId: id,
        results,
        completedCommands: results.length,
        requestedCommands: commands.length,
      },
      privateContent: true,
      ...(problem && { commandProblem: problem }),
    };
  }

  private async retire(id: string, engine: DockerSandbox) {
    this.unavailable.add(id);
    this.verified.delete(id);
    const removed = await engine.remove(id);
    this.store.db
      .prepare('UPDATE sessions SET state = ? WHERE id = ?')
      .run(removed ? 'expired' : 'cleanup', id);
    this.unavailable.delete(id);
  }

  private async sweep(all = false) {
    const engine = this.sandbox();
    const idle = all ? Date.now() + 1 : Date.now() - executionLimits.idleMs;
    const rows = this.store.db
      .prepare(
        `
      SELECT id FROM sessions WHERE engine = ? AND
        (state = 'cleanup' OR (state = 'active' AND (touched < ? OR created < ?)))
    `,
      )
      .all(engine.endpoint, idle, Date.now() - 40 * 60_000);
    for (const row of rows) {
      const id = String(row.id);
      if (!this.busy.has(id) && !this.unavailable.has(id)) await this.retire(id, engine);
    }
  }

  private recordArtifact(
    asset: MediaAsset,
    bytes: Buffer,
    conversation: string,
    request: string,
    step: string,
    session: string,
    provenance: 'managed' | 'openai-shell' | 'computer',
  ) {
    this.store.db
      .prepare('INSERT INTO artifacts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        asset.id,
        conversation,
        request,
        step,
        session,
        asset.name,
        asset.mimeType,
        asset.size,
        digest(bytes),
        Date.now(),
        'available',
        provenance,
      );
  }

  async computerInput(conversation: string, assetId: string) {
    return this.getScoped(conversation, assetId);
  }

  computerScript(
    script: string,
    operation: (request: unknown, signal: AbortSignal) => Promise<unknown>,
    signal: AbortSignal,
  ) {
    const engine = this.sandbox();
    return engine.computerScript(engine.profile(this.directory), script, operation, signal);
  }

  async adoptComputerArtifact(
    request: RuntimeRequest,
    sessionId: string,
    name: string,
    bytes: Buffer,
    source: string,
    signal: AbortSignal,
  ) {
    const extension = path.extname(name).toLowerCase();
    const text = ['.txt', '.csv', '.md', '.json', '.tsv'].includes(extension);
    if (!text && !['.png', '.jpeg', '.jpg', '.pdf', '.docx', '.xlsx', '.pptx'].includes(extension))
      throw new RuntimeError(
        'INVALID_ARGUMENT',
        'Choose a supported text, image, PDF, or Office artifact format.',
      );
    const asset = await this.assets.put(bytes, name, text ? 'text/plain' : undefined);
    try {
      const expectedImage =
        extension === '.png'
          ? 'image/png'
          : ['.jpeg', '.jpg'].includes(extension)
            ? 'image/jpeg'
            : undefined;
      if (expectedImage && expectedImage !== asset.mimeType)
        throw new RuntimeError(
          'INVALID_ARGUMENT',
          'The downloaded file does not match its expected format.',
        );
      if (
        asset.mimeType === 'application/pdf' ||
        asset.mimeType.startsWith('application/vnd.openxmlformats')
      )
        await extractDocument(asset, bytes, signal).catch((error: unknown) => {
          if (!(
            asset.mimeType === 'application/pdf' &&
            error instanceof RuntimeError &&
            error.message.includes('requires OCR')
          ))
            throw error;
        });
      signal.throwIfAborted();
      this.store.transaction(() => {
        this.recordArtifact(
          asset,
          bytes,
          request.conversationId,
          request.requestId,
          request.stepId,
          sessionId,
          'computer',
        );
        this.store.db
          .prepare('INSERT INTO computer_artifact_sources VALUES (?, ?)')
          .run(asset.id, source);
      });
      return { ...asset, storage: 'desktop' as const };
    } catch (error) {
      await this.assets.remove(asset.id);
      throw error;
    }
  }

  async adoptHostedArtifact(
    asset: MediaAsset,
    conversation: string,
    request: string,
    execution: { stepId: string; sessionId: string },
    signal: AbortSignal,
  ) {
    try {
      const { bytes } = await this.assets.get(asset.id);
      if (
        asset.mimeType === 'application/pdf' ||
        asset.mimeType.startsWith('application/vnd.openxmlformats')
      )
        await extractDocument(asset, bytes, signal).catch((error: unknown) => {
          if (!(
            asset.mimeType === 'application/pdf' &&
            error instanceof RuntimeError &&
            error.message.includes('requires OCR')
          ))
            throw error;
        });
      signal.throwIfAborted();
      this.recordArtifact(
        asset,
        bytes,
        conversation,
        request,
        execution.stepId,
        execution.sessionId,
        'openai-shell',
      );
    } catch (error) {
      await this.assets.remove(asset.id);
      throw error;
    }
  }

  async preview(conversation: string, id: string) {
    const file = await this.getScoped(conversation, id);
    return (await this.knowledge.read(file, 0, AbortSignal.timeout(18000))).text;
  }

  async removeArtifact(conversation: string, id: string) {
    const db = this.store.db;
    const removed = db
      .prepare(
        "UPDATE artifacts SET state = 'deleted' WHERE conversation = ? AND id = ? AND state = 'available'",
      )
      .run(conversation, id);
    if (!removed.changes) throw new Error('This generated file is unavailable.');
    db.prepare('DELETE FROM documents WHERE id = ?').run(`${conversation}/${id}`);
    await this.assets.remove(id);
  }

  async resolveArtifact(id: string, conversation: string, request: string): Promise<MediaAsset> {
    await this.expireArtifacts();
    const row = this.store.db
      .prepare(
        "SELECT version FROM artifacts WHERE id = ? AND conversation = ? AND request = ? AND state = 'available'",
      )
      .get(id, conversation, request);
    if (!row) throw new Error('The generated file is unavailable to this turn.');
    const { asset, bytes } = await this.assets.get(id);
    if (digest(bytes) !== row.version)
      throw new Error('The generated file failed its integrity check.');
    return asset;
  }

  evidence(id: string, conversation: string) {
    const row = this.store.db
      .prepare(
        `
      SELECT e.payload FROM evidence e JOIN documents d ON d.id = e.document AND d.version = e.version
      WHERE e.id = ? AND e.conversation = ?
    `,
      )
      .get(id, conversation);
    if (!row) throw new Error('This source passage is unavailable.');
    const evidence = evidenceSchema.parse(JSON.parse(String(row.payload)));
    if (
      evidence.collectionId
        ? !this.library
            .list(true)
            .some(
              (item) =>
                item.id === evidence.collectionId &&
                item.files.some((file) => file.id === evidence.fileId),
            )
        : !this.scopeAssets(conversation).has(evidence.fileId)
    )
      throw new Error('This source is no longer attached to the conversation.');
    return evidence;
  }

  private async expireArtifacts() {
    const days = this.store.settings.artifactRetentionDays;
    if (!days) return;
    const db = this.store.db;
    const expired = db
      .prepare(
        "SELECT id, conversation FROM artifacts WHERE state = 'available' AND created < ? LIMIT 50",
      )
      .all(Date.now() - days * 86_400_000);
    for (const row of expired) {
      db.prepare("UPDATE artifacts SET state = 'expired' WHERE id = ?").run(row.id);
      db.prepare('DELETE FROM documents WHERE id = ?').run(`${row.conversation}/${row.id}`);
      await this.assets.remove(String(row.id)).catch(() => undefined);
    }
  }

  async close() {
    this.embeddings.close();
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      await this.sweep(true);
    }
    this.store.close();
  }
}
