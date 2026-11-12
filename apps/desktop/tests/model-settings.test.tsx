import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  emptyRegistryPolicy,
  modelReference,
  type DesktopBridge,
  type DiscoveredModel,
  type RegistrySettings,
} from '@aria/shared';
import { ModelSettings } from '../src/components/settings/ModelSettings';
import { useChatStore } from '../src/stores/chatStore';
import { useProviderStore } from '../src/stores/providerStore';

const connectionId = '10000000-0000-4000-8000-000000000001';
const settings: RegistrySettings = {
  ...emptyRegistryPolicy,
  revision: 'original',
  encryptionAvailable: true,
  environmentImportAvailable: false,
  connections: [
    {
      id: connectionId,
      name: 'Fixture',
      baseUrl: 'https://compatible.example/v1',
      keyConfigured: false,
      models: [],
      webSearch: false,
      verified: [],
    },
  ],
};
beforeEach(() => {
  useProviderStore.setState({ settings: null, loading: false, error: '' });
  useChatStore.setState({ status: { state: 'ready', configured: false, model: '' } });
  window.aria = {
    registrySettings: vi.fn().mockResolvedValue(settings),
    discoverModels: vi
      .fn()
      .mockResolvedValue([
        { id: 'fetched-chat', capabilities: ['chat', 'tools'], source: 'provider' },
      ]),
    saveRegistry: vi.fn().mockResolvedValue({ ...settings, revision: 'saved' }),
    verifyModel: vi.fn().mockResolvedValue(undefined),
  } as unknown as DesktopBridge;
});
afterEach(() => {
  delete window.aria;
});

it('selects only enabled discovered primary models and sends draft credentials only through the bridge', async () => {
  const user = userEvent.setup();
  render(<ModelSettings />);
  await user.type(await screen.findByLabelText('API key'), 'unsaved-secret');
  await user.click(screen.getByRole('button', { name: 'Discover models' }));
  expect(window.aria!.discoverModels).toHaveBeenCalledWith(
    expect.objectContaining({ apiKey: 'unsaved-secret' }),
  );
  expect(screen.queryByRole('option', { name: 'Fixture · fetched-chat' })).toBeNull();
  await user.click(await screen.findByRole('checkbox', { name: 'Enable fetched-chat' }));
  await user.selectOptions(
    screen.getByRole('combobox', { name: 'Primary model' }),
    modelReference(connectionId, 'fetched-chat'),
  );
  await user.click(screen.getByRole('button', { name: 'Save AI Models' }));
  await waitFor(() =>
    expect(window.aria!.saveRegistry).toHaveBeenCalledWith(
      expect.objectContaining({
        primary: modelReference(connectionId, 'fetched-chat'),
        connections: [
          expect.objectContaining({
            apiKey: 'unsaved-secret',
            models: [expect.objectContaining({ id: 'fetched-chat', enabled: true })],
          }),
        ],
      }),
    ),
  );
  expect(screen.getByLabelText('API key')).toHaveValue('');
});
it('invalidates discovery when connection inputs change and ignores a late response', async () => {
  let complete!: (models: DiscoveredModel[]) => void;
  window.aria!.discoverModels = vi.fn(
    () =>
      new Promise<DiscoveredModel[]>((resolve) => {
        complete = resolve;
      }),
  );
  const user = userEvent.setup();
  render(<ModelSettings />);
  await user.type(await screen.findByLabelText('API key'), 'old-key');
  await user.click(screen.getByRole('button', { name: 'Discover models' }));
  await user.type(screen.getByLabelText('Provider endpoint'), '/different');
  await act(async () =>
    complete([{ id: 'stale-model', capabilities: ['chat', 'tools'], source: 'provider' }]),
  );
  expect(screen.queryByText('stale-model')).toBeNull();
});
it('requires declarations and a successful function-call probe before an unknown model can become primary', async () => {
  window.aria!.discoverModels = vi
    .fn()
    .mockResolvedValue([{ id: 'unknown', capabilities: [], source: 'unknown' }]);
  const user = userEvent.setup();
  render(<ModelSettings />);
  await user.click(await screen.findByRole('button', { name: 'Discover models' }));
  await user.click(await screen.findByRole('checkbox', { name: 'Enable unknown' }));
  await user.click(screen.getByRole('button', { name: 'Capabilities' }));
  await user.click(screen.getByRole('checkbox', { name: 'Text streaming' }));
  await user.click(screen.getByRole('checkbox', { name: 'Function calling' }));
  expect(screen.queryByRole('option', { name: 'Fixture · unknown' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Verify for primary' }));
  expect(await screen.findByRole('option', { name: 'Fixture · unknown' })).toBeVisible();
  expect(window.aria!.verifyModel).toHaveBeenCalledWith(
    expect.objectContaining({ id: connectionId }),
    'unknown',
  );
});
