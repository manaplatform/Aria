import type { LucideIcon } from 'lucide-react';
import {
  Bell,
  Brain,
  Cpu,
  FolderCog,
  Globe,
  Info,
  KeyRound,
  Keyboard,
  Monitor,
  Palette,
  Plug,
  SlidersHorizontal,
  Sparkles,
  Terminal,
  UserCog,
  Workflow,
  Wrench,
} from 'lucide-react';
import type { SettingsCategoryId } from '@aria/shared';

export type SettingsGroupId = 'preferences' | 'ai' | 'capabilities' | 'system';

export interface SettingsCategoryMeta {
  id: SettingsCategoryId;
  group: SettingsGroupId;
  label: string;
  description: string;
  icon: LucideIcon;
}

export interface SettingsSearchItem {
  id: string;
  category: SettingsCategoryId;
  title: string;
  description: string;
  keywords: string[];
  settingId?: string;
}

export const settingsGroups: { id: SettingsGroupId; label: string }[] = [
  { id: 'preferences', label: 'Preferences' },
  { id: 'ai', label: 'Artificial Intelligence' },
  { id: 'capabilities', label: 'Capabilities' },
  { id: 'system', label: 'System' },
];

export const settingsCategories: SettingsCategoryMeta[] = [
  {
    id: 'general',
    group: 'preferences',
    label: 'General',
    description: 'Profile identity, startup behavior, and desktop window options.',
    icon: SlidersHorizontal,
  },
  {
    id: 'appearance',
    group: 'preferences',
    label: 'Appearance',
    description: 'Theme mode, accent color, font size, density, and motion.',
    icon: Palette,
  },
  {
    id: 'personalization',
    group: 'preferences',
    label: 'Persona & Communication',
    description: 'Custom instructions, response style, language, and personal context.',
    icon: UserCog,
  },
  {
    id: 'notifications',
    group: 'preferences',
    label: 'Notifications',
    description: 'Desktop alerts for completed responses, background tasks, and approvals.',
    icon: Bell,
  },
  {
    id: 'providers',
    group: 'ai',
    label: 'AI Providers',
    description: 'Manage provider endpoints, encrypted API keys, and connection discovery.',
    icon: KeyRound,
  },
  {
    id: 'models',
    group: 'ai',
    label: 'Models',
    description: 'Select the default chat model, Live Voice profile, and model capabilities.',
    icon: Cpu,
  },
  {
    id: 'conductor',
    group: 'ai',
    label: 'Conductor',
    description: 'Service status, execution strategy, loop limits, and orchestration history.',
    icon: Workflow,
  },
  {
    id: 'proactive', group: 'ai', label: 'Proactive Assistant',
    description: 'Configure Pulse, automations, and background responsibilities.', icon: Sparkles,
  },
  {
    id: 'memory',
    group: 'ai',
    label: 'Memory',
    description: 'Manage persistent memory, recall consent, search, and diagnostics.',
    icon: Brain,
  },
  {
    id: 'connectors',
    group: 'capabilities',
    label: 'Connectors',
    description: 'Connect GitHub and manage accounts, repositories, and permissions.',
    icon: Plug,
  },
  {
    id: 'integrations',
    group: 'capabilities',
    label: 'Tools & Integrations',
    description: 'Control built-in tools, Agent Skills, native modes, and connectors.',
    icon: Wrench,
  },
  {
    id: 'browser',
    group: 'capabilities',
    label: 'Browser',
    description: 'Web search preferences, AI browsing limits, site permissions, and data.',
    icon: Globe,
  },
  {
    id: 'desktop',
    group: 'capabilities',
    label: 'Desktop Control',
    description: 'Screen capture, pointer access, virtual desktop, and OS permission status.',
    icon: Monitor,
  },
  {
    id: 'storage',
    group: 'capabilities',
    label: 'Files & Storage',
    description: 'Authorized directories, knowledge libraries, storage usage, and cache.',
    icon: FolderCog,
  },
  {
    id: 'privacy',
    group: 'system',
    label: 'Privacy & Security',
    description: 'Credential encryption, OS permissions, data retention, and cleanup.',
    icon: Sparkles,
  },
  {
    id: 'shortcuts',
    group: 'system',
    label: 'Keyboard Shortcuts',
    description: 'View and customize keyboard shortcuts and detect conflicting bindings.',
    icon: Keyboard,
  },
  { id: 'diagnostics', group: 'system', label: 'Developer & Diagnostics', description: 'Logging, live events, and diagnostic exports.', icon: Terminal },
  {
    id: 'advanced',
    group: 'system',
    label: 'Advanced',
    description: 'Diagnostics export, logging preferences, developer tools, and resets.',
    icon: Terminal,
  },
  {
    id: 'about',
    group: 'system',
    label: 'About Aria',
    description: 'Version details, release updates, license, and third-party notices.',
    icon: Info,
  },
];

