import {
  executionTerminalStates,
  loopCheckpointBytes,
  loopCheckpointSchema,
  type CapabilityHostRequest,
  type ExecutionSnapshot,
  type LoopRecoveryRequest,
  type ManagedExecution,
} from '@aria/shared';
import type { SecretCipher } from './provider-storage';
import { RuntimeError, type RuntimeStore } from './runtime/store';

export class LoopRecovery {
  constructor(
    private readonly store: RuntimeStore,
    private readonly cipher: SecretCipher,
    private readonly provider: () => string | undefined,
    private readonly visibleEvidence?: (id: string, conversation: string) => boolean,
  ) {}

  snapshot(conversation: string, message: string): ExecutionSnapshot | undefined {
    const row = this.store.loopForMessage(conversation, message);
    if (!row || executionTerminalStates.has(row.state as ExecutionSnapshot['state'])) return;
    return {
      executionId: String(row.id),
      generation: Number(row.generation),
      state: 'recovering',
      durability: 'saved',
      iteration: 0,
    };
  }

  async save(request: Extract<CapabilityHostRequest, { type: 'checkpoint' }>, signal: AbortSignal) {
    const provider = this.provider();
    if (!provider || !(await this.cipher.available())) return false;
    const value = JSON.stringify(request.checkpoint);
    if (Buffer.byteLength(value) > loopCheckpointBytes)
      throw new RuntimeError(
        'BUDGET_EXCEEDED',
        'The recovery checkpoint exceeds its local storage limit.',
      );
    const payload = await this.cipher.encrypt(value);
    signal.throwIfAborted();
    if (this.provider() !== provider)
      throw new RuntimeError('PERMISSION_DENIED', 'The execution primary changed.');
    return this.store.saveLoop(request, request.checkpoint, provider, payload);
  }

  async restore(
    scope: LoopRecoveryRequest,
    userMessageId: string,
    requestId: string,
    authorize: () => boolean,
  ): Promise<ManagedExecution> {
    const { conversationId, assistantMessageId, executionId, generation } = scope;
    const row = this.store.loopForMessage(conversationId, assistantMessageId);
    const provider = this.provider();
    if (
      !row ||
      row.id !== executionId ||
      row.generation !== generation ||
      row.user_message !== userMessageId ||
      executionTerminalStates.has(row.state as ExecutionSnapshot['state'])
    )
      throw new Error('The execution checkpoint no longer belongs to this turn.');
    if (!provider || row.provider !== provider || !(await this.cipher.available()))
      throw new Error(
        'Resume with the original primary model, endpoint, and credential and unlock local encrypted storage.',
      );
    if (!ArrayBuffer.isView(row.payload))
      throw new Error('The encrypted execution checkpoint is missing.');
    const { result } = await this.cipher.decrypt(Buffer.from(row.payload as Uint8Array));
    const prior = loopCheckpointSchema.parse(JSON.parse(result));
    if (
      prior.executionId !== executionId ||
      prior.userMessageId !== userMessageId ||
      prior.generation > generation ||
      this.provider() !== provider ||
      !authorize()
    )
      throw new Error('The execution scope changed during recovery.');
    if (
      prior.elapsedMs >= prior.limits.activeMs ||
      prior.budget.providerRequests >= prior.limits.iterations
    )
      throw new Error(
        'This execution reached its resource limit. Review the verified results in its activity.',
      );
    const receipts = this.store.claimLoop(
      conversationId,
      assistantMessageId,
      executionId,
      generation,
      Number(row.revision),
      provider,
      requestId,
    );
    const authoritative = new Map<string, (typeof receipts)[number]>();
    for (const receipt of receipts) {
      const earlier = authoritative.get(receipt.id);
      authoritative.set(receipt.id, earlier && earlier.state !== receipt.state
        ? { ...receipt, state: 'uncertain' } : receipt);
    }
    const reconciled = new Map(prior.receipts.map((receipt) => [receipt.id, receipt]));
    for (const receipt of authoritative.values()) {
      const previous = reconciled.get(receipt.id);
      const state = previous?.state === 'uncertain' ? 'uncertain' : receipt.state;
      reconciled.set(receipt.id, { ...receipt, operation: previous?.operation ?? receipt.operation,
        state, evidenceIds: previous?.evidenceIds });
    }
    const recent = [...reconciled.values()].slice(-48).map((receipt) => ({
      ...receipt, state: receipt.state === 'pending' ? 'uncertain' as const : receipt.state,
    }));
    const evidenceIds = new Set(recent.flatMap((receipt) => receipt.evidenceIds ?? []));
    const allowed = new Set(
      [...evidenceIds].slice(0, 16).filter((id) => this.visibleEvidence?.(id, conversationId)),
    );
    return {
      executionId,
      generation: generation + 1,
      userMessageId,
      recovery: {
        ...prior,
        receipts: recent.map((receipt) => ({
          ...receipt,
          evidenceIds: receipt.evidenceIds?.filter((id) => allowed.has(id)),
        })),
      },
    };
  }
}
