import { randomUUID } from 'node:crypto';
import { openai } from '@ai-sdk/openai';
import type { ToolSet } from 'ai';
import { z } from 'zod';
import {
  officialOpenAI,
  type DocumentEvidence,
  type OpenAIRuntimeFeature,
  type OpenAISkillBinding,
} from '@aria/shared';
import { readBounded } from './providers.service';
import type { ResolvedModel } from './model-registry.service';
import type { RunAttachment } from '../conductor/run-assets';
import { ToolError } from '../conductor/capability-host';

const resourceId = z.object({
  id: z
    .string()
    .regex(/^[a-z][a-z_]*_[A-Za-z0-9_-]+$/i)
    .max(100),
});
const status = z.object({ status: z.string().max(100) });
const listed = z.object({ data: z.array(resourceId.extend({ path: z.string() })).max(100) });
const results = z.object({
  queries: z.array(z.string().max(500)).max(10),
  results: z
    .array(
      z.object({
        fileId: z.string(),
        score: z.number(),
        text: z.string(),
      }),
    )
    .max(12)
    .nullable(),
});

const nativeFormats = new Map([
  ['.pdf', 'application/pdf'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ...[
    '.txt',
    '.md',
    '.html',
    '.json',
    '.js',
    '.ts',
    '.py',
    '.sh',
    '.css',
    '.java',
    '.go',
    '.rb',
    '.c',
    '.cpp',
  ].map((extension): [string, string] => [extension, 'text/plain']),
]);

export interface ActiveNativeTools {
  shell?: { id: string; kind: 'hosted' | 'local'; container?: string };
  search?: {
    store: string;
    versions: Map<string, { file: RunAttachment; version: string }>;
    scope: string;
  };
}

type HostedJournal = (
  input: { action: 'pending' } | { action: 'register' | 'deleted'; path: string },
  signal: AbortSignal,
) => Promise<Record<string, unknown> | undefined>;

export class OpenAIRuntime {
  readonly active: ActiveNativeTools = {};
  private readonly resources = new Set<string>();
  private readonly connection: ResolvedModel['connection'];

  constructor(
    primary: ResolvedModel,
    private readonly journal?: HostedJournal,
  ) {
    if (primary.connection.baseUrl.replace(/\/$/, '') !== officialOpenAI)
      throw new ToolError(
        'CAPABILITY_UNAVAILABLE',
        'This capability requires an official OpenAI Responses connection.',
      );
    this.connection = primary.connection;
  }

  private async request(
    path: string,
    method: string,
    signal: AbortSignal,
    body?: object | FormData,
  ) {
    const response = await fetch(officialOpenAI + path, {
      method,
      redirect: 'error',
      signal,
      headers: {
        Authorization: `Bearer ${this.connection.apiKey}`,
        ...(body && !(body instanceof FormData) && { 'Content-Type': 'application/json' }),
      },
      ...(body && { body: body instanceof FormData ? body : JSON.stringify(body) }),
    });
    if (method === 'DELETE' && response.status === 404) return response;
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ToolError(
        response.status === 404 ? 'CAPABILITY_UNAVAILABLE' : 'EXECUTION_FAILED',
        response.status === 404
          ? 'The authorized OpenAI resource expired or is unavailable.'
          : `OpenAI rejected the requested operation (HTTP ${response.status}).`,
      );
    }
    return response;
  }

  private async json(path: string, method: string, signal: AbortSignal, body?: object | FormData) {
    return JSON.parse(
      (await readBounded(await this.request(path, method, signal, body), 1_000_000)).toString(
        'utf8',
      ),
    ) as unknown;
  }

  private async create(path: string, body: object | FormData, signal: AbortSignal) {
    const { id } = resourceId.parse(await this.json(path, 'POST', signal, body));
    const resource = `${path}/${id}`;
    this.resources.add(resource);
    await this.journal?.({ action: 'register', path: resource }, signal);
    return id;
  }

  async recover(signal: AbortSignal) {
    const record = await this.journal?.({ action: 'pending' }, signal);
    const pending = z
      .array(z.string().regex(/^\/(containers|files|vector_stores)\/[A-Za-z0-9_-]{4,100}$/))
      .max(24)
      .parse(record?.pending ?? []);
    for (const resource of pending.sort(
      (a, b) => Number(a.startsWith('/files')) - Number(b.startsWith('/files')),
    )) {
      signal.throwIfAborted();
      try {
        const response = await this.request(
          resource,
          'DELETE',
          AbortSignal.any([signal, AbortSignal.timeout(3000)]),
        );
        await response.body?.cancel();
        await this.journal?.({ action: 'deleted', path: resource }, signal);
      } catch {
        signal.throwIfAborted();
      }
    }
  }

  async openHosted(
    files: RunAttachment[],
    allowedDomains: string[],
    skills: { skill_id: string; version: string }[],
    signal: AbortSignal,
    inlineSkills: OpenAISkillBinding[] = [],
  ) {
    if (this.active.shell)
      throw new ToolError('PERMISSION_DENIED', 'This turn already selected a shell backend.');
    const fileIds: string[] = [];
    for (const file of files) fileIds.push(await this.upload(file, 'user_data', signal));
    const container = await this.create(
      '/containers',
      {
        name: 'Aria conversation workspace',
        file_ids: fileIds,
        expires_after: { anchor: 'last_active_at', minutes: 20 },
        memory_limit: '1g',
        network_policy: allowedDomains.length
          ? { type: 'allowlist', allowed_domains: allowedDomains }
          : { type: 'disabled' },
        skills: [
          ...skills.map((skill) => ({ type: 'skill_reference', ...skill })),
          ...inlineSkills,
        ],
      },
      signal,
    );
    const id = randomUUID();
    this.active.shell = { id, kind: 'hosted', container };
    return id;
  }

  openLocal(id: string) {
    if (this.active.shell && (this.active.shell.kind !== 'local' || this.active.shell.id !== id))
      throw new ToolError('PERMISSION_DENIED', 'This turn already selected a shell backend.');
    this.active.shell = { id, kind: 'local' };
  }

  private async upload(
    file: RunAttachment,
    purpose: 'user_data' | 'assistants',
    signal: AbortSignal,
  ) {
    const form = new FormData();
    form.set('purpose', purpose);
    form.set('file', new Blob([new Uint8Array(file.bytes)], { type: file.mimeType }), file.name);
    return this.create('/files', form, signal);
  }

  async prepareSearch(files: { file: RunAttachment; version: string }[], signal: AbortSignal) {
    if (this.active.search)
      throw new ToolError(
        'DUPLICATE_DISPATCH',
        'The turn already has a prepared OpenAI File Search scope.',
      );
    if (!files.length)
      throw new ToolError('INVALID_ARGUMENT', 'Choose authorized attachments to index.');
    for (const { file } of files) {
      const extension = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
      const expected = nativeFormats.get(extension);
      if (!expected || file.mimeType !== expected)
        throw new ToolError(
          'INVALID_ARGUMENT',
          'The selected file format is unavailable in OpenAI File Search. Local document search supports CSV and XLSX.',
        );
    }
    const scope = randomUUID();
    const store = await this.create(
      '/vector_stores',
      {
        name: 'Aria authorized documents',
        expires_after: { anchor: 'last_active_at', days: 1 },
      },
      signal,
    );
    const versions = new Map<string, (typeof files)[number]>();
    for (const item of files) {
      const id = await this.upload(item.file, 'assistants', signal);
      await this.json(`/vector_stores/${store}/files`, 'POST', signal, {
        file_id: id,
        attributes: { aria_scope: scope, aria_version: item.version },
      });
      versions.set(id, item);
    }
    for (const id of versions.keys()) {
      for (;;) {
        signal.throwIfAborted();
        const current = status.parse(
          await this.json(`/vector_stores/${store}/files/${id}`, 'GET', signal),
        ).status;
        if (current === 'completed') break;
        if (current !== 'in_progress')
          throw new ToolError('EXECUTION_FAILED', 'OpenAI could not index the selected documents.');
        await new Promise<void>((resolve) => setTimeout(resolve, 600));
      }
    }
    this.active.search = { store, scope, versions };
  }

  tools(): ToolSet {
    const { search, shell } = this.active;
    return {
      ...(shell && {
        aria_native_shell: openai.tools.shell({
          environment:
            shell.kind === 'hosted'
              ? { type: 'containerReference', containerId: shell.container! }
              : { type: 'local' },
        }),
      }),
      ...(search && {
        aria_native_file_search: openai.tools.fileSearch({
          vectorStoreIds: [search.store],
          maxNumResults: 6,
          filters: {
            type: 'and',
            filters: [
              { type: 'eq', key: 'aria_scope', value: search.scope },
              {
                type: 'in',
                key: 'aria_version',
                value: [...new Set([...search.versions.values()].map(({ version }) => version))],
              },
            ],
          },
        }),
      }),
    };
  }

  evidence(output: unknown): Omit<DocumentEvidence, 'id'>[] {
    const match = results.safeParse(output);
    const authorized = this.active.search?.versions;
    if (!match.success || !authorized) return [];
    const query = match.data.queries.join(' · ').slice(0, 500);
    return (match.data.results ?? [])
      .flatMap((result, index) => {
        const source = authorized.get(result.fileId);
        if (!source) return [];
        return [
          {
            fileId: source.file.id,
            name: source.file.name,
            version: source.version,
            chunkId: `${result.fileId}:${index}`,
            excerpt: result.text.slice(0, 1500),
            score: result.score,
            query,
            provenance: 'openai' as const,
          },
        ];
      })
      .slice(0, 6);
  }

  async artifact(session: string, filename: string, signal: AbortSignal) {
    const shell = this.active.shell;
    if (shell?.kind !== 'hosted' || shell.id !== session)
      throw new ToolError(
        'PERMISSION_DENIED',
        'This hosted workspace is unavailable to the current turn.',
      );
    const root = `/containers/${shell.container}/files`;
    const { data } = listed.parse(await this.json(root + '?limit=100', 'GET', signal));
    const item = data.find(
      (file) =>
        file.path === `/mnt/data/${filename}` || file.path === `/mnt/data/outputs/${filename}`,
    );
    if (!item)
      throw new ToolError(
        'INVALID_ARGUMENT',
        'The requested file does not exist under the hosted artifact directory.',
      );
    const response = await this.request(`${root}/${item.id}/content`, 'GET', signal);
    if (!response.body)
      throw new ToolError('EXECUTION_FAILED', 'OpenAI returned no artifact bytes.');
    const dataParts: Buffer[] = [];
    let size = 0;
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 20_000_000)
          throw new ToolError(
            'BUDGET_EXCEEDED',
            'The hosted output exceeds the artifact size limit.',
          );
        dataParts.push(Buffer.from(value));
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    if (!size) throw new ToolError('EXECUTION_FAILED', 'The hosted file is empty.');
    const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
    const mimeType =
      nativeFormats.get(ext) ??
      (
        {
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.webp': 'image/webp',
          '.csv': 'text/plain',
          '.tsv': 'text/plain',
          '.zip': 'application/zip',
          '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        } as Record<string, string>
      )[ext];
    if (!mimeType)
      throw new ToolError('INVALID_ARGUMENT', 'The hosted output format is unsupported.');
    return { name: filename, mimeType, bytes: Buffer.concat(dataParts, size) };
  }

  async close() {
    const resources = [...this.resources].sort(
      (a, b) => Number(a.startsWith('/files')) - Number(b.startsWith('/files')),
    );
    for (const resource of resources) {
      const response = await this.request(resource, 'DELETE', AbortSignal.timeout(3000)).catch(
        () => undefined,
      );
      await response?.body?.cancel().catch(() => undefined);
      if (response) {
        await this.journal?.(
          { action: 'deleted', path: resource },
          AbortSignal.timeout(1500),
        ).catch(() => undefined);
      }
    }
    this.resources.clear();
  }
}

export function nativeFeatureName(mode: string): OpenAIRuntimeFeature | undefined {
  return mode === 'openai-hosted'
    ? 'hosted-shell'
    : mode === 'openai-local'
      ? 'local-shell'
      : undefined;
}
