import { z } from 'zod';

export const githubAccountId = z.string().uuid();
export const githubRepositoryId = z.number().int().positive().safe();
export const githubRepositoryName = z.string().regex(/^[\w.-]{1,100}\/[\w.-]{1,100}$/).max(201);
const repo = { repository: z.union([githubRepositoryId, githubRepositoryName]) };
const page = { page: z.number().int().min(1).max(100).optional() };
const number = z.number().int().positive().safe();
const sha = z.string().regex(/^[a-f0-9]{40}$/i);
const ref = z.string().min(1).max(220).regex(/^(?![./])(?!.*(?:\.\.|@\{|\/\/))[\w./-]+$/);
const path = z.string().min(1).max(500).refine((value) =>
  value.split('/').every((segment) => segment && segment !== '.' && segment !== '..' &&
    !/[\x00-\x1f\\]/.test(segment)));
const query = z.string().trim().min(1).max(250);
const body = z.string().max(12_000);
const title = z.string().trim().min(1).max(250);
const label = z.string().min(1).max(50);
const col = z.string().regex(/^[a-f0-9]{6}$/i);
const scope = <T extends z.ZodRawShape>(fields: T) => z.strictObject({ ...repo, ...fields });
const permissions = ['metadata', 'contents', 'issues', 'pull_requests', 'actions', 'workflows'] as const;
export const githubPermission = z.enum(permissions);
export const githubPermissions = z.partialRecord(githubPermission, z.enum(['read', 'write']));
export type GithubPermissions = z.infer<typeof githubPermissions>;
export interface ConnectorCapability<T extends z.ZodType = z.ZodType> {
  input: T;
  description: string;
  permission: string;
  access: 'read' | 'write';
  confirm: boolean;
}

export interface ConnectorDescriptor {
  id: string;
  name: string;
  description: string;
  icon: string;
  provider: string;
  authorization: { method: string; credentials: string };
  contexts: readonly ('chat' | 'job')[];
  resourceOwnership: string;
  rateLimits: string;
  permissions: readonly string[];
  capabilities: Readonly<Record<string, ConnectorCapability>>;
}

const define = <T extends z.ZodType>(
  input: T,
  description: string,
  permission: z.infer<typeof githubPermission>,
  access: 'read' | 'write' = 'read',
  confirm = false,
) => ({ input, description, permission, access, confirm });

export const githubOperations = {
  'github.list_repositories': define(z.strictObject(page), 'List repositories authorized for the selected GitHub account.', 'metadata'),
  'github.search_repositories': define(z.strictObject({ query, ...page }), 'Search the authorized repository inventory by name or description.', 'metadata'),
  'github.get_repository': define(scope({}), 'Read GitHub repository metadata.', 'metadata'),
  'github.get_tree': define(scope({ ref: ref.optional(), path: path.optional(), offset: z.number().int().min(0).max(1000).optional() }), 'Read a repository directory at a branch, tag, or commit.', 'contents'),
  'github.read_file': define(scope({ path, ref: ref.optional(), offset: z.number().int().min(0).max(1_000_000).optional() }), 'Read a bounded excerpt of a repository file.', 'contents'),
  'github.get_readme': define(scope({ ref: ref.optional() }), 'Read the repository README.', 'contents'),
  'github.search_code': define(scope({ query, ...page }), 'Search code indexed by GitHub for this repository’s default branch. Supply search text.', 'contents'),
  'github.list_branches': define(scope(page), 'List branches and their head SHAs.', 'contents'),
  'github.list_commits': define(scope({ ref: ref.optional(), path: path.optional(), ...page }), 'List commits on a branch, tag, or commit history.', 'contents'),
  'github.compare_commits': define(scope({ base: ref, head: ref, ...page }), 'Compare two refs in the repository.', 'contents'),
  'github.list_issues': define(scope({ state: z.enum(['open', 'closed', 'all']).optional(), ...page }), 'List repository issues.', 'issues'),
  'github.search_issues': define(scope({ query, ...page }), 'Search repository issues by text.', 'issues'),
  'github.get_issue': define(scope({ number }), 'Read an issue by number.', 'issues'),
  'github.list_issue_comments': define(scope({ number, ...page }), 'Read issue comments.', 'issues'),
  'github.create_issue': define(scope({ title, body: body.optional(), labels: z.array(label).max(10).optional() }), 'Create an issue.', 'issues', 'write'),
  'github.update_issue': define(scope({ number, title: title.optional(), body: body.optional(), state: z.enum(['open', 'closed']).optional() }), 'Update an issue’s title, body, or state.', 'issues', 'write'),
  'github.add_issue_comment': define(scope({ number, body: body.min(1) }), 'Post a comment on an issue.', 'issues', 'write'),
  'github.list_labels': define(scope(page), 'List repository labels.', 'issues'),
  'github.create_label': define(scope({ name: label, color: col, description: z.string().max(100).optional() }), 'Create a repository label.', 'issues', 'write'),
  'github.update_label': define(scope({ name: label, newName: label.optional(), color: col.optional(), description: z.string().max(100).optional() }), 'Update a repository label.', 'issues', 'write', true),
  'github.add_issue_labels': define(scope({ number, labels: z.array(label).min(1).max(10) }), 'Attach labels to an issue.', 'issues', 'write'),
  'github.remove_issue_label': define(scope({ number, label }), 'Remove a label from an issue.', 'issues', 'write', true),
  'github.list_pull_requests': define(scope({ state: z.enum(['open', 'closed', 'all']).optional(), ...page }), 'List repository pull requests.', 'pull_requests'),
  'github.search_pull_requests': define(scope({ query, ...page }), 'Search repository pull requests by text.', 'pull_requests'),
  'github.get_pull_request': define(scope({ number }), 'Read pull request metadata and head SHA.', 'pull_requests'),
  'github.list_pull_request_files': define(scope({ number, ...page }), 'Read changed files and available diff excerpts.', 'pull_requests'),
  'github.list_review_comments': define(scope({ number, ...page }), 'Read inline pull request review comments.', 'pull_requests'),
  'github.create_pull_request': define(scope({ title, body: body.optional(), base: ref, head: ref, draft: z.boolean().optional() }), 'Create a pull request between branches in this repository.', 'pull_requests', 'write'),
  'github.review_pull_request': define(scope({ number, headSha: sha, event: z.enum(['COMMENT', 'APPROVE', 'REQUEST_CHANGES']), body: body.optional() }), 'Submit a review on a verified pull request revision.', 'pull_requests', 'write', true),
  'github.merge_pull_request': define(scope({ number, headSha: sha, method: z.enum(['merge', 'squash', 'rebase']).optional() }), 'Merge a pull request with the given head SHA.', 'contents', 'write', true),
  'github.list_workflows': define(scope(page), 'List GitHub Actions workflows.', 'actions'),
  'github.list_workflow_runs': define(scope({ workflowId: number.optional(), status: z.enum(['queued','in_progress','completed','success','failure','cancelled']).optional(), ...page }), 'List workflow runs, optionally by workflow and status.', 'actions'),
  'github.get_workflow_run': define(scope({ runId: number }), 'Read the status and conclusion of a workflow run.', 'actions'),
  'github.list_workflow_jobs': define(scope({ runId: number, ...page }), 'List jobs in a workflow run.', 'actions'),
  'github.read_workflow_logs': define(scope({ runId: number, jobId: number, offset: z.number().int().min(0).max(2_000_000).optional() }), 'Read bounded GitHub Actions logs for a job in a verified run.', 'actions'),
  'github.dispatch_workflow': define(scope({ workflowId: number, ref, expectedHead: sha, inputs: z.record(z.string().regex(/^[\w-]{1,60}$/), z.string().max(1000)).optional() }), 'Dispatch a workflow at a verified ref.', 'actions', 'write', true),
  'github.cancel_workflow_run': define(scope({ runId: number }), 'Cancel a workflow run.', 'actions', 'write', true),
  'github.rerun_workflow': define(scope({ runId: number }), 'Rerun a workflow run.', 'actions', 'write', true),
  'github.list_releases': define(scope(page), 'List repository releases.', 'contents'),
  'github.get_release': define(scope({ releaseId: number }), 'Read release metadata and asset IDs.', 'contents'),
  'github.list_tags': define(scope(page), 'List Git tags and their SHAs.', 'contents'),
  'github.create_release': define(scope({ tag: ref, name: title.optional(), body: body.optional(), publish: z.boolean().optional(), prerelease: z.boolean().optional(), tagSha: sha }), 'Create a draft or publish a release at an existing tag.', 'contents', 'write', true),
  'github.update_release': define(scope({ releaseId: number, name: title.optional(), body: body.optional(), publish: z.boolean().optional(), prerelease: z.boolean().optional(), tagSha: sha.optional() }), 'Update release metadata. To publish, supply the verified tag commit SHA.', 'contents', 'write', true),
  'github.get_release_asset': define(scope({ releaseId: number, assetId: number }), 'Download and verify an asset from a release.', 'contents'),
  'github.create_branch': define(scope({ branch: ref, from: sha }), 'Create a new branch at a verified repository commit.', 'contents', 'write', true),
  'github.commit_files': define(scope({ branch: ref, expectedHead: sha, message: title, files: z.array(z.strictObject({ path, text: z.string().max(24_000), previousSha: sha.nullable() })).min(1).max(12) }), 'Commit file creations and updates atomically at the expected branch head. Use null previousSha for a new file.', 'contents', 'write', true),
} as const;
export const githubConnector = {
  id: 'github',
  name: 'GitHub',
  description: 'Read repositories, issues, pull requests, workflow runs, and releases. Review write permissions separately.',
  icon: 'github-mark.svg',
  provider: 'https://github.com',
  authorization: {
    method: 'github_app_device_flow',
    credentials: 'Expiring user access token and rotating refresh token, encrypted in the desktop profile.',
  },
  contexts: ['chat', 'job'],
  resourceOwnership: 'Verified GitHub App installation, authenticated user, and selected repository ID.',
  rateLimits: 'Serial requests per connection with GitHub rate-limit and Retry-After handling.',
  permissions,
  capabilities: githubOperations,
} as const satisfies ConnectorDescriptor;
export const connectorCatalog = [githubConnector] as const;
export type GithubOperation = keyof typeof githubOperations;
export const githubOperation = z.enum(Object.keys(githubOperations) as [GithubOperation, ...GithubOperation[]]);
export type GithubArguments<Operation extends GithubOperation> = z.infer<(typeof githubOperations)[Operation]['input']>;

export const githubPublicSearchOperation = 'github.search_public_repositories';
const publicRepositoryName = githubRepositoryName.refine((name) =>
  name.split('/').every((part) => part !== '.' && part !== '..'));
export const githubPublicSearchInput = z.strictObject({
  query: z.string().trim().min(1).max(160).refine((query) =>
    publicRepositoryName.safeParse(query).success ||
    /^[\p{L}\p{M}\p{N}_. -]+$/u.test(query) && /[\p{L}\p{N}]/u.test(query),
  'Use a repository name, owner/name, or keywords.'),
  ...page,
});
export const githubPublicSearchLimit = 8;
export const githubPublicSearchResult = z.strictObject({
  results: z.array(z.strictObject({
    name: publicRepositoryName,
    description: z.string().max(500).nullable(),
    stars: z.number().int().nonnegative().safe(),
    language: z.string().max(80).nullable(),
  })).max(githubPublicSearchLimit),
  nextPage: page.page,
  partial: z.boolean(),
});

export const connectorPolicy = z.enum(['read_only', 'ask', 'scoped']);
export type ConnectorPolicy = z.infer<typeof connectorPolicy>;
export const githubRepository = z.strictObject({
  id: githubRepositoryId, installation: githubRepositoryId, name: githubRepositoryName, private: z.boolean(),
  description: z.string().max(500).nullable(), defaultBranch: z.string().max(220),
  permissions: githubPermissions, writeAccess: z.boolean(),
});
export type GithubRepository = z.infer<typeof githubRepository>;
const connectionState = z.enum(['connected', 'needs_repositories', 'reconnect', 'offline']);
export const githubAccount = z.strictObject({
  id: githubAccountId, userId: number, login: z.string().max(100), avatar: z.string().url().nullable(),
  connectedAt: z.number(), verifiedAt: z.number(), state: connectionState, generation: z.number().int().positive(),
  selected: z.array(githubRepositoryId).max(1000), repositories: z.array(githubRepository).max(1000),
  reconnectReason: z.literal('device_flow').optional(),
  policy: connectorPolicy,
  grants: z.array(z.strictObject({ repository: githubRepositoryId, operation: githubOperation })).max(100),
});
export type GithubAccount = z.infer<typeof githubAccount>;
const deviceCode = z.strictObject({
  userCode: z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/),
  expiresAt: z.number().int().positive(),
});
export type DeviceCode = z.infer<typeof deviceCode>;
const connectorAttempt = z.discriminatedUnion('phase', [
  z.strictObject({ id: z.uuid(), phase: z.literal('starting') }),
  z.strictObject({ id: z.uuid(), phase: z.literal('waiting'), verification: deviceCode }),
  z.strictObject({ id: z.uuid(), phase: z.literal('verifying') }),
]);
export const connectorSnapshot = z.strictObject({
  available: z.boolean(), active: githubAccountId.nullable(), accounts: z.array(githubAccount).max(12),
  attempt: connectorAttempt.nullable(), error: z.string().max(400).nullable(),
});
export type ConnectorSnapshot = z.infer<typeof connectorSnapshot>;
const grant = githubAccount.shape.grants;
export const connectorCommand = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('status') }),
  z.strictObject({ action: z.literal('connect') }),
  z.strictObject({ action: z.enum(['cancel', 'copy_code', 'open_device']), attemptId: z.uuid() }),
  z.strictObject({ action: z.enum(['reconnect', 'disconnect', 'revoke', 'switch', 'verify', 'manage']), id: githubAccountId }),
  z.strictObject({ action: z.literal('repositories'), id: githubAccountId, repositories: githubAccount.shape.selected }),
  z.strictObject({ action: z.literal('policy'), id: githubAccountId, policy: connectorPolicy, grants: grant }),
]);
export type ConnectorCommand = z.infer<typeof connectorCommand>;

