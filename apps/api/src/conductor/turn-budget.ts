import { asSchema, type LanguageModelUsage, type ModelMessage, type ToolSet } from 'ai';
import { conductorLimits } from '@aria/shared';
import type { ResolvedModel } from '../providers/model-registry.service';
import { ToolError } from './capability-host';

export const modelOutputTokens = 4096;

function exceeds(resource: string): never {
  throw new ToolError('BUDGET_EXCEEDED', `The turn reached its ${resource} limit.`);
}

function encodedSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value, (key, item: unknown) => {
    if (item instanceof Uint8Array ||
      (key === 'imageUrl' && typeof item === 'string' && item.startsWith('data:image/png;base64,')))
      return ' '.repeat(16_384);
    return item;
  }) ?? '');
}

function measured(count: number | undefined) {
  return count !== undefined && Number.isSafeInteger(count) && count >= 0 ? count : undefined;
}

export class TurnBudget {
  private steps = 0;
  private inputReserved = 0;
  private outputReserved = 0;
  private cost = 0;
  providerRequests = 0;
  responseContinuations = 0;
  controlCalls = 0;
  nativeToolCalls = 0;
  inputTokens?: number;
  outputTokens?: number;

  constructor(private readonly spendingLimit?: number) {}

  get remainingSteps() { return conductorLimits.steps - this.steps; }
  get remainingRequests() { return conductorLimits.primaryCalls - this.providerRequests; }
  get accountedCostUsdMicros() { return this.spendingLimit === undefined ? undefined : this.cost; }

  step(count = 1) {
    if (count > this.remainingSteps) exceeds('execution step');
    this.steps += count;
  }

  control() {
    if (this.controlCalls >= conductorLimits.controlCalls) exceeds('discovery and skill');
    this.step();
    this.controlCalls++;
  }

  native(maximum: number) {
    this.step(maximum);
    return (completed: number) => {
      if (completed > maximum) exceeds('native tool call');
      this.steps -= maximum - completed;
      this.nativeToolCalls += completed;
    };
  }

  media() {
    if (this.spendingLimit !== undefined)
      throw new ToolError('CAPABILITY_UNAVAILABLE', 'This media operation has no verified rate for your turn spending cap.');
    if (!this.remainingRequests) exceeds('model request');
    this.providerRequests++;
  }

  async prepare(
    messages: ModelMessage[],
    historicalMessages: number,
    system: string,
    tools: ToolSet,
    model: ResolvedModel,
    continuation: boolean,
    textOnly: boolean,
  ) {
    const schemas = await Promise.all(Object.entries(tools).map(async ([name, tool]) => [
      name, tool.description, tool.inputSchema && await asSchema(tool.inputSchema).jsonSchema,
    ]));
    let input = encodedSize([messages, system, schemas]);
    const ceiling = Math.min(
      model.contextTokens ?? conductorLimits.contextTokens,
      conductorLimits.contextTokens,
    ) - modelOutputTokens;
    while (input > ceiling && historicalMessages >= 2) {
      messages.splice(0, 2);
      historicalMessages -= 2;
      input = encodedSize([messages, system, schemas]);
    }
    if (input > ceiling) exceeds('model context');
    return { historicalMessages, settle: this.model(model, input, continuation, textOnly) };
  }

  model(model: ResolvedModel, input: number, continuation = false, textOnly = true) {
    const output = modelOutputTokens;
    if (input + output > (model.contextTokens ?? conductorLimits.contextTokens))
      exceeds('model context');
    if (!this.remainingRequests) exceeds('model request');
    if (this.inputReserved + input > conductorLimits.inputTokens) exceeds('input token');
    if (this.outputReserved + output > conductorLimits.outputTokens) exceeds('output token');
    const pricing = textOnly ? model.textPricing : undefined;
    const priceFor = (inputTokens: number, outputTokens: number) => pricing
      ? Math.ceil(inputTokens * pricing.input / 1_000_000 + outputTokens * pricing.output / 1_000_000)
      : 0;
    const price = priceFor(input, output);
    if (this.spendingLimit !== undefined) {
      if (!pricing)
        throw new ToolError('CAPABILITY_UNAVAILABLE', 'This model operation has no verified rate for your turn spending cap.');
      if (this.cost + price > this.spendingLimit) exceeds('spending');
      this.cost += price;
    }
    this.providerRequests++;
    if (continuation) this.responseContinuations++;
    this.inputReserved += input;
    this.outputReserved += output;
    return (usage?: Pick<LanguageModelUsage, 'inputTokens' | 'outputTokens'>) => {
      const actualInput = measured(usage?.inputTokens);
      const actualOutput = measured(usage?.outputTokens);
      this.inputReserved += (actualInput ?? input) - input;
      this.outputReserved += (actualOutput ?? output) - output;
      if (actualInput !== undefined) this.inputTokens = (this.inputTokens ?? 0) + actualInput;
      if (actualOutput !== undefined) this.outputTokens = (this.outputTokens ?? 0) + actualOutput;
      if (this.spendingLimit !== undefined)
        this.cost += priceFor(actualInput ?? input, actualOutput ?? output) - price;
      if (this.inputReserved > conductorLimits.inputTokens) exceeds('input token');
      if (this.outputReserved > conductorLimits.outputTokens) exceeds('output token');
      if (this.spendingLimit !== undefined && this.cost > this.spendingLimit) exceeds('spending');
    };
  }
}
