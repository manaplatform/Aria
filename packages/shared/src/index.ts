import type { ConnectorCommand, ConnectorSnapshot, ConnectorActivity } from './connectors/index.js';
export * from './proactive.js';
import type { PersonaSettings, CommunicationProposal } from './persona.js';
import type { PresentationPart, PresentationState, PresentationActionRequest, PresentationActionResult } from './presentation.js';
import type { ProactiveCommand, ProactiveEvent, ProactiveResult } from './proactive.js';
import type { MemoryDiagnostics, MemoryRecord, MemorySearch, MemorySearchResult, MemorySettings, MemoryStatus, MemoryTurnOptions } from './memory.js';
export * from './memory.js';
import type {
  DocumentEvidence,
  ExecutionHistoryEntry,
  KnowledgeCollection,
  OpenAIRuntimeFeature,
  RuntimeSettings,
} from './execution-runtime.js';
import type { SkillRef, SkillPreview, ToolDiscovery, ToolSettings } from './capabilities.js';
import type { ProgramSettings } from './programmatic.js';
export * from './capabilities.js';
export * from './programmatic.js';
import type { BrowserCommand, BrowserLayout, BrowserState } from './browser.js';
import type {
  ComputerAction,
  ComputerSessionSummary,
  LocalDesktopAccess,
  ComputerSupervision,
} from './computer-use.js';
import type { WebSettings, WebSettingsInput } from './web.js';
import type { WeatherSettings, WeatherSettingsView } from './weather.js';
export * from './browser.js';
export * from './computer-use.js';
export * from './web.js';
export * from './public-address.js';
import type {
  ConnectionInput,
  DiscoveredModel,
  RegistryInput,
  RegistrySettings,
} from './model-registry.js';
import type {
  ConductorActivity,
  ConductorAttempt,
  ConductorEvent,
  ConductorRunInfo,
  ConductorSource,
} from './conductor.js';
export * from './model-registry.js';
export * from './conductor.js';
import type { ExecutionSnapshot, LoopCommand, LoopRecoveryRequest, ManagedExecution } from './loop.js';
export * from './loop.js';
export { projectChatEvent } from './chat-projection.js';
import type {
  AboutInfo,
  AccentColor,
  CustomizableShortcutId,
  FontSize,
  InterfaceDensity,
  LogLevel,
  MotionPreference,
  NotificationPreferences,
  OsPermissionsStatus,
  ResetConfigurationScope,
  ResponseStyle,
  SettingsCategoryId,
  ShortcutsMap,
  StartupBehavior,
  StorageInfo,
  SystemBehaviorState,
  UserPersonalization,
} from './settings.js';
export * from './settings.js';
export * from './diagnostics.js';
import type { DiagnosticConfig, DiagnosticEvent, DiagnosticFilter, DiagnosticPage, DiagnosticStatus } from './diagnostics.js';

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
  settingsCategory?: SettingsCategoryId;
  settingsSidebarCollapsed?: boolean;
  startupBehavior?: StartupBehavior;
  minimizeToTray?: boolean;
  accentColor?: AccentColor;
  fontSize?: FontSize;
  density?: InterfaceDensity;
  reducedMotion?: MotionPreference;
  expandActivityByDefault?: boolean;
  profileBio?: string;
  responseStyle?: ResponseStyle;
  persona?: Partial<PersonaSettings>;
  communicationLanguage?: string;
  notifications?: NotificationPreferences;
  shortcuts?: ShortcutsMap;
  logLevel?: LogLevel;
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
  projectId?: string;
  temporary?: boolean;
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
  presentation?: PresentationPart[];
  presentationState?: PresentationState;
  sequence: number;
  error?: string;
  operation?: OperationInput;
  activity?: ConductorActivity[];
  citations?: { sources: ConductorSource[]; evidence: DocumentEvidence[] };
  attempts?: ConductorAttempt[];
  run?: ConductorRunInfo;
  execution?: ExecutionSnapshot;
  retryConfirmed?: boolean;
  settingsHelp?: boolean;
  partial?: boolean;
  assets?: MediaAsset[];
  liveSessionId?: string;
  delegatedFromVoice?: boolean;
  liveConfig?: { model: string; chatModel: string; voice: string };
  suggestions?: string[];
  memoryReferences?: string[];
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
  attachmentIds?: string[];
  availableAssets?: MediaAsset[];
  expectedRevision?: string;
  programPrivateHistory?: boolean;
  activeProjectId?: string;
  availableProjects?: { id: string; name: string; branch: string | null }[];
  memory?: MemoryTurnOptions;
  execution?: ManagedExecution;
  personalization?: UserPersonalization;
}
export type ChatEvent = {
  requestId: string;
  conversationId: string;
  assistantMessageId: string;
  sequence: number;
  executionId?: string;
  generation?: number;
} & (
  | Exclude<ConductorEvent, { type: 'completed' }>
  | { type: 'asset'; asset: MediaAsset }
  | (Extract<ConductorEvent, { type: 'completed' }> & { assets?: MediaAsset[]; memoryReferences?: string[] })
);
export interface ChatCapabilities {
  configured: boolean;
  model: string;
  streaming: true;
  cancellation: true;
  attachments: boolean;
}
export interface ChatServiceStatus {
  state: 'starting' | 'ready' | 'failed';
  configured: boolean;
  model: string;
  error?: string;
  revision?: string;
  registryRevision?: string;
  voiceReady?: boolean;
}
export type GenerationMode = 'chat' | 'image' | 'speech' | 'transcription' | 'live';
export interface MediaAsset {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  managed?: boolean;
}
export interface OperationInput {
  mode: Exclude<GenerationMode, 'live'>;
  model: string;
  prompt: string;
  voice?: string;
  assetIds: string[];
}
export interface LiveRequest {
  sessionId: string;
  conversationId: string;
  assistantMessageId: string;
  messages: ChatRequest['messages'];
}
export type LiveEvent = { sessionId: string; conversationId: string } & (
  | { type: 'ready' }
  | {
      type: 'conductor';
      requestId: string;
      event: ConductorEvent | { type: 'asset'; asset: MediaAsset };
    }
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
export type UpdateChannel = 'stable' | 'beta';
export type UpdateCommand =
  | { action: 'channel'; channel: UpdateChannel }
  | { action: 'check' | 'download' | 'install' | 'open-installer' | 'open-release' };
export interface UpdateState {
  version: string;
  channel: UpdateChannel;
  status: 'unsupported' | 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'installing' | 'error';
  mode: 'install' | 'disk-image' | 'manual';
  available?: string;
  progress?: number;
  error?: string;
}
export interface DesktopBridge {
  connectors(input: ConnectorCommand): Promise<ConnectorSnapshot>;
  connectorActivity(id: string): Promise<ConnectorActivity[]>;
  onConnectorsChanged(callback: (state: ConnectorSnapshot) => void): () => void;
  proactive(command: ProactiveCommand): Promise<ProactiveResult>;
  onProactiveEvent(callback: (event: ProactiveEvent) => void): () => void;
  platform: string;
  updateState(): Promise<UpdateState>;
  updateCommand(command: UpdateCommand): Promise<void>;
  onUpdateState(callback: (state: UpdateState) => void): () => void;
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
  browserState(): Promise<BrowserState>;
  browserCommand(command: BrowserCommand): Promise<string | void>;
  browserLayout(layout: BrowserLayout): Promise<void>;
  computerSessions(conversationId: string): Promise<ComputerSessionSummary[]>;
  computerPreview(conversationId: string, sessionId: string): Promise<string | undefined>;
  probeVirtualComputer(): Promise<void>;
  localComputerSupported(): Promise<boolean>;
  selectLocalComputer(conversationId: string | null, target?: 'window' | 'screen', standing?: boolean): Promise<boolean>;
  localDesktopAccess(requestPermission?: boolean): Promise<LocalDesktopAccess>;
  revokeLocalComputer(): Promise<void>;
  superviseComputer(conversationId: string, command: ComputerSupervision): Promise<void>;
  sendComputerInput(
    conversationId: string,
    sessionId: string,
    action: ComputerAction,
  ): Promise<void>;
  onComputerSession(callback: (state: ComputerSessionSummary) => void): () => void;
  onBrowserState(callback: (state: BrowserState) => void): () => void;
  webSettings(): Promise<WebSettings>;
  weatherSettings(): Promise<WeatherSettingsView>;
  saveWeatherSettings(input: WeatherSettings): Promise<WeatherSettingsView>;
  clearWeatherCache(): Promise<WeatherSettingsView>;
  saveWebSettings(input: WebSettingsInput): Promise<WebSettings>;
  toolSettings(): Promise<ToolSettings>;
  executionHistory(): Promise<ExecutionHistoryEntry[]>;
  runtimeSettings(): Promise<RuntimeSettings>;
  saveRuntimeSettings(settings: RuntimeSettings): Promise<RuntimeSettings>;
  saveEmbeddingTarget(target: RuntimeSettings['embeddingTarget']): Promise<RuntimeSettings>;
  nativeRuntimeModes(): Promise<OpenAIRuntimeFeature[]>;
  setNativeRuntime(mode: OpenAIRuntimeFeature, enabled: boolean): Promise<OpenAIRuntimeFeature[]>;
  probeRuntime(): Promise<Record<string, unknown>>;
  localEmbeddings(): Promise<boolean>;
  installLocalEmbeddings(): Promise<boolean>;
  removeLocalEmbeddings(): Promise<void>;
  knowledgeCollections(): Promise<KnowledgeCollection[]>;
  manageKnowledge(
    input:
      | { operation: 'create'; name: string }
      | { operation: 'enable'; id: string; enabled: boolean }
      | { operation: 'add' | 'remove'; id: string }
      | { operation: 'remove-file'; id: string; fileId: string },
  ): Promise<KnowledgeCollection[]>;
  previewDocument(conversationId: string, id: string): Promise<string>;
  removeArtifact(conversationId: string, id: string): Promise<void>;
  documentEvidence(conversationId: string, id: string): Promise<DocumentEvidence>;
  setToolEnabled(id: string, enabled: boolean): Promise<ToolSettings>;
  setToolDiscovery(mode: ToolDiscovery): Promise<ToolSettings>;
  setProgramSettings(settings: ProgramSettings): Promise<ToolSettings>;
  superviseProgram(requestId: string, conversationId: string, id: string, pause: boolean): Promise<void>;
  inspectProgramResult(conversationId: string, id: string): Promise<string>;
  recoverStoredResponse(conversationId: string, messageId: string, requestId: string):
    Promise<{ content: string; privateContent: boolean }>;
  previewSkill(kind: 'directory' | 'zip'): Promise<SkillPreview | null>;
  approveSkill(token: string): Promise<ToolSettings>;
  manageSkill(skill: SkillRef, action: 'enable' | 'disable' | 'remove'): Promise<ToolSettings>;
  chatStatus(): Promise<ChatServiceStatus>;
  onChatStatus(callback: (status: ChatServiceStatus) => void): () => void;
  restartChatService(): Promise<void>;
  registrySettings(): Promise<RegistrySettings>;
  saveRegistry(settings: RegistryInput): Promise<RegistrySettings>;
  discoverModels(connection: ConnectionInput): Promise<DiscoveredModel[]>;
  verifyModel(connection: ConnectionInput, model: string): Promise<void>;
  importRegistryEnvironment(): Promise<RegistrySettings>;
  importDroppedFiles(files: File[]): Promise<MediaAsset[]>;
  chooseMedia(kind: 'image' | 'audio' | 'text' | 'any'): Promise<MediaAsset[]>;
  captureScreen(): Promise<MediaAsset[]>;
  exportMedia(id: string): Promise<void>;
  startLive(request: LiveRequest): Promise<void>;
  sendLiveAudio(sessionId: string, audio: Uint8Array): void;
  muteLive(sessionId: string, muted: boolean): Promise<void>;
  endLive(): Promise<void>;
  onLiveEvent(callback: (event: LiveEvent) => void): () => void;
  personaAction(input: PresentationActionRequest): Promise<PresentationActionResult>;
  personaRender(messageId: string, status: 'rendered' | 'failed', durationMs: number): Promise<void>;
  communicationPreferences(): Promise<{ proposals: CommunicationProposal[]; records: MemoryRecord[] }>;
  reviewCommunicationPreference(id: string, accept: boolean): Promise<void>;
  memoryStatus(): Promise<MemoryStatus>;
  memoryDiagnostics(): Promise<MemoryDiagnostics>;
  saveMemorySettings(settings: MemorySettings, allowAutoRecall?: boolean): Promise<MemoryStatus>;
  rememberChatMessage(conversationId: string, messageId: string, category: MemoryRecord['value']['category']): Promise<MemoryRecord>;
  memoryEvidence(conversationId: string, recordId: string): Promise<MemoryRecord | null>;
  searchMemories(query: MemorySearch): Promise<MemorySearchResult>;
  editMemory(record: Pick<MemoryRecord, 'id' | 'revision' | 'value'>): Promise<MemoryRecord>;
  deleteMemory(record: Pick<MemoryRecord, 'id' | 'revision'>): Promise<void>;
  clearMemories(filter: { category?: MemoryRecord['value']['category']; projectId?: string }): Promise<number>;
  exportMemories(): Promise<boolean>;
  startTemporaryChat(conversationId: string): Promise<void>;
  attachChatProject(conversationId: string, projectId: string | null): Promise<void>;
  submitChat(request: ChatRequest): Promise<void>;
  cancelChat(requestId: string): Promise<void>;
  controlExecution(command: LoopCommand): Promise<void>;
  resumeExecution(request: LoopRecoveryRequest): Promise<void>;
  activeChatMessages(): Promise<ChatMessage[]>;
  onChatEvent(callback: (event: ChatEvent) => void): () => void;
  systemBehavior(): Promise<SystemBehaviorState>;
  setSystemBehavior(patch: { openAtLogin?: boolean; minimizeToTray?: boolean }): Promise<SystemBehaviorState>;
  testNotification(): Promise<void>;
  removeWorkspace(workspaceId: string): Promise<boolean>;
  storageInfo(): Promise<StorageInfo>;
  openStorageFolder(): Promise<void>;
  pruneMediaCache(): Promise<{ removed: number; freedBytes: number }>;
  clearBrowserCache(): Promise<void>;
  osPermissions(): Promise<OsPermissionsStatus>;
  clearChatHistory(): Promise<boolean>;
  clearLegacyData(): Promise<boolean>;
  exportDiagnostics(): Promise<boolean>;
  diagnosticStatus(): Promise<DiagnosticStatus>;
  diagnosticConfigure(config: DiagnosticConfig): Promise<DiagnosticStatus>;
  diagnosticQuery(filter: DiagnosticFilter): Promise<DiagnosticPage>;
  diagnosticClear(): Promise<void>;
  diagnosticOpenDirectory(): Promise<void>;
  diagnosticExport(filter: DiagnosticFilter): Promise<boolean>;
  diagnosticRendererError(): Promise<void>;
  onDiagnosticEvents(callback: (events: DiagnosticEvent[]) => void): () => void;
  resetConfiguration(scope: ResetConfigurationScope): Promise<boolean>;
  aboutInfo(): Promise<AboutInfo>;
  openDevTools(): Promise<void>;
}

export * from './execution-runtime.js';
export * from './reply-visual.js';
export * from './persona.js';
export * from './weather.js';
export * from './presentation.js';
export * from './calculation.js';
export * from './connectors/index.js';

export * from './sensitive-data.js';
