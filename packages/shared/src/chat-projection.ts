import type { ChatEvent, ChatMessage } from './index.js';
import { conductorLimits, endActivity, type ConductorSource } from './conductor.js';

import { updatePresentation } from './presentation.js';

const evidenceRanks = { discovered: 0, metadata: 1, partial: 2, inspected: 3 };

function mergeSources(previous: ConductorSource[], incoming: ConductorSource[]) {
  const byUrl = new Map(previous.map((source) => [source.url, source]));
  for (const source of incoming) {
    const prior = byUrl.get(source.url);
    if (!prior) {
      byUrl.set(source.url, source);
      continue;
    }
    if (evidenceRanks[source.evidenceStatus ?? 'inspected'] < evidenceRanks[prior.evidenceStatus ?? 'inspected'])
      continue;
    byUrl.set(source.url, { ...source, publishedAt: source.publishedAt ?? prior.publishedAt });
  }
  return [...byUrl.values()].slice(0, conductorLimits.steps * 8);
}

export function generating(message: ChatMessage) {
  return message.status === 'pending' || message.status === 'streaming';
}

export function projectChatEvent(item: ChatMessage, event: ChatEvent): ChatMessage {
  if (event.assistantMessageId !== item.id || event.conversationId !== item.conversationId)
    return item;
  if (event.requestId !== item.requestId) {
    if (
      event.type !== 'execution' ||
      event.execution.executionId !== item.execution?.executionId ||
      event.execution.generation <= item.execution.generation
    )
      return item;
    item = {
      ...item,
      requestId: event.requestId,
      sequence: 0,
      status: 'streaming',
      error: undefined,
      content: '',
      presentation: undefined,
      presentationState: undefined,
      retryConfirmed: false,
      settingsHelp: undefined,
      execution: event.execution,
    };
  }
  if (
    !generating(item) ||
    event.sequence <= item.sequence ||
    (event.generation !== undefined &&
      item.execution &&
      event.generation !== item.execution.generation)
  )
    return item;
  const next = { ...item, sequence: event.sequence };
  if (event.type === 'execution') return { ...next, execution: event.execution };
  if (event.type === 'started') return { ...next, status: 'streaming', run: event.run };
  if (event.type === 'reset') return { ...next, content: '', presentation: undefined, presentationState: undefined };
  if (event.type === 'presentation') return !event.part || event.part.offset > next.content.length ? next : {
    ...next, presentation: updatePresentation(next.presentation ?? [], event.part),
  };
  if (event.type === 'delta')
    return {
      ...next,
      status: 'streaming',
      content: (next.content + event.text).slice(0, 100000),
    };
  if (event.type === 'activity') {
    const activity = next.activity ?? [];
    const previous = activity.find((item) => item.stepId === event.activity.stepId);
    const { sources, evidence } = event.activity;
    const citations =
      sources?.length || evidence?.length
        ? {
            sources: mergeSources(next.citations?.sources ?? [], sources ?? []),
            evidence: [
              ...new Map(
                [...(next.citations?.evidence ?? []), ...(evidence ?? [])].map((item) => [
                  item.id,
                  item,
                ]),
              ).values(),
            ].slice(0, conductorLimits.steps * 8),
          }
        : next.citations;
    return {
      ...next,
      citations,
      activity: previous
        ? activity.map((item) => (item.stepId === event.activity.stepId ? event.activity : item))
        : [...activity, event.activity].slice(0, conductorLimits.activity),
    };
  }
  if (event.type === 'artifact') return next;
  if (event.type === 'asset')
    return {
      ...next,
      assets: [
        ...new Map(
          [...(next.assets ?? []), event.asset].map((asset) => [asset.id, asset]),
        ).values(),
      ].slice(0, 4),
    };
  if (event.type === 'completed')
    return {
      ...next,
      status: 'completed',
      ...('suggestions' in event ? { suggestions: event.suggestions } : {}),
      ...('memoryReferences' in event ? { memoryReferences: event.memoryReferences } : {}),
      ...('assets' in event ? { assets: event.assets } : {}),
      ...('run' in event ? { run: event.run, partial: event.partial } : {}),
    };
  const settleActivity = endActivity(next.activity);
  if (event.type === 'stopped')
    return { ...next, status: 'stopped', activity: settleActivity, retryConfirmed: false };
  return {
    ...next,
    status: event.interrupted ? 'interrupted' : 'failed',
    error: event.error,
    activity: settleActivity,
    run: event.run ?? next.run,
    settingsHelp: event.settingsHelp,
    retryConfirmed: Boolean(event.run && !event.run.billableChildStarted),
  };
}
