import { create } from 'zustand';
import type { BrowserCommand, BrowserState } from '@aria/shared';
import { desktop, errorMessage } from '../services/desktop';
import { notify } from './uiStore';

export type BrowserMode = 'chat' | 'split' | 'browser';
export const useBrowserStore = create<{ mode: BrowserMode; state: BrowserState }>(() => ({
  mode: 'chat',
  state: { tabs: [], selected: null, history: [], bookmarks: [], permissions: [] },
}));

export function setBrowserMode(mode: BrowserMode) {
  useBrowserStore.setState({ mode });
}
export function connectBrowser() {
  const bridge = window.aria;
  if (!bridge?.onBrowserState || !bridge.browserState) return;
  let active = true;
  let updated = false;
  const read = (state: BrowserState) => {
    if (!active) return;
    const previous = useBrowserStore.getState();
    const aiOpened = state.tabs.some(
      (tab) => tab.profile === 'ai' && !previous.state.tabs.some(({ id }) => id === tab.id),
    );
    useBrowserStore.setState({
      state,
      ...(updated && previous.mode === 'chat' && aiOpened && { mode: 'split' }),
    });
    updated = true;
  };
  const unsubscribe = bridge.onBrowserState(read);
  void bridge
    .browserState()
    .then((state) => {
      if (!updated) read(state);
    })
    .catch(() => undefined);
  return () => {
    active = false;
    unsubscribe();
  };
}
export async function browserCommand(command: BrowserCommand) {
  try {
    return await desktop().browserCommand(command);
  } catch (error) {
    notify(errorMessage(error), true);
  }
}
export async function openResearchSource(url: string) {
  try {
    await desktop().browserCommand({ kind: 'open', input: url });
    if (useBrowserStore.getState().mode === 'chat') setBrowserMode('split');
  } catch (error) {
    notify(errorMessage(error), true);
  }
}
