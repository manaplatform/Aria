import type { RuntimeWeb } from '@aria/shared';
import { braveAdapter, type SearchAdapter } from './brave.adapter';

const configuredAdapters = [
  (policy: RuntimeWeb) =>
    policy.braveEnabled && policy.braveKey ? braveAdapter(policy.braveKey) : undefined,
];

export function searchRegistry(policy: RuntimeWeb): Map<string, SearchAdapter> {
  const adapters = new Map<string, SearchAdapter>();
  if (!policy.enabled) return adapters;
  for (const configure of configuredAdapters) {
    const adapter = configure(policy);
    if (adapter) adapters.set(adapter.id, adapter);
  }
  return adapters;
}
