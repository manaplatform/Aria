import { beforeEach, expect, it } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { TooltipProvider } from '../src/components/ui';
import SettingsView from '../src/components/settings/SettingsView';
import { emptyData } from '../src/services/desktop';
import { useWorkspaceStore } from '../src/stores/workspaceStore';

beforeEach(() => {
  useWorkspaceStore.setState({ data: emptyData(), ready: true });
});

function renderSettings(path = '/settings') {
  return render(<TooltipProvider><MemoryRouter initialEntries={[path]}><Routes><Route path="/settings" element={<SettingsView />} /><Route path="/settings/:category" element={<SettingsView />} /></Routes></MemoryRouter></TooltipProvider>);
}

it('navigates categories, persists the selection, and searches for a setting', async () => {
  const user = userEvent.setup();
  renderSettings();
  const navigation = screen.getByRole('navigation', { name: 'Settings categories' });
  await user.click(within(navigation).getByRole('button', { name: 'Appearance' }));
  expect(await screen.findByRole('heading', { name: 'Appearance' })).toBeInTheDocument();
  await waitFor(() => expect(useWorkspaceStore.getState().data.preferences.settingsCategory).toBe('appearance'));
  await user.click(screen.getByRole('button', { name: /^Light$/ }));
  expect(useWorkspaceStore.getState().data.preferences.theme).toBe('light');
  const search = screen.getByRole('searchbox', { name: 'Search settings' });
  await user.type(search, 'startup behavior');
  await user.click(within(screen.getByRole('listbox', { name: 'Matching settings' })).getAllByRole('option')[0]);
  expect(await screen.findByRole('heading', { name: 'General' })).toBeInTheDocument();
  expect(await screen.findByRole('combobox', { name: 'Startup behavior' })).toBeInTheDocument();
});

it('opens legacy deep links in the corresponding category after lazy loading', async () => {
  renderSettings('/settings#web-browser');
  expect(await screen.findByRole('heading', { name: /^Browser$/ })).toBeInTheDocument();
  expect(useWorkspaceStore.getState().data.preferences.settingsCategory).toBe('browser');
});

it('moves focus through categories with the keyboard', async () => {
  const user = userEvent.setup();
  renderSettings();
  const navigation = screen.getByRole('navigation', { name: 'Settings categories' });
  const general = within(navigation).getByRole('button', { name: 'General' });
  general.focus();
  await user.keyboard('{ArrowDown}');
  expect(within(navigation).getByRole('button', { name: 'Appearance' })).toHaveFocus();
  await user.keyboard('{End}');
  expect(within(navigation).getByRole('button', { name: 'About Aria' })).toHaveFocus();
});

it('ignores provider discovery that finishes after leaving the provider page', async () => {
  const { vi } = await import('vitest');
  const { emptyRegistryPolicy } = await import('@aria/shared');
  const { useProviderStore } = await import('../src/stores/providerStore');
  let finish!: (value: unknown[]) => void;
  const connectionId = '10000000-0000-4000-8000-000000000001';
  const settings = { ...emptyRegistryPolicy, revision: 'initial', encryptionAvailable: true,
    environmentImportAvailable: false, connections: [{ id: connectionId, name: 'Fixture',
      baseUrl: 'https://compatible.example/v1', keyConfigured: false, models: [], webSearch: false, verified: [] }] };
  useProviderStore.setState({ settings, loading: false, error: '', catalogs: {} });
  window.aria = { discoverModels: vi.fn(() => new Promise((resolve) => { finish = resolve; })) } as unknown as NonNullable<Window['aria']>;
  const user = userEvent.setup();
  renderSettings('/settings/providers');
  await user.click(await screen.findByRole('button', { name: 'Discover models' }));
  await user.click(within(screen.getByRole('navigation', { name: 'Settings categories' })).getByRole('button', { name: 'Models' }));
  await act(async () => finish([{ id: 'stale', capabilities: ['chat', 'tools'], source: 'provider' }]));
  await waitFor(() => expect(useProviderStore.getState().catalogs[connectionId]?.models).toBeUndefined());
  delete window.aria;
});

it('searches available tools and opens the matching tool after it loads', async () => {
  const { vi } = await import('vitest');
  const { useProviderStore } = await import('../src/stores/providerStore');
  const tools = { discovery: 'aria', nativeVerified: false, skills: [], tools: [{ id: 'example.tool', namespace: 'example', name: 'Example utility', description: 'An example tool', version: '1', provenance: 'builtin', effect: 'read', permission: 'local', available: true }] };
  useProviderStore.setState({ settings: null, loading: false, error: '', catalogs: {} });
  window.aria = { registrySettings: vi.fn().mockRejectedValue(new Error('Unavailable')), toolSettings: vi.fn().mockResolvedValue(tools) } as unknown as NonNullable<Window['aria']>;
  const user = userEvent.setup();
  renderSettings();
  await user.type(screen.getByRole('searchbox', { name: 'Search settings' }), 'Example utility');
  const result = await screen.findByRole('option', { name: /Example utility/ });
  await user.click(result);
  expect(await screen.findByText('Example utility')).toBeInTheDocument();
  expect(document.getElementById('settings-tool-example.tool')).not.toBeNull();
  delete window.aria;
});
