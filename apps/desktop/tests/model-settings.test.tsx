import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DesktopBridge, ProviderModel, ProviderSettings } from '@aria/shared';
import { ModelSettings } from '../src/components/settings/ModelSettings';
import { ModelSelect } from '../src/components/settings/ModelSelect';
import { useChatStore } from '../src/stores/chatStore';
import { useLiveVoiceStore } from '../src/stores/liveVoiceStore';
import { useWorkspaceStore } from '../src/stores/workspaceStore';
import { emptyData } from '../src/services/desktop';
const settings: ProviderSettings = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  model: '',
  models: { chat: '', image: '', speech: '', transcription: '', live: '' },
  systemPrompt: '',
  keyConfigured: false,
  encryptionAvailable: true,
  sources: { baseUrl: 'default', model: 'default', apiKey: 'default', systemPrompt: 'default' },
};
beforeEach(() => {
  useWorkspaceStore.setState({ data: emptyData(), ready: true, saveError: null });
  useChatStore.setState({ status: { state: 'ready', configured: false, model: '' } });
  useLiveVoiceStore.setState({ phase: 'idle' });
  window.aria = {
    providerSettings: vi.fn().mockResolvedValue(settings),
    providerModels: vi.fn().mockResolvedValue([{ id: 'fetched-chat', modes: ['chat'] }]),
    saveProviderSettings: vi.fn().mockResolvedValue(settings),
    save: vi.fn().mockResolvedValue(undefined),
  } as unknown as DesktopBridge;
});
afterEach(() => {
  delete window.aria;
});
it('uses only registered providers and fetched select options, and discovers using a draft key', async () => {
  const user = userEvent.setup();
  render(<ModelSettings />);
  const provider = await screen.findByRole('combobox', { name: 'Provider' });
  expect(provider.querySelectorAll('option')).toHaveLength(1);
  expect(screen.queryByPlaceholderText(/model ID/)).toBeNull();
  expect(screen.getByRole('combobox', { name: 'Chat model' })).toBeDisabled();
  await user.type(screen.getByLabelText('API key', { exact: true }), 'unsaved-secret');
  await user.click(screen.getByRole('button', { name: 'Load models' }));
  await waitFor(() => expect(screen.getByRole('combobox', { name: 'Chat model' })).toBeEnabled());
  expect(window.aria!.providerModels).toHaveBeenCalledWith({
    provider: 'openai',
    baseUrl: settings.baseUrl,
    apiKey: 'unsaved-secret',
    removeKey: false,
  });
  await user.selectOptions(screen.getByRole('combobox', { name: 'Chat model' }), 'fetched-chat');
  await user.click(screen.getByRole('button', { name: 'Save & reconnect' }));
  await waitFor(() =>
    expect(window.aria!.saveProviderSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'openai',
        apiKey: 'unsaved-secret',
        models: expect.objectContaining({ chat: 'fetched-chat' }),
      }),
    ),
  );
  expect(screen.getByLabelText('API key', { exact: true })).toHaveValue('');
});
it('invalidates discovery when connection inputs change and ignores a late response', async () => {
  let complete!: (models: ProviderModel[]) => void;
  window.aria!.providerModels = vi.fn(
    () =>
      new Promise<ProviderModel[]>((resolve) => {
        complete = resolve;
      }),
  );
  const user = userEvent.setup();
  render(<ModelSettings />);
  await screen.findByLabelText('API key', { exact: true });
  await user.type(screen.getByLabelText('API key', { exact: true }), 'old-key');
  await user.click(screen.getByRole('button', { name: 'Load models' }));
  await user.type(screen.getByLabelText('Provider endpoint', { exact: true }), '/different');
  await act(async () => complete([{ id: 'stale-model', modes: ['chat'] }]));
  expect(screen.queryByRole('option', { name: 'stale-model' })).toBeNull();
  expect(screen.getByRole('combobox', { name: 'Chat model' })).toBeDisabled();
});
it('groups compatible and unclassified models while showing unavailable selections explicitly', () => {
  render(
    <ModelSelect
      mode="image"
      models={[
        { id: 'image-from-api', modes: ['image'] },
        { id: 'chat-from-api', modes: ['chat'] },
        { id: 'custom-model', modes: [] },
      ]}
      value="removed-model"
      onChange={() => undefined}
    />,
  );
  expect(screen.getByRole('option', { name: 'removed-model · unavailable' })).toBeDisabled();
  expect(screen.getByRole('option', { name: 'custom-model' })).toBeInTheDocument();
  expect(screen.queryByRole('option', { name: 'chat-from-api' })).toBeNull();
});