export const settingsSearchIndex: SettingsSearchItem[] = [
  { id: 'diagnostic-logs', category: 'diagnostics', title: 'Developer and Diagnostics', description: 'View and export local logs.', keywords: ['logs', 'debug', 'trace', 'export'], settingId: 'diagnostics-logs' },
  { id: 'connector-github', category: 'connectors', title: 'GitHub', description: 'Connect a GitHub account and manage repository access and write permissions.', keywords: ['OAuth', 'app', 'sign in', 'disconnect', 'repository'], settingId: 'connector-github' },
  { id: 'gen-name', category: 'general', title: 'Display name', description: 'Your local name shown in the sidebar and conversations.', keywords: ['profile', 'name', 'user'], settingId: 'general-display-name' },
  { id: 'gen-lang', category: 'general', title: 'Application language', description: 'Interface display language.', keywords: ['locale', 'english', 'language'], settingId: 'general-language' },
  { id: 'gen-startup', category: 'general', title: 'Startup behavior', description: 'Restore last conversation or open a fresh chat on launch.', keywords: ['launch', 'boot', 'home', 'welcome'], settingId: 'general-startup' },
  { id: 'gen-login', category: 'general', title: 'Launch at system startup', description: 'Start Aria automatically when you sign in.', keywords: ['login', 'autostart', 'boot'], settingId: 'general-open-at-login' },
  { id: 'gen-tray', category: 'general', title: 'Minimize to system tray', description: 'Keep Aria running in the tray when closing the window.', keywords: ['tray', 'background', 'close'], settingId: 'general-tray' },
  { id: 'app-theme', category: 'appearance', title: 'Theme mode', description: 'Choose Light, Dark, or System appearance.', keywords: ['dark', 'light', 'system', 'theme'], settingId: 'appearance-theme' },
  { id: 'app-accent', category: 'appearance', title: 'Accent color', description: 'Customize Aria’s highlight color.', keywords: ['color', 'violet', 'blue', 'teal'], settingId: 'appearance-accent' },
  { id: 'app-font', category: 'appearance', title: 'Interface font size', description: 'Scale text readability across the interface.', keywords: ['font', 'text', 'size', 'zoom'], settingId: 'appearance-font-size' },
  { id: 'app-density', category: 'appearance', title: 'Interface density', description: 'Adjust row spacing between compact and spacious.', keywords: ['spacing', 'compact', 'comfortable'], settingId: 'appearance-density' },
  { id: 'app-motion', category: 'appearance', title: 'Animation preferences', description: 'Follow system motion settings or reduce animations.', keywords: ['motion', 'animation', 'accessibility'], settingId: 'appearance-motion' },
  { id: 'per-profile', category: 'personalization', title: 'Personal profile', description: 'Display name and brief personal context.', keywords: ['bio', 'about me', 'profile'], settingId: 'personalization-profile' },
  { id: 'per-instructions', category: 'personalization', title: 'Custom instructions', description: 'Persistent instructions passed to Aria’s primary model.', keywords: ['system prompt', 'instructions', 'rules'], settingId: 'personalization-instructions' },
  { id: 'per-style', category: 'personalization', title: 'Response detail', description: 'Set how much detail Aria aims to provide.', keywords: ['tone', 'concise', 'detailed', 'style'], settingId: 'personalization-style' },
  { id: 'persona-modes', category: 'personalization', title: 'Personality', description: 'Choose an adaptive or custom communication style.', keywords: ['warmth', 'humor', 'personality', 'persona'], settingId: 'persona-modes' },
  { id: 'persona-visual', category: 'personalization', title: 'Adaptive visuals', description: 'Use interactive presentation when helpful.', keywords: ['chart', 'diagram', 'emoji', 'symbols'], settingId: 'persona-adaptiveVisuals' },
  { id: 'persona-learning', category: 'personalization', title: 'Communication memory', description: 'Review and manage learned communication preferences.', keywords: ['memory', 'review', 'learn', 'preferences'], settingId: 'persona-communication-memory' },
  { id: 'per-language', category: 'personalization', title: 'Preferred communication language', description: 'Language Aria uses when responding.', keywords: ['reply language', 'locale'], settingId: 'personalization-language' },
  { id: 'not-desktop', category: 'notifications', title: 'Desktop notifications', description: 'Enable OS notifications when Aria is in the background.', keywords: ['alerts', 'banner', 'os'], settingId: 'notifications-enabled' },
  { id: 'proactive-pulse', category: 'proactive', title: 'Pulse and background work', description: 'Set heartbeat frequency, quiet hours, notifications, and job limits.', keywords: ['agenda', 'automation', 'heartbeat', 'emergency pause'] },
  { id: 'not-task', category: 'notifications', title: 'Task completion notifications', description: 'Notify when a response completes while Aria is unfocused.', keywords: ['done', 'finished'], settingId: 'notifications-task' },
  { id: 'not-bg', category: 'notifications', title: 'Background execution notifications', description: 'Notify on approval requests or background errors.', keywords: ['approval', 'error', 'background'], settingId: 'notifications-background' },
  { id: 'not-sound', category: 'notifications', title: 'Notification sounds', description: 'Play a system notification sound.', keywords: ['audio', 'chime', 'mute'], settingId: 'notifications-sound' },
  { id: 'prov-list', category: 'providers', title: 'Connected AI providers', description: 'Add, edit, test, or remove OpenAI-compatible endpoints and API keys.', keywords: ['api key', 'openai', 'endpoint', 'base url', 'connection'], settingId: 'providers-connections' },
  { id: 'prov-env', category: 'providers', title: 'Import environment settings', description: 'Import provider settings from local environment variables.', keywords: ['env', 'import'], settingId: 'providers-actions' },
  { id: 'mod-primary', category: 'models', title: 'Default chat model', description: 'Select the primary model for chat and Conductor orchestration.', keywords: ['primary', 'default', 'chat model'], settingId: 'models-primary' },
  { id: 'mod-live', category: 'models', title: 'Live Voice model & voice', description: 'Configure the realtime voice model and voice persona.', keywords: ['voice', 'audio', 'live'], settingId: 'models-live' },
  { id: 'mod-available', category: 'models', title: 'Available models & capabilities', description: 'Enable models, inspect capabilities, verify tool calling, and set delegation.', keywords: ['discover', 'verify', 'capabilities', 'reasoning'], settingId: 'models-catalog' },
  { id: 'cond-status', category: 'conductor', title: 'Runtime status & restart', description: 'Inspect Aria Chat API status and restart the managed service.', keywords: ['service', 'restart', 'health'], settingId: 'conductor-status' },
  { id: 'cond-pref', category: 'conductor', title: 'Execution preferences & limits', description: 'Balance cost, latency, quality, spending caps, and cross-connection rules.', keywords: ['budget', 'spending', 'cost', 'latency', 'quality'], settingId: 'conductor-preferences' },
  { id: 'cond-discovery', category: 'conductor', title: 'Tool discovery & programmatic calling', description: 'Choose Aria discovery or verified OpenAI Tool Search and program runner.', keywords: ['tool search', 'programmatic', 'discovery'], settingId: 'conductor-discovery' },
  { id: 'cond-loop', category: 'conductor', title: 'Loop executor configuration', description: 'Configure max iterations, steps, tokens, concurrency, and active time.', keywords: ['loop', 'iterations', 'tokens', 'limits'], settingId: 'conductor-loop' },
  { id: 'cond-activity', category: 'conductor', title: 'Activity visibility', description: 'Expand Conductor activity panels by default in chat.', keywords: ['activity', 'expand', 'timeline'], settingId: 'conductor-activity' },
  { id: 'cond-history', category: 'conductor', title: 'Execution history', description: 'View recent recorded runtime attempts and program executions.', keywords: ['logs', 'runs', 'history'], settingId: 'conductor-history' },
  { id: 'mem-enable', category: 'memory', title: 'Persistent memory', description: 'Enable persistent memory, auto-recall consent, temporary chats, and suggestions.', keywords: ['remember', 'recall', 'temporary'], settingId: 'memory-preferences' },
  { id: 'mem-manage', category: 'memory', title: 'Search, edit & clear memories', description: 'Filter stored memories, inspect sources, export JSON, or clear memory.', keywords: ['clear', 'export', 'search', 'statistics', 'diagnostics'], settingId: 'memory-records' },
  { id: 'int-tools', category: 'integrations', title: 'Available tools', description: 'Enable or disable Conductor tools and review permissions.', keywords: ['tools', 'capabilities', 'disable'], settingId: 'tools' },
  { id: 'int-skills', category: 'integrations', title: 'Agent Skills & connectors', description: 'Import, review, enable, or remove Agent Skills and view connectors.', keywords: ['skills', 'zip', 'bundle', 'connectors'], settingId: 'skills' },
  { id: 'brw-config', category: 'browser', title: 'Internal browser & web search', description: 'Configure Brave/Bing search, AI browsing access, and per-turn limits.', keywords: ['web', 'brave', 'bing', 'search', 'tabs'], settingId: 'web-browser' },
  { id: 'brw-data', category: 'browser', title: 'Browser data & site permissions', description: 'Clear history, clear site data, and revoke website permissions.', keywords: ['cookies', 'history', 'permissions'], settingId: 'web-browser' },
  { id: 'desk-local', category: 'desktop', title: 'Screen & pointer access', description: 'Approve or revoke persistent display access and inspect OS permissions.', keywords: ['screen', 'mouse', 'pointer', 'accessibility', 'display'], settingId: 'execution-runtime' },
  { id: 'desk-virtual', category: 'desktop', title: 'Virtual desktop & limits', description: 'Configure isolated virtual desktop image and action batch limits.', keywords: ['docker', 'virtual desktop', 'computer use'], settingId: 'execution-runtime' },
  { id: 'stor-dirs', category: 'storage', title: 'Authorized directories', description: 'Add or revoke authorized folders.', keywords: ['workspace', 'folder', 'directory'], settingId: 'storage-directories' },
  { id: 'stor-usage', category: 'storage', title: 'Local storage', description: 'Review local storage usage and open the data folder.', keywords: ['disk', 'storage', 'location'], settingId: 'storage-usage' },
  { id: 'priv-sec', category: 'privacy', title: 'Credential storage & permissions', description: 'Review credential storage and operating system permissions.', keywords: ['keychain', 'encryption', 'permissions'], settingId: 'privacy-security' },
  { id: 'stor-knowledge', category: 'storage', title: 'Knowledge libraries & embeddings', description: 'Manage document collections and local or remote embeddings.', keywords: ['documents', 'rag', 'embeddings', 'index'], settingId: 'knowledge' },
  { id: 'adv-diag', category: 'advanced', title: 'Diagnostics & logging', description: 'Export redacted diagnostics, set the log level, or open the legacy workspace.', keywords: ['logs', 'legacy', 'devtools', 'export'], settingId: 'execution-runtime' },
  { id: 'abt-info', category: 'about', title: 'Version, updates & licenses', description: 'Check for updates, change release channel, and read licenses.', keywords: ['update', 'version', 'license', 'mit', 'github', 'release notes'], settingId: 'updates' },
];

export function resolveSettingsHash(hash: string): { category: SettingsCategoryId; settingId?: string } | null {
  switch (hash) {
    case '#ai-models':
      return { category: 'models', settingId: 'models-primary' };
    case '#web-browser':
      return { category: 'browser', settingId: 'web-browser' };
    case '#tools':
      return { category: 'integrations', settingId: 'tools' };
    case '#skills':
      return { category: 'integrations', settingId: 'skills' };
    case '#memory':
      return { category: 'memory', settingId: 'memory-preferences' };
    default:
      return null;
  }
}

export function getCategoryMeta(id: SettingsCategoryId): SettingsCategoryMeta {
  return settingsCategories.find((item) => item.id === id) ?? settingsCategories[0];
}
