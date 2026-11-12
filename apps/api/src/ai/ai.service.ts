import { Injectable } from '@nestjs/common';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenAI } from '@ai-sdk/openai';
import { streamText } from 'ai';
import type { ChatCapabilities, ChatRequest } from '@aria/shared';

export const DEFAULT_SYSTEM_PROMPT =
  'You are Aria, a thoughtful, helpful general-purpose AI assistant. Answer clearly and naturally. Use Markdown when it improves readability.';

@Injectable()
export class AiService {
  capabilities(): ChatCapabilities {
    return {
      configured: Boolean(process.env.OPENAI_API_KEY?.trim() && process.env.OPENAI_MODEL?.trim()),
      model: process.env.OPENAI_MODEL?.trim() ?? '',
      streaming: true,
      cancellation: true,
      attachments: false,
    };
  }

  generate(
    messages: ChatRequest['messages'],
    signal: AbortSignal,
    model = process.env.OPENAI_MODEL!,
  ): ReturnType<typeof streamText> {
    const baseURL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    const official = new URL(baseURL).origin === 'https://api.openai.com';
    const provider = createOpenAICompatible({
      name: 'aria-provider',
      baseURL,
      apiKey: process.env.OPENAI_API_KEY,
    });
    return streamText({
      model: official
        ? createOpenAI({ baseURL, apiKey: process.env.OPENAI_API_KEY }).responses(model)
        : provider.chatModel(model),
      ...(official ? { providerOptions: { openai: { store: false } } } : {}),
      system: process.env.ARIA_SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT,
      messages,
      abortSignal: signal,
      maxRetries: 0,
      onError: () => undefined,
      maxOutputTokens: 4096,
    });
  }
}

export function providerError(error: unknown): string {
  const status =
    error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : undefined;
  if (status === 401 || status === 403)
    return 'The provider rejected the API key. Check your model settings.';
  if (status === 404)
    return 'The model or provider endpoint was not found. Check your model settings.';
  if (status === 429)
    return 'The provider is busy or your usage limit was reached. Please try again later.';
  if (status === 400 || status === 422) {
    const data = error && typeof error === 'object' && 'data' in error ? error.data : undefined;
    const detail = data && typeof data === 'object' && 'error' in data ? data.error : undefined;
    const param =
      detail && typeof detail === 'object' && 'param' in detail ? detail.param : undefined;
    const known = [
      'max_tokens',
      'max_completion_tokens',
      'max_output_tokens',
      'messages',
      'model',
      'temperature',
      'stream',
      'reasoning_effort',
      'reasoning.effort',
    ];
    return `The provider rejected this request (HTTP ${status}${typeof param === 'string' && known.includes(param) ? `; parameter: ${param}` : ''}). Check the model’s supported API and settings.`;
  }
  if (status === 402) return 'The provider requires billing setup or additional credit (HTTP 402).';
  if (typeof status === 'number')
    return `The provider returned HTTP ${status}. Check your provider settings or try again later.`;
  let cause: unknown = error;
  for (let depth = 0; depth < 5 && cause && typeof cause === 'object'; depth++) {
    const code = 'code' in cause ? cause.code : undefined;
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN')
      return 'The provider address could not be resolved. Check the endpoint and your network connection.';
    if (code === 'ECONNREFUSED')
      return 'The provider refused the connection. Check that the endpoint is correct and the service is running.';
    if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT')
      return 'The connection to the provider timed out. Check your network connection and retry.';
    if (
      [
        'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
        'CERT_HAS_EXPIRED',
        'DEPTH_ZERO_SELF_SIGNED_CERT',
        'SELF_SIGNED_CERT_IN_CHAIN',
      ].includes(String(code))
    )
      return 'The provider’s TLS certificate could not be verified. Check the endpoint and your system’s certificate configuration.';
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  return 'The provider could not complete this response. Check your connection and model settings, then retry.';
}
