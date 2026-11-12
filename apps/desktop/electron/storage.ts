import { activitySchema, conductorAttemptSchema, endActivity, runInfoSchema } from '@aria/shared';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { InitialState, LocalData } from '@aria/shared';
import { assetSchema } from './media-storage';

const id = z.string().min(1).max(200);
const text = z.string().max(100_000);
const status = z.enum([
  'idle',
  'pending',
  'running',
  'blocked',
  'failed',
  'completed',
  'cancelled',
]);
const file = z.object({
  id,
  name: z.string().max(1000),
  path: z.string().max(8000),
  size: z.number().nonnegative(),
});
export const legacyDataSchema = z.object({
  version: z.literal(1),
  workspaces: z
    .array(
      z.object({
        id,
        name: z.string().max(1000),
        root: z.string().min(1).max(8000),
        branch: z.string().max(1000).nullable(),
        updatedAt: z.string(),
      }),
    )
    .max(100),
  conversations: z
    .array(
      z.object({
        id,
        workspaceId: id,
        title: z.string().max(1000),
        draft: text,
        mode: z.enum(['chat', 'plan', 'execute']),
        attachments: z.array(file).max(100),
        updatedAt: z.string(),
      }),
    )
    .max(500),
  tasks: z
    .array(
      z.object({
        id,
        workspaceId: id,
        title: z.string().min(1).max(500),
        description: text,
        status,
        ownerId: id.nullable(),
        dependencies: z.array(id).max(500),
        source: z.literal('local'),
        revision: z.number().int().nonnegative(),
      }),
    )
    .max(2000),
  plans: z
    .array(
      z.object({
        id,
        workspaceId: id,
        title: z.string().max(500),
        steps: z
          .array(z.object({ id, title: z.string().max(1000), completed: z.boolean() }))
          .max(500),
        source: z.literal('local'),
        revision: z.number().int().nonnegative(),
      }),
    )
    .max(100),
  preferences: z.object({
    theme: z.enum(['dark', 'light', 'system']),
    route: z
      .string()
      .regex(/^\/(home|workspace|agents|tasks|terminal|knowledge|history|settings)$/),
    activeWorkspaceId: id.nullable(),
    sidebarCollapsed: z.boolean(),
    rightOpen: z.boolean(),
    rightWidth: z.number().min(280).max(520),
    sectionHeights: z.record(z.string(), z.number().min(100).max(800)),
    collapsedSections: z.array(z.string()).max(20),
    apiUrl: z.string().max(2000),
  }),
});
const operationSchema = z
  .object({
    mode: z.enum(['chat', 'image', 'speech', 'transcription']),
    model: z.string().min(1).max(200),
    prompt: text,
    voice: z.string().max(200).optional(),
    assetIds: z.array(z.string().uuid()).max(4),
  })
  .strict();
const chatSchema = z
  .object({
    conversations: z
      .array(
        z.object({
          id,
          title: z.string().min(1).max(1000),
          draft: text,
          pinned: z.boolean(),
          attachments: z.array(assetSchema).max(4).optional(),
          createdAt: z.string(),
          updatedAt: z.string(),
        }),
      )
      .max(500),
    messages: z
      .array(
        z.object({
          id,
          conversationId: id,
          requestId: id,
          role: z.enum(['user', 'assistant']),
          content: text,
          createdAt: z.string(),
          status: z.enum(['pending', 'streaming', 'completed', 'stopped', 'failed', 'interrupted']),
          sequence: z.number().int().nonnegative(),
          error: z.string().max(2000).optional(),
          operation: operationSchema.optional(),
          activity: z.array(activitySchema).max(12).optional(),
          attempts: z.array(conductorAttemptSchema).max(2).optional(),
          run: runInfoSchema.optional(),
          retryConfirmed: z.boolean().optional(),
          settingsHelp: z.boolean().optional(),
          partial: z.boolean().optional(),
          delegatedFromVoice: z.boolean().optional(),
          assets: z.array(assetSchema).max(4).optional(),
          liveSessionId: id.optional(),
          liveConfig: z.object({ model: id, chatModel: id, voice: id }).strict().optional(),
          fragments: z
            .array(
              z.object({
                text: z.string().max(10000),
                startMs: z.number().nonnegative(),
                endMs: z.number().nonnegative(),
              }),
            )
            .max(20000)
            .optional(),
        }),
      )
      .max(20000),
    selectedId: id.nullable(),
    newDraft: text,
    newAttachments: z.array(assetSchema).max(4).optional(),
  })
  .superRefine((chat, context) => {
    const ids = new Set(chat.conversations.map((item) => item.id));
    if (
      ids.size !== chat.conversations.length ||
      new Set(chat.messages.map((item) => item.id)).size !== chat.messages.length
    )
      context.addIssue({ code: 'custom', message: 'Duplicate chat identifiers.' });
    if (
      (chat.selectedId && !ids.has(chat.selectedId)) ||
      chat.messages.some((item) => !ids.has(item.conversationId))
    )
      context.addIssue({ code: 'custom', message: 'Chat references a missing conversation.' });
  });
