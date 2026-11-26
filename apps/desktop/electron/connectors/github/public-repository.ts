import { z } from 'zod';
import {
  githubPublicContentResult, githubPublicFileOperation, githubPublicFilesOperation, githubPublicOperations,
  githubPublicReadmeOperation, githubRepositoryId,
} from '@aria/shared';
import { filePath, GithubClient, GithubError, sanitizeGithubText, segment } from './client';
import { decodeGithubFile } from './operations';

const fileResult = githubPublicContentResult.options[0];
const directoryResult = githubPublicContentResult.options[1];
const repositoryShape = z.object({ id: githubRepositoryId, full_name: fileResult.shape.repository,
  default_branch: z.string().min(1).max(220), private: z.literal(false), visibility: z.literal('public').optional() });
const branchShape = z.object({ name: z.string(), commit: z.object({ sha: fileResult.shape.commit }) });
const fileShape = z.object({ type: z.literal('file'), path: fileResult.shape.path });
const entryShape = directoryResult.shape.entries.element.extend({ submodule_git_url: z.string().optional() }).strip();
const unsafeRepository = () => new GithubError('PERMISSION_DENIED', 'GitHub did not confirm that this repository is public. Use approved repository access for private repositories.', 'PUBLIC_REPOSITORY_REQUIRED');
const invalidResponse = (message: string) => new GithubError('INVALID_TOOL_OUTPUT', message, 'INVALID_PROVIDER_OUTPUT');

export async function inspectPublicRepository(client: GithubClient, token: string,
  operation: typeof githubPublicReadmeOperation | typeof githubPublicFilesOperation | typeof githubPublicFileOperation,
  input: z.infer<(typeof githubPublicOperations)[typeof operation]>, signal: AbortSignal, onDispatch: () => void) {
  const { repository } = input;
  const path = 'path' in input ? input.path : undefined;
  if (sanitizeGithubText(repository) !== repository || path && sanitizeGithubText(path) !== path)
    throw new GithubError('INVALID_ARGUMENT', 'Use a public repository name and file path.', 'INVALID_TARGET');
  const base = '/repos/' + filePath(repository);
  const read = async (route: string) => (await client.json(token, base + route, signal, { fresh: true, onDispatch })).value;
  const verify = async () => {
    const response = repositoryShape.safeParse(await read(''));
    if (!response.success || response.data.full_name.toLowerCase() !== repository.toLowerCase()) throw unsafeRepository();
    return response.data;
  };
  const initial = await verify();
  if (initial.default_branch === '.' || initial.default_branch === '..') throw invalidResponse('GitHub returned an invalid default branch.');
  const branch = branchShape.safeParse(await read('/branches/' + segment(initial.default_branch)));
  if (!branch.success || branch.data.name !== initial.default_branch) throw invalidResponse('GitHub did not resolve the public default branch.');
  const commit = branch.data.commit.sha;
  const endpoint = operation === githubPublicReadmeOperation ? '/readme' : '/contents' + (path ? '/' + filePath(path) : '');
  const raw = await read(endpoint + '?' + new URLSearchParams({ ref: commit }));
  // A token may see private repositories. Recheck visibility and identity before releasing any content.
  if ((await verify()).id !== initial.id) throw unsafeRepository();
  const target = { repository: initial.full_name, commit };
  const offset = input.offset ?? 0;
  if (operation === githubPublicFilesOperation) {
    if (!Array.isArray(raw)) throw invalidResponse('That GitHub path is not a directory.');
    const prefix = path ? path + '/' : '';
    const next = offset + 30;
    const entries = raw.slice(offset, next).flatMap((entry) => {
      const parsed = entryShape.safeParse(entry);
      if (!parsed.success) return [];
      const item = parsed.data;
      if (!item.path.startsWith(prefix) || item.path.slice(prefix.length).includes('/') ||
          sanitizeGithubText(item.path) !== item.path) return [];
      return [{ path: item.path, type: item.submodule_git_url ? 'submodule' as const : item.type }];
    });
    return directoryResult.parse({ ...target, kind: 'directory', path, entries,
      nextOffset: raw.length > next && next <= 1000 ? next : undefined,
      partial: raw.length > next || raw.length >= 1000 || entries.length !== raw.slice(offset, next).length });
  }
  const file = fileShape.safeParse(raw);
  if (!file.success || path && file.data.path !== path || sanitizeGithubText(file.data.path) !== file.data.path)
    throw invalidResponse('GitHub did not return the requested text file.');
  const text = decodeGithubFile(raw);
  const next = offset + 7000;
  return fileResult.parse({ ...target, kind: 'file', path: file.data.path, text: text.slice(offset, next),
    nextOffset: text.length > next && next <= 1_000_000 ? next : undefined, partial: text.length > next });
}
