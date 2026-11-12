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
  chatSidebarCollapsed: boolean;
  profileName: string;
}
export interface LocalData {
  version: 3;
  workspaces: Workspace[];
  conversations: Conversation[];
  tasks: Task[];
  plans: Plan[];
  preferences: Preferences;
  chat: ChatData;
}
export interface ChatConversation {
  id: string;
  title: string;
  draft: string;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  attachments?: MediaAsset[];
}
export type ChatMessageStatus =
  'pending' | 'streaming' | 'completed' | 'stopped' | 'failed' | 'interrupted';
export interface ChatMessage {
  id: string;
  conversationId: string;
  requestId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  status: ChatMessageStatus;
  sequence: number;
  error?: string;
  operation?: OperationInput;
  assets?: MediaAsset[];
  liveSessionId?: string;
  liveConfig?: { model: string; chatModel: string; voice: string };
  fragments?: { text: string; startMs: number; endMs: number }[];
}
export interface ChatData {
  conversations: ChatConversation[];
  messages: ChatMessage[];
  selectedId: string | null;
  newDraft: string;
  newAttachments?: MediaAsset[];
}
export interface ChatRequest {
  requestId: string;
  conversationId: string;
  assistantMessageId: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  model?: string;
}
export type ChatEvent = {
  requestId: string;
  conversationId: string;
  assistantMessageId: string;
  sequence: number;
} & (
  | { type: 'started' }
  | { type: 'delta'; text: string }
  | { type: 'completed'; assets?: MediaAsset[] }
  | { type: 'stopped' }
  | { type: 'failed'; error: string; interrupted: boolean }
);
export interface ChatCapabilities {
  configured: boolean;
  model: string;
  streaming: true;
  cancellation: true;
  attachments: false;
}
export interface ChatServiceStatus {
  state: 'starting' | 'ready' | 'failed';
  configured: boolean;
  model: string;
  error?: string;
}
export interface ProviderSettings {
  provider: ProviderId;
  baseUrl: string;
  model: string;
  models: ModelSelections;
  systemPrompt: string;
  keyConfigured: boolean;
  encryptionAvailable: boolean;
  sources: Record<
    'baseUrl' | 'model' | 'systemPrompt' | 'apiKey',
    'environment' | 'settings' | 'default'
  >;
}
export interface ProviderSettingsInput {
  provider?: ProviderId;
  baseUrl: string;
  model: string;
  models?: ModelSelections;
  systemPrompt: string;
  apiKey?: string;
  removeKey?: boolean;
}
export type ProviderId = 'openai';
export type GenerationMode = 'chat' | 'image' | 'speech' | 'transcription' | 'live';
export type ModelSelections = Record<GenerationMode, string>;
export interface ProviderConnectionInput {
  provider: ProviderId;
  baseUrl: string;
  apiKey?: string;
  removeKey?: boolean;
}
export interface ProviderModel {
  id: string;
  modes: GenerationMode[];
  deprecated?: boolean;
  shutdownDate?: string;
}
export interface MediaAsset {
  id: string;
  name: string;
  mimeType: string;
  size: number;
}
export interface OperationInput {
  mode: Exclude<GenerationMode, 'live'>;
  model: string;
  prompt: string;
  voice?: string;
  assetIds: string[];
}
export interface MediaRequest extends OperationInput {
  requestId: string;
  conversationId: string;
  assistantMessageId: string;
}
export interface LiveRequest {
  sessionId: string;
  conversationId: string;
  model: string;
  chatModel: string;
  voice: string;
  messages: ChatRequest['messages'];
}
export type LiveEvent = { sessionId: string; conversationId: string } & (
  | { type: 'ready' }
  | { type: 'audio'; audio: string }
  | { type: 'transcript'; role: 'user' | 'assistant'; text: string; startMs: number; endMs: number }
  | { type: 'ended'; asset?: MediaAsset }
  | { type: 'failed'; error: string; asset?: MediaAsset }
);
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
  chatStatus(): Promise<ChatServiceStatus>;
  onChatStatus(callback: (status: ChatServiceStatus) => void): () => void;
  providerSettings(): Promise<ProviderSettings>;
  saveProviderSettings(settings: ProviderSettingsInput): Promise<ProviderSettings>;
  restartChatService(): Promise<void>;
  testProvider(): Promise<void>;
  providerModels(connection?: ProviderConnectionInput): Promise<ProviderModel[]>;
  chooseMedia(kind: 'image' | 'audio'): Promise<MediaAsset[]>;
  exportMedia(id: string): Promise<void>;
  submitMedia(request: MediaRequest): Promise<void>;
  startLive(request: LiveRequest): Promise<void>;
  sendLiveAudio(sessionId: string, audio: Uint8Array): void;
  muteLive(sessionId: string, muted: boolean): Promise<void>;
  endLive(): Promise<void>;
  onLiveEvent(callback: (event: LiveEvent) => void): () => void;
  submitChat(request: ChatRequest): Promise<void>;
  cancelChat(requestId: string): Promise<void>;
  onChatEvent(callback: (event: ChatEvent) => void): () => void;
}
