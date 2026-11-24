import type { ChatEvent, ChatMessage } from './index.js';
import { conductorLimits, endActivity } from './conductor.js';

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
  if (event.type === 'reset') return { ...next, content: '' };
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
            sources: [
              ...new Map(
                [...(next.citations?.sources ?? []), ...(sources ?? [])].map((source) => [
                  source.url,
                  source,
                ]),
              ).values(),
            ].slice(0, conductorLimits.steps * 8),
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
