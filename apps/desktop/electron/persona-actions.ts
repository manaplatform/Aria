import { BrowserWindow, clipboard, dialog, shell } from 'electron';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  containsSecret,
  presentationActionRequest,
  resolvePresentationFields,
  type ChatMessage,
  type PresentationActionResult,
} from '@aria/shared';
import { safeExternalUrl } from './project';
import { exportPresentationDiagram } from './presentation-diagram';

const inFlight = new Set<string>();
const recentLinks = new Map<string, number>();

function csvCell(value: unknown) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  const safe =
    typeof value === 'string' && /^[\s\p{Cf}]*[=+\-@]|^[\t\r\n]/u.test(text) ? "'" + text : text;
  return '"' + safe.replaceAll('"', '""') + '"';
}

export async function personaAction(
  input: unknown,
  find: (conversationId: string, messageId: string) => ChatMessage | undefined,
  window: BrowserWindow,
  dark: boolean,
): Promise<PresentationActionResult> {
  const request = presentationActionRequest.parse(input);
  const { conversationId, messageId, blockId, revision, actionId, fieldId, values } = request;
  const message = find(conversationId, messageId);
  const part = message?.presentation?.find(
    (part) => part.kind === 'block' && part.block.id === blockId,
  );
  const block = part?.kind === 'block' && part.block;
  const action = block && block.actions?.find(({ id }) => id === actionId);
  if (!message || message.role !== 'assistant' || !block || block.revision !== revision || !action)
    throw new Error('This action is unavailable. Reopen the conversation and try again.');
  if (message.status !== 'completed' && action.kind !== 'copy' && action.kind !== 'approval')
    throw new Error('Wait for the response to complete.');
  const key = JSON.stringify([
    conversationId,
    messageId,
    message.requestId,
    blockId,
    revision,
    actionId,
  ]);
  if (inFlight.has(key)) throw new Error('This action is already running.');
  inFlight.add(key);
  try {
    if (action.kind === 'followUp') {
      const form = block.nodes.find(
        (node) => node.type === 'form' && node.action === action.id && node.id === fieldId,
      );
      if ((fieldId || values) && form?.type !== 'form')
        throw new Error('This form is unavailable.');
      const fields = form?.type === 'form' ? resolvePresentationFields(form, values ?? {}) : [];
      if (fields.some(([label, value]) => containsSecret(label + ': ' + String(value))))
        throw new Error('Remove authentication secrets before submitting this form.');
      const details = fields
        .map(([label, value]) => label + ': ' + JSON.stringify(value))
        .join('\n');
      return {
        kind: 'review',
        request: details ? action.request + '\n\nForm values\n' + details : action.request,
      };
    }
    if (action.kind === 'approval') {
      if (
        !message.activity?.some(
          (step) => step.stepId === action.stepId && step.status === 'approval',
        )
      )
        throw new Error('This approval is no longer pending.');
      window.focus();
      return { kind: 'approval', stepId: action.stepId };
    }
    if (action.kind === 'link') {
      const now = Date.now();
      for (const [id, expires] of recentLinks) if (expires <= now) recentLinks.delete(id);
      if (recentLinks.has(key)) return { kind: 'done' };
      const url = action.sourceId
        ? [
            ...(message.citations?.sources ?? []),
            ...(message.activity?.flatMap((step) =>
              step.privateContent ? [] : (step.sources ?? []),
            ) ?? []),
          ].find((source) => source.id === action.sourceId)?.url
        : action.url;
      if (!url) throw new Error('The link is unavailable.');
      await shell.openExternal(safeExternalUrl(url));
      if (recentLinks.size < 128) recentLinks.set(key, Date.now() + 500);
      return { kind: 'done' };
    }
    const node = block.nodes.find(({ id }) => id === action.target);
    if (action.kind === 'copy') {
      if (!node || !('text' in node)) throw new Error('The selected text is unavailable.');
      clipboard.writeText(node.text);
      return { kind: 'done' };
    }
    const dataset =
      node && 'dataset' in node && block.datasets?.find(({ id }) => id === node.dataset);
    const extension = node?.type === 'diagram' ? 'svg' : 'csv';
    const content =
      node?.type === 'diagram'
        ? exportPresentationDiagram(node, dark)
        : dataset
          ? [dataset.columns, ...dataset.rows]
              .map((row) => row.map(csvCell).join(','))
              .join('\r\n') + '\r\n'
          : undefined;
    if (content === undefined) throw new Error('The selected data is unavailable.');
    const name =
      (dataset && dataset.illustrative ? 'illustrative-data' : 'aria-response') + '.' + extension;
    const result = await dialog.showSaveDialog(window, {
      defaultPath: name,
      filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
    });
    if (result.canceled || !result.filePath) return { kind: 'cancelled' };
    if (find(conversationId, messageId)?.requestId !== message.requestId)
      throw new Error('The conversation changed while the save dialog was open.');
    const temporary = result.filePath + '.' + randomUUID() + '.tmp';
    try {
      await fs.writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, result.filePath);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
    return { kind: 'done' };
  } finally {
    inFlight.delete(key);
  }
}
