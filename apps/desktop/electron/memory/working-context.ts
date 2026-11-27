import type { ChatMessage } from '@aria/shared';
import { containsSecret } from '@aria/shared';

const bounded = (value: string, size: number) => value.replace(/\s+/gu, ' ').trim().slice(0, size);

export class WorkingContext {
  private readonly conversations = new Map<
    string,
    {
      summary?: string;
      recent: { id: string; role: string; content: string }[];
      references: { id: string; name: string }[];
      activity: { id: string; name?: string; state: string }[];
    }
  >();

  capture(id: string, messages: readonly ChatMessage[], recentCount: number, cutoff: number) {
    const history = messages.filter(
      (message) =>
        message.status === 'completed' &&
        !message.run?.privateContent &&
        !message.activity?.some((item) => item.privateContent),
    );
    const earlier = history.slice(0, Math.max(0, history.length - recentCount));
    const snippets = [
      ...earlier.slice(0, 2),
      ...earlier.slice(Math.max(2, earlier.length - 5)),
    ].filter(
      ({ content, createdAt }) => Date.parse(createdAt) > cutoff && !containsSecret(content),
    );
    const summary =
      snippets.length >= 2
        ? snippets
            .map((message) => `${message.role} (${message.id}): ${bounded(message.content, 255)}`)
            .join('\n')
            .slice(0, 2400)
        : undefined;
    const recent = history
      .slice(-6)
      .filter(({ content }) => !containsSecret(content))
      .map(({ id, role, content }) => ({ id, role, content: bounded(content, 400) }));
    const references = history
      .slice(-10)
      .flatMap(({ assets }) =>
        (assets ?? []).map(({ id, name }) => ({ id, name: bounded(name, 120) })),
      )
      .slice(-10);
    const activity = history
      .slice(-4)
      .flatMap((message) =>
        (message.activity ?? []).map((item) => ({
          id: item.stepId,
          name: item.capability,
          state: item.status,
        })),
      )
      .slice(-8);
    this.conversations.delete(id);
    this.conversations.set(id, { summary, recent, references, activity });
    if (this.conversations.size > 24)
      this.conversations.delete(this.conversations.keys().next().value!);
    return summary;
  }

  get(id: string) {
    return this.conversations.get(id);
  }

  clear(id?: string) {
    if (id) this.conversations.delete(id);
    else this.conversations.clear();
  }
}