export const connectorJobGrant = z.strictObject({
  connection: githubAccountId, generation: z.number().int().positive(),
  repositories: z.array(githubRepositoryId).min(1).max(50),
  operations: z.array(githubOperation).min(1).max(50),
});
export type ConnectorJobGrant = z.infer<typeof connectorJobGrant>;

export const connectorInventory = z.strictObject({
  active: githubAccountId.nullable(), readable: z.boolean(), writable: z.boolean(),
  publicSearch: z.boolean().optional(),
});
export type ConnectorInventory = z.infer<typeof connectorInventory>;
export const githubResult = z.strictObject({
  account: z.string().max(100),
  repository: githubRepositoryName.optional(),
  repositoryId: githubRepositoryId.optional(),
  connection: githubAccountId,
  url: z.url({ hostname: /^github\.com$/, protocol: /^https$/ }).max(800).optional(),
  content: z.string().max(12_000).optional(),
  nextPage: page.page,
  nextOffset: z.number().int().positive().optional(),
  partial: z.boolean().optional(),
  observation: z.string().regex(/^(?:none|[0-9]+\/[0-9]+)$/).max(45).optional(),
  verified: z.boolean(),
});

export type ConnectorActivity = {
  repository: number | null; operation: string; state: string; occurred: number; url: string | null;
};
