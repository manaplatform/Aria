import { z } from 'zod';
import { personaOverridesSchema } from './persona.js';

export const settingsCategoryIds = [
  'general',
  'appearance',
  'personalization',
  'notifications',
  'providers',
  'models',
  'conductor',
  'proactive',
  'memory',
  'integrations',
  'connectors',
  'browser',
  'weather',
  'desktop',
  'storage',
  'privacy',
  'shortcuts',
  'advanced',
  'diagnostics',
  'about',
] as const;
export const settingsCategorySchema = z.enum(settingsCategoryIds);
export type SettingsCategoryId = z.infer<typeof settingsCategorySchema>;

export const accentColors = ['violet', 'blue', 'teal', 'emerald', 'amber', 'rose'] as const;
export const accentColorSchema = z.enum(accentColors);
export type AccentColor = z.infer<typeof accentColorSchema>;

export const fontSizes = ['small', 'default', 'large'] as const;
export const fontSizeSchema = z.enum(fontSizes);
export type FontSize = z.infer<typeof fontSizeSchema>;

export const interfaceDensities = ['compact', 'comfortable', 'spacious'] as const;
export const interfaceDensitySchema = z.enum(interfaceDensities);
export type InterfaceDensity = z.infer<typeof interfaceDensitySchema>;

export const motionPreferences = ['system', 'reduced', 'full'] as const;
export const motionPreferenceSchema = z.enum(motionPreferences);
export type MotionPreference = z.infer<typeof motionPreferenceSchema>;

export const startupBehaviors = ['restore-last', 'new-chat'] as const;
export const startupBehaviorSchema = z.enum(startupBehaviors);
export type StartupBehavior = z.infer<typeof startupBehaviorSchema>;

export const responseStyles = ['balanced', 'concise', 'detailed'] as const;
export const responseStyleSchema = z.enum(responseStyles);
export type ResponseStyle = z.infer<typeof responseStyleSchema>;

export const logLevels = ['error', 'warn', 'info'] as const;
export const logLevelSchema = z.enum(logLevels);
export type LogLevel = z.infer<typeof logLevelSchema>;

export const notificationPreferencesSchema = z.strictObject({
  enabled: z.boolean(),
  taskCompletion: z.boolean(),
  backgroundExecution: z.boolean(),
  sound: z.boolean(),
});
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;

export const defaultNotificationPreferences: NotificationPreferences = {
  enabled: false,
  taskCompletion: true,
  backgroundExecution: true,
  sound: true,
};

