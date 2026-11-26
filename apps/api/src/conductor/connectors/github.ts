import { z } from 'zod';
import {
  connectorCatalog, desktopArtifactSchema, executionLimits, githubOperation, githubResult,
  githubPublicSearchInput, githubPublicSearchLimit, githubPublicSearchOperation, githubPublicSearchResult,
  runtimeResultSchema, sourceSchema, stepId,
} from '@aria/shared';
import { ToolError } from '../capability-host';
import type { ToolRegistry } from '../tool-registry';

const outputSchema = z.strictObject({
  data: githubResult,
  sources: z.array(sourceSchema).max(1).optional(),
  managedArtifact: desktopArtifactSchema.optional(),
  privateContent: z.boolean().optional(),
  commandProblem: runtimeResultSchema.shape.commandProblem,
});

export function registerConnectorTools(registry: ToolRegistry) {
  registry.register({
    id: githubPublicSearchOperation, version: '1', provenance: 'connector', name: 'Search public GitHub repositories',
    description: 'Find public GitHub repositories by name, owner/name, or keywords using the GitHub API. Use for GitHub repository lookups. Requires a signed-in GitHub account and works before any repositories are installed or approved. Returns public repository links and metadata.',
    input: githubPublicSearchInput,
    outputSchema: z.strictObject({ data: githubPublicSearchResult, sources: z.array(sourceSchema).max(githubPublicSearchLimit) }),
    capability: githubPublicSearchOperation, output: 'data', effect: 'read',
    permission: 'Signed-in GitHub account. Public repository metadata only.',
    dependency: 'local', connector: 'github', connectorScope: 'account', requiredModelCapabilities: [],
    timeoutMs: executionLimits.operationMs, deferred: true, modes: ['direct'], programmaticEligible: false,
    artifacts: false, citations: true, settingsSection: 'Connectors', budget: 'searches',
    tags: ['github', 'api', 'search', 'public', 'repository', 'lookup'],
    repeatable: false, parallelRead: false,
    available: (context) => Boolean(context.runtime && !context.proactive && !context.privateContent &&
      !context.connectorPrivate && !context.memoryPrivate && !context.memoryBlocked &&
      !context.native?.active.shell && !context.native?.active.search && !context.computer),
    normalize: (args) => ({ args }),
    execute: async (input, { context, step, callId, signal, browserProgress }) => {
      if (!context.runtime) throw new ToolError('PERMISSION_DENIED', 'Open the managed Aria desktop to use GitHub.');
      const { primary } = context.registry;
      const result = await registry.host.runtime({
        ...context.runtime, type: 'runtime', revision: registry.host.current.revision,
        operation: githubPublicSearchOperation, stepId: step.id, callId, input,
        primary: { connectionId: primary.connection.id, model: primary.id, endpoint: primary.connection.baseUrl },
      }, signal, (event) => { if (event === 'dispatch') browserProgress('network'); });
      const data = githubPublicSearchResult.parse(result.data);
      const retrievedAt = new Date().toISOString();
      const sources = data.results.map((repo) => sourceSchema.parse({
        url: 'https://github.com/' + repo.name.split('/').map(encodeURIComponent).join('/'),
        title: repo.name, provenance: 'connector', evidenceStatus: 'metadata', retrievedAt,
        ...(repo.description && { excerpt: repo.description }),
      }));
      context.research.observeSources(sources, step.id);
      return { data, sources };
    },
  });
  for (const operation of githubOperation.options) {
    const connector = connectorCatalog[0];
    const descriptor = connector.capabilities[operation];
    const write = descriptor.access === 'write';
    const artifact = operation === 'github.get_release_asset';
    const input = descriptor.input.extend({ dependsOn: z.array(stepId).max(20).optional() }) as z.ZodType<Record<string, unknown>>;
    registry.register({
      id: operation, version: '1', provenance: 'connector', name: operation.slice(7).replaceAll('_', ' '),
      description: descriptor.description, input, outputSchema,
      capability: operation, output: artifact ? 'file' : 'data',
      effect: write ? 'consequential' : 'read',
      permission: 'Current GitHub installation and repository scope. ' +
        descriptor.permission + ' ' + descriptor.access + (write ? ' and Aria write authorization.' : '.'),
      dependency: 'local', connector: connector.id, hostJournal: write, requiredModelCapabilities: [],
      timeoutMs: executionLimits.operationMs, deferred: true, modes: ['direct'],
      programmaticEligible: false, artifacts: artifact, citations: true, settingsSection: 'Connectors',
      repeatable: !write, parallelRead: false,
      available: (context) => Boolean(context.runtime && !context.memoryPrivate && !context.memoryBlocked &&
        !context.native?.active.shell && !context.native?.active.search && !context.computer &&
        (!context.privateContent || context.connectorPrivate) &&
        (!context.proactive || context.proactive.scope.connector?.operations.includes(operation))),
      normalize: ({ dependsOn: _dependsOn, ...args }) => ({ args }),
      execute: async ({ dependsOn: _dependsOn, ...args }, { context, step, callId, signal, approval, browserProgress }) => {
        if (!context.runtime) throw new ToolError('PERMISSION_DENIED', 'Open the managed Aria desktop to use GitHub.');
        const { primary } = context.registry;
        const result = await registry.host.runtime({
          ...context.runtime, type: 'runtime', revision: registry.host.current.revision, operation, stepId: step.id, callId,
          input: args, primary: { connectionId: primary.connection.id, model: primary.id, endpoint: primary.connection.baseUrl },
        }, signal, (event) => {
          if (event === 'approval') approval();
          else browserProgress('network');
        });
        const data = githubResult.parse(result.data);
        if (result.privateContent) context.connectorPrivate = true;
        return {
          data,
          sources: data.url ? [{ url: data.url, title: data.repository ?? 'GitHub', provenance: 'connector',
            retrievedAt: new Date().toISOString(), evidenceStatus: data.verified ? 'inspected' : 'partial' }] : undefined,
          privateContent: result.privateContent, managedArtifact: result.artifact, commandProblem: result.commandProblem,
        };
      },
    });
  }
}
