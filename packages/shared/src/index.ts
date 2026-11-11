export interface HealthResponse {
  status: 'ok';
}

export interface ApiError {
  statusCode: number;
  message: string;
}

export type Mode = 'chat' | 'plan' | 'execute';
export type Status =
  'idle' | 'pending' | 'running' | 'blocked' | 'failed' | 'completed' | 'cancelled';
export type Source = 'local' | 'backend' | 'sample';
export interface Workspace {
  id: string;
  name: string;
  root: string;
  branch: string | null;
  updatedAt: string;
}
export interface FileContext {
  id: string;
  name: string;
  path: string;
  size: number;
}
export interface Conversation {
  id: string;
  workspaceId: string;
  title: string;
  draft: string;
  mode: Mode;
  attachments: FileContext[];
  updatedAt: string;
}
export interface Message {
  id: string;
  workspaceId: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  status: 'streaming' | 'completed' | 'failed';
  revision: number;
}
export interface Agent {
  id: string;
  name: string;
  role: string;
  status: Status;
  parentId: string | null;
  revision: number;
}
export interface AgentRelationship {
  parentId: string;
  childId: string;
}
export interface Task {
  id: string;
  workspaceId: string;
  title: string;
  description: string;
  status: Status;
  ownerId: string | null;
  dependencies: string[];
  source: Source;
  revision: number;
}
export interface PlanStep {
  id: string;
  title: string;
  completed: boolean;
}
export interface Plan {
  id: string;
  workspaceId: string;
  title: string;
  steps: PlanStep[];
  source: Source;
  revision: number;
}
export interface ExecutionSession {
  id: string;
  workspaceId: string;
  status: Status;
  startedAt: string;
  endedAt?: string;
}
export interface ToolInvocation {
  name: string;
  arguments: Record<string, unknown>;
  result?: string;
}
export interface CommandOutput {
  id: string;
  stream: 'stdout' | 'stderr';
  text: string;
  sequence: number;
}
export interface Command {
  executable: string;
  args: string[];
  display: string;
  cwd: string;
  output: CommandOutput[];
  exitCode?: number;
}
export interface FileChange {
  path: string;
  before: string;
  after: string;
  kind: 'read' | 'added' | 'modified' | 'deleted';
}
export interface ExecutionEvent {
  id: string;
  workspaceId: string;
  sessionId: string;
  sequence: number;
  revision: number;
  kind: 'command' | 'file' | 'tool';
  title: string;
  summary: string;
  status: Status;
  agentId: string;
  taskId: string;
  startedAt: string;
  durationMs: number;
  command?: Command;
  file?: FileChange;
  tool?: ToolInvocation;
}
export interface ApprovalRequest {
  id: string;
  workspaceId: string;
  operation: string;
  target: string;
  context: string;
  risk: string;
  status: 'pending' | 'approved' | 'denied';
  revision: number;
}
export interface Capabilities {
  chat: boolean;
  execution: boolean;
  cancellation: boolean;
  agents: boolean;
  approvals: boolean;
  streaming: boolean;
}
export interface Snapshot {
  workspaceId: string;
  cursor: number;
  agents: Agent[];
  tasks: Task[];
  plans: Plan[];
  messages: Message[];
  events: ExecutionEvent[];
  approvals: ApprovalRequest[];
  session?: ExecutionSession;
}
export type LiveUpdate =
  | { workspaceId: string; cursor: number; type: 'snapshot'; snapshot: Snapshot }
  | { workspaceId: string; cursor: number; type: 'message'; message: Message }
  | { workspaceId: string; cursor: number; type: 'event'; event: ExecutionEvent }
  | { workspaceId: string; cursor: number; type: 'approval'; approval: ApprovalRequest };
export interface WorkspaceAdapter {
  readonly source: Source;
  readonly capabilities: Capabilities;
  getSnapshot(workspaceId: string, signal?: AbortSignal): Promise<Snapshot>;
  subscribe(
    workspaceId: string,
    onUpdate: (update: LiveUpdate) => void,
    cursor?: number,
  ): () => void;
  submitMessage(conversation: Conversation): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  decideApproval(id: string, decision: 'approved' | 'denied'): Promise<ApprovalRequest>;
}
export interface Preferences {
  theme: 'dark' | 'light' | 'system';
  route: string;
  activeWorkspaceId: string | null;
  sidebarCollapsed: boolean;
  rightOpen: boolean;
  rightWidth: number;
  sectionHeights: Record<string, number>;
  collapsedSections: string[];
  apiUrl: string;
}
export interface LocalData {
  version: 1;
  workspaces: Workspace[];
  conversations: Conversation[];
  tasks: Task[];
  plans: Plan[];
  preferences: Preferences;
}
export interface InitialState {
  data: LocalData;
  warning?: string;
}
export interface DirectoryEntry {
  name: string;
  path: string;
  kind: 'file' | 'directory';
  size: number;
}
export interface FilePreview {
  path: string;
  content: string;
  truncated: boolean;
  binary: boolean;
}
export interface RepositoryInfo {
  branch: string | null;
  isGit: boolean;
  error?: string;
}
export interface HealthResult {
  reachable: boolean;
  message: string;
  checkedAt: string;
}
export interface DesktopBridge {
  platform: string;
  onBeforeClose(callback: () => Promise<void>): () => void;
  load(): Promise<InitialState>;
  save(data: LocalData): Promise<void>;
  chooseWorkspace(): Promise<Workspace | null>;
  repository(workspaceId: string): Promise<RepositoryInfo>;
  listFiles(workspaceId: string, directory: string): Promise<DirectoryEntry[]>;
  readFile(workspaceId: string, file: string): Promise<FilePreview>;
  chooseFiles(workspaceId: string): Promise<FileContext[]>;
  health(baseUrl: string): Promise<HealthResult>;
  copy(text: string): Promise<void>;
  openExternal(url: string): Promise<void>;
}