export const customizableShortcutIds = [
  'newChat',
  'searchConversations',
  'focusComposer',
  'openSettings',
  'toggleSidebar',
  'toggleBrowser',
] as const;
export type CustomizableShortcutId = (typeof customizableShortcutIds)[number];
export const shortcutChordSchema = z
  .string()
  .trim()
  .min(3)
  .max(40)
  .regex(/^(?:Mod\+)?(?:Ctrl\+)?(?:Alt\+)?(?:Shift\+)?(?:[A-Z0-9,./;'\[\]\\`-]|F[1-9]|F1[0-2])$/);

export const shortcutsMapSchema = z
  .strictObject({
    newChat: shortcutChordSchema.optional(),
    searchConversations: shortcutChordSchema.optional(),
    focusComposer: shortcutChordSchema.optional(),
    openSettings: shortcutChordSchema.optional(),
    toggleSidebar: shortcutChordSchema.optional(),
    toggleBrowser: shortcutChordSchema.optional(),
  })
  .strict();
export type ShortcutsMap = Partial<Record<CustomizableShortcutId, string>>;

export const defaultShortcuts: Record<CustomizableShortcutId, string> = {
  newChat: 'Mod+Shift+O',
  searchConversations: 'Mod+K',
  focusComposer: 'Mod+L',
  openSettings: 'Mod+,',
  toggleSidebar: 'Mod+B',
  toggleBrowser: 'Mod+Shift+B',
};

export const shortcutDescriptions: Record<
  CustomizableShortcutId,
  { label: string; description: string }
> = {
  newChat: { label: 'New chat', description: 'Start a new ordinary conversation.' },
  searchConversations: {
    label: 'Search conversations',
    description: 'Open the sidebar and focus conversation search.',
  },
  focusComposer: {
    label: 'Focus message composer',
    description: 'Return to chat and focus the message input.',
  },
  openSettings: {
    label: 'Open settings',
    description: 'Open or return to the Settings workspace.',
  },
  toggleSidebar: {
    label: 'Toggle navigation sidebar',
    description: 'Collapse or expand the left conversation sidebar.',
  },
  toggleBrowser: {
    label: 'Toggle split browser',
    description: 'Switch between chat-only and split browser view.',
  },
};

const reservedChords = new Set([
  'Mod+C',
  'Mod+V',
  'Mod+X',
  'Mod+A',
  'Mod+Z',
  'Mod+Shift+Z',
  'Mod+Y',
  'Mod+W',
  'Mod+Q',
  'Mod+R',
  'Mod+F',
  'Mod+M',
  'Mod+H',
]);

export function resolveShortcuts(custom?: ShortcutsMap): Record<CustomizableShortcutId, string> {
  return { ...defaultShortcuts, ...custom };
}

export function normalizeShortcutKey(key: string): string | null {
  if (/^[a-z]$/i.test(key)) return key.toUpperCase();
  if (/^[0-9]$/.test(key)) return key;
  if (/^F(?:[1-9]|1[0-2])$/i.test(key)) return key.toUpperCase();
  if ([',', '.', '/', ';', "'", '[', ']', '\\', '`', '-'].includes(key)) return key;
  return null;
}

export function formatShortcutChord(chord: string, platform = 'darwin'): string {
  const parts = chord.split('+');
  const modLabel = platform === 'darwin' ? '⌘' : 'Ctrl';
  const altLabel = platform === 'darwin' ? '⌥' : 'Alt';
  const shiftLabel = platform === 'darwin' ? '⇧' : 'Shift';
  return parts
    .map((part) => {
      if (part === 'Mod') return modLabel;
      if (part === 'Alt') return altLabel;
      if (part === 'Shift') return shiftLabel;
      return part;
    })
    .join(' ');
}

export function eventMatchesShortcut(
  event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean },
  chord: string,
  platform = 'darwin',
): boolean {
  const parts = chord.split('+');
  const expectedKey = parts.at(-1);
  const actualKey = normalizeShortcutKey(event.key);
  if (!expectedKey || actualKey !== expectedKey) return false;
  const wantsMod = parts.includes('Mod');
  const wantsCtrl = parts.includes('Ctrl');
  const wantsAlt = parts.includes('Alt');
  const wantsShift = parts.includes('Shift');
  const modActive = platform === 'darwin' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (wantsMod && !modActive) return false;
  if (!wantsMod && (event.metaKey || (!wantsCtrl && event.ctrlKey))) return false;
  if (wantsCtrl && !event.ctrlKey) return false;
  if (event.altKey !== wantsAlt) return false;
  if (event.shiftKey !== wantsShift) return false;
  return true;
}

export function eventToShortcutChord(
  event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean },
  platform = 'darwin',
): string | null {
  const key = normalizeShortcutKey(event.key);
  if (!key) return null;
  const modPressed = platform === 'darwin' ? event.metaKey : event.ctrlKey;
  if (!modPressed && !/^F(?:[1-9]|1[0-2])$/.test(key)) return null;
  const parts: string[] = [];
  if (modPressed) parts.push('Mod');
  else if (event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  parts.push(key);
  const candidate = parts.join('+');
  return shortcutChordSchema.safeParse(candidate).success ? candidate : null;
}

export function detectShortcutConflict(
  target: CustomizableShortcutId,
  chord: string,
  current: Record<CustomizableShortcutId, string>,
): { conflictWith?: string } {
  if (reservedChords.has(chord)) {
    return { conflictWith: 'System or text editing shortcut' };
  }
  for (const id of customizableShortcutIds) {
    if (id !== target && current[id] === chord) {
      return { conflictWith: shortcutDescriptions[id].label };
    }
  }
  return {};
}

export const userPersonalizationSchema = z
  .strictObject({
    profileName: z.string().trim().min(1).max(80).optional(),
    profileBio: z.string().trim().max(160).optional(),
    responseStyle: responseStyleSchema.optional(),
    persona: personaOverridesSchema.optional(),
    communicationLanguage: z.string().trim().max(60).optional(),
  })
  .strict();
export type UserPersonalization = z.infer<typeof userPersonalizationSchema>;

export const systemBehaviorInputSchema = z
  .strictObject({
    openAtLogin: z.boolean().optional(),
    minimizeToTray: z.boolean().optional(),
  })
  .strict();

export interface SystemBehaviorState {
  openAtLogin: boolean;
  loginSupported: boolean;
  loginReason?: string;
  minimizeToTray: boolean;
  traySupported: boolean;
}

export interface StorageAreaUsage {
  id: string;
  label: string;
  bytes: number;
  detail?: string;
}

export interface StorageInfo {
  dataDir: string;
  totalBytes: number;
  areas: StorageAreaUsage[];
}

export interface OsPermissionsStatus {
  platform: string;
  microphone: string;
  screen: string;
  notificationsSupported: boolean;
}

export interface AboutInfo {
  version: string;
  electronVersion: string;
  nodeVersion: string;
  platform: string;
  arch: string;
  repositoryUrl: string;
  releaseNotesUrl: string;
  mitLicense: string;
  thirdPartyNotices: string;
  thirdPartyInventory: { name: string; version: string; license: string | null }[];
}

export const resetConfigurationScopeSchema = z.enum(['preferences', 'web', 'tools']);
export type ResetConfigurationScope = z.infer<typeof resetConfigurationScopeSchema>;
