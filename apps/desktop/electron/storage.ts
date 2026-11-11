import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { InitialState, LocalData } from '@aria/shared';

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
export const localDataSchema = z.object({
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
export function emptyData(): LocalData {
  return {
    version: 1,
    workspaces: [],
    conversations: [],
    tasks: [],
    plans: [],
    preferences: {
      theme: 'dark',
      route: '/home',
      activeWorkspaceId: null,
      sidebarCollapsed: false,
      rightOpen: true,
      rightWidth: 384,
      sectionHeights: {},
      collapsedSections: [],
      apiUrl: 'http://localhost:3000',
    },
  };
}
export class LocalStorage {
  private data = emptyData();
  private queue: Promise<void> = Promise.resolve();
  private readonly registered = new Map<string, string>();
  constructor(private readonly directory: string) {}
  get filename(): string {
    return path.join(this.directory, 'workspace-v1.json');
  }
  async load(): Promise<InitialState> {
    let warning: string | undefined;
    try {
      this.data = localDataSchema.parse(JSON.parse(await fs.readFile(this.filename, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        const recovery = `${this.filename}.recovery-${Date.now()}`;
        await fs.copyFile(this.filename, recovery);
        warning = `Saved data could not be read. A recovery copy was preserved at ${recovery}.`;
      }
    }
    for (const workspace of this.data.workspaces) this.registered.set(workspace.id, workspace.root);
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
