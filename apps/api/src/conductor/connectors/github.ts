import { z } from 'zod';
import {
  connectorCatalog, desktopArtifactSchema, executionLimits, githubOperation, githubResult,
  githubPublicContentResult, githubPublicFileOperation, githubPublicFilesOperation, githubPublicOperation,
  githubPublicOperations, githubPublicReadmeOperation, githubPublicSearchLimit, githubPublicSearchOperation,
  githubPublicSearchResult, type ConductorSource,
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

const publicDescriptions = {
  [githubPublicSearchOperation]: ['Search public GitHub repositories', 'Find public GitHub repositories by name, owner/name, or keywords. Returns links and metadata for discovery; use the README and source tools to explain a project.'],
  [githubPublicReadmeOperation]: ['Read public GitHub README', 'Read a public GitHub repository’s README from a verified default-branch commit. Use this to explain what a project is and how to get started. Supply owner/name.'],
  [githubPublicFilesOperation]: ['List public GitHub files', 'List the root or a directory of a public GitHub repository at a verified default-branch commit. Use this to find source, configuration, or documentation files.'],
  [githubPublicFileOperation]: ['Read public GitHub file', 'Read an excerpt from an exact text or source file path in a public GitHub repository at a verified default-branch commit. Use this to check implementation details.'],
} as const;
const githubPath = (value: string) => value.split('/').map(encodeURIComponent).join('/');

export function registerConnectorTools(registry: ToolRegistry) {
  for (const operation of githubPublicOperation.options) {
    const [name, description] = publicDescriptions[operation];
    const search = operation === githubPublicSearchOperation;
    const input = githubPublicOperations[operation] as z.ZodType<Record<string, unknown>>;
    const resultSchema = search ? githubPublicSearchResult : githubPublicContentResult;
    registry.register({
      id: operation, version: '1', provenance: 'connector', name, description,
      input,
      outputSchema: z.strictObject({ data: resultSchema, sources: z.array(sourceSchema).max(githubPublicSearchLimit) }),
      capability: operation, output: 'data', effect: 'read',
      permission: search ? 'Signed-in GitHub account. Public repository metadata only.' : 'Signed-in GitHub account. Public repository contents only.',
      dependency: 'local', connector: 'github', connectorScope: 'account', requiredModelCapabilities: [],
      timeoutMs: executionLimits.operationMs, deferred: true, modes: ['direct'], programmaticEligible: false,
      artifacts: false, citations: true, settingsSection: 'Connectors',
      tags: ['github', 'api', 'public', 'repository', search ? 'lookup' : 'source'],
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
          operation, stepId: step.id, callId, input,
          primary: { connectionId: primary.connection.id, model: primary.id, endpoint: primary.connection.baseUrl },
        }, signal, (event) => { if (event === 'dispatch') browserProgress('network'); });
        const data = resultSchema.parse(result.data);
        const common = { retrievedAt: new Date().toISOString(), provenance: 'connector' } as const;
        let sources: ConductorSource[];
        if ('results' in data) {
          sources = data.results.map((repo) => sourceSchema.parse({
            ...common, url: 'https://github.com/' + githubPath(repo.name), title: repo.name, evidenceStatus: 'metadata',
            ...(repo.description && { excerpt: repo.description }),
          }));
        } else {
          const root = 'https://github.com/' + githubPath(data.repository);
          const url = `${root}/${data.kind === 'file' ? 'blob' : 'tree'}/${data.commit}${data.path ? '/' + githubPath(data.path) : ''}`;
          sources = [sourceSchema.parse({ ...common, url: url.length <= 2000 ? url : `${root}/tree/${data.commit}`,
            title: `${data.repository}${data.path ? '/' + data.path : ' files'}`.slice(0, 300),
            evidenceStatus: data.partial ? 'partial' : 'inspected' })];
        }
        context.research.observeSources(sources, step.id);
        return { data, sources };
      },
    });
  }
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