export const localDataSchema = legacyDataSchema.extend({
  version: z.literal(3),
  preferences: legacyDataSchema.shape.preferences.extend({
    route: z
      .string()
      .regex(
        /^\/(chat|settings|advanced(?:\/(?:home|workspace|agents|tasks|terminal|knowledge|history|settings))?)$/,
      ),
    chatSidebarCollapsed: z.boolean(),
    profileName: z.string().trim().min(1).max(80),
  }),
  chat: chatSchema,
});
export function migrateLegacy(input: unknown): LocalData {
  const legacy = legacyDataSchema.parse(input);
  return localDataSchema.parse({
    ...legacy,
    version: 3,
    preferences: {
      ...legacy.preferences,
      route: '/chat',
      chatSidebarCollapsed: false,
      profileName: 'You',
    },
    chat: { conversations: [], messages: [], selectedId: null, newDraft: '' },
  });
}
export function emptyData(): LocalData {
  return {
    version: 3,
    workspaces: [],
    conversations: [],
    tasks: [],
    plans: [],
    chat: { conversations: [], messages: [], selectedId: null, newDraft: '' },
    preferences: {
      theme: 'dark',
      route: '/chat',
      activeWorkspaceId: null,
      sidebarCollapsed: false,
      rightOpen: true,
      rightWidth: 384,
      sectionHeights: {},
      collapsedSections: [],
      apiUrl: 'http://localhost:3000',
      chatSidebarCollapsed: false,
      profileName: 'You',
    },
  };
}
export class LocalStorage {
  private data = emptyData();
  private queue: Promise<void> = Promise.resolve();
  private readonly registered = new Map<string, string>();
  constructor(private readonly directory: string) {}
  get filename(): string {
    return path.join(this.directory, 'aria-v3.json');
  }
  async load(): Promise<InitialState> {
    let warning: string | undefined;
    let filename = this.filename;
    let migrated = false;
    try {
      let serialized: string;
      try {
        serialized = await fs.readFile(filename, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        filename = path.join(this.directory, 'aria-v2.json');
        try {
          serialized = await fs.readFile(filename, 'utf8');
        } catch (legacyError) {
          if ((legacyError as NodeJS.ErrnoException).code !== 'ENOENT') throw legacyError;
          filename = path.join(this.directory, 'workspace-v1.json');
          serialized = await fs.readFile(filename, 'utf8');
        }
        migrated = true;
      }
      const input = JSON.parse(serialized);
      this.data =
        input.version === 1
          ? migrateLegacy(input)
          : localDataSchema.parse(
              migrated && input.version === 2 ? { ...input, version: 3 } : input,
            );
      this.data.chat.messages = this.data.chat.messages.map((message) =>
        ['pending', 'streaming'].includes(message.status)
          ? {
              ...message,
              status: 'interrupted',
              error: 'Aria closed before this response finished. You can send it again.',
              retryConfirmed: false,
              activity: endActivity(message.activity),
            }
          : message,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        const recovery = `${filename}.recovery-${Date.now()}`;
        await fs.copyFile(filename, recovery);
        warning = `Saved data could not be read. A recovery copy was preserved at ${recovery}.`;
      }
    }
    for (const workspace of this.data.workspaces) this.registered.set(workspace.id, workspace.root);
    if (migrated && !warning) await this.save(this.data);
    return { data: this.data, warning };
  }
  root(id: string): string {
    const root = this.registered.get(id);
    if (!root) throw new Error('Select a project folder first.');
    return root;
  }
  async register(workspace: LocalData['workspaces'][number]): Promise<void> {
    this.registered.set(workspace.id, workspace.root);
    await this.save({
      ...this.data,
      workspaces: [...this.data.workspaces.filter((w) => w.root !== workspace.root), workspace],
    });
  }
  save(input: unknown): Promise<void> {
    const data = localDataSchema.parse(input);
    for (const workspace of data.workspaces)
      if (this.registered.get(workspace.id) !== workspace.root)
        throw new Error('Project folder is not registered. Use the folder picker.');
    const serialized = JSON.stringify(data, null, 2);
    if (Buffer.byteLength(serialized) > 8_000_000)
      throw new Error('Local data exceeds the 8 MB storage limit.');
    const write = this.queue
      .catch(() => undefined)
      .then(async () => {
        await fs.mkdir(this.directory, { recursive: true });
        await fs.writeFile(`${this.filename}.tmp`, serialized, { mode: 0o600 });
        await fs.rename(`${this.filename}.tmp`, this.filename);
        this.data = data;
      });
    this.queue = write;
    return write;
  }
}
