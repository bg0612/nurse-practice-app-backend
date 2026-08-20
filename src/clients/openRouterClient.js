// backend/src/clients/openRouterClient.js
import { ApiError } from '../errors/apiError.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_OPENROUTER_TIMEOUT_MS = 20000;

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function parseTimeoutMs(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Thin OpenRouter chat client for M5 (patient reply) and M6 (feedback).
 * Model id comes from LLM_MODEL in .env — swap without changing callers.
 *
 * @param {object} opts
 * @param {string} opts.model
 * @param {string} [opts.apiKey]
 * @param {'mock' | 'live'} [opts.mode='mock']
 * @param {typeof fetch} [opts.fetchImpl]
 */
export function createOpenRouterClient({
  model,
  apiKey,
  mode = 'mock',
  fetchImpl = globalThis.fetch,
}) {
  if (!model) {
    throw new Error('createOpenRouterClient: model is required');
  }

  /**
   * @param {object} params
   * @param {Array<{ role: string, content: string }>} params.messages
   * @param {number} [params.temperature]
   * @param {object} [params.responseFormat]
   * @returns {Promise<{ content: string, model: string, mock: boolean }>}
   */
  async function chatCompletion({ messages, temperature = 0.7, responseFormat }) {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new ApiError({
        code: 'PROVIDER_BAD_REQUEST',
        message: 'OpenRouter chat requires at least one message.',
        retryable: false,
        status: 400,
      });
    }

    if (mode === 'mock') {
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      const snippet = (lastUser?.content ?? '').slice(0, 80);
      const allText = messages.map((m) => String(m.content ?? '')).join('\n');

      // M5 patient-reply: return schema-valid JSON so default mock E2E works without injects.
      if (/Latest student utterance|patient-reply/i.test(allText) && /answerId|stageId|FALLBACK/i.test(allText)) {
        const judgmental =
          /shouldn't|should not|lazy|unacceptable|no excuses|stop being defensive|complications will end/i.test(
            allText,
          );
        return {
          content: JSON.stringify(
            judgmental
              ? {
                  tone: 'bad',
                  stageId: 'healthy_coping',
                  answerId: 'B',
                }
              : {
                  tone: 'good',
                  stageId: 'lifestyle_exploration',
                  answerId: 'A',
                },
          ),
          model,
          mock: true,
        };
      }

      return {
        content: JSON.stringify({
          mock: true,
          model,
          echo: snippet,
          note: 'Deterministic OpenRouter mock — no network call',
        }),
        model,
        mock: true,
      };
    }

    if (!apiKey) {
      throw new ApiError({
        code: 'PROVIDER_MISCONFIGURED',
        message: 'OPENROUTER_API_KEY is not configured on the server.',
        retryable: false,
        status: 500,
      });
    }

    let response;
    const controller = new AbortController();
    const timeoutMs = parseTimeoutMs(
      process.env.OPENROUTER_TIMEOUT_MS,
      DEFAULT_OPENROUTER_TIMEOUT_MS,
    );
    const timeoutId = setTimeout(() => {
      controller.abort(new Error(`OpenRouter timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    try {
      response = await fetchImpl(OPENROUTER_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'http://localhost',
          'X-Title': 'Nursing AI Patient Dialogue Simulator',
        },
        body: JSON.stringify({
          model,
          messages,
          temperature,
          ...(responseFormat ? { response_format: responseFormat } : {}),
        }),
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new ApiError({
          code: 'PROVIDER_TIMEOUT',
          message: 'OpenRouter request timed out. Please try again.',
          retryable: true,
          status: 504,
          details: { timeoutMs },
        });
      }
      throw new ApiError({
        code: 'PROVIDER_UNAVAILABLE',
        message: 'OpenRouter request failed. Please try again.',
        retryable: true,
        status: 502,
        details: err instanceof Error ? err.message : String(err),
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      throw new ApiError({
        code: 'PROVIDER_ERROR',
        message: 'OpenRouter returned an error. Please try again.',
        retryable: response.status >= 500 || response.status === 429,
        status: 502,
        details: { status: response.status, body: bodyText.slice(0, 500) },
      });
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new ApiError({
        code: 'PROVIDER_BAD_RESPONSE',
        message: 'OpenRouter returned an unexpected response.',
        retryable: true,
        status: 502,
      });
    }

    return { content, model: data.model ?? model, mock: false };
  }

  return {
    provider: 'openrouter',
    model,
    mode,
    chatCompletion,
  };
}
