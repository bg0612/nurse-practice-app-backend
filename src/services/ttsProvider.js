import { ApiError } from '../errors/apiError.js';

/**
 * Provider-neutral synthesis input.
 *
 * @typedef {object} TtsSynthesisRequest
 * @property {string} text
 * @property {string} voiceId
 * @property {string} language
 * @property {string} outputFormat
 * @property {string} [rate]
 * @property {string} [pitch]
 */

/**
 * @typedef {object} TtsSynthesisResult
 * @property {string} mediaType
 * @property {Uint8Array} audio
 */

/**
 * Runtime assertion for the replaceable TtsProvider contract.
 *
 * @param {unknown} provider
 * @returns {asserts provider is { synthesize(request: TtsSynthesisRequest): Promise<TtsSynthesisResult> }}
 */
export function assertTtsProvider(provider) {
  if (!provider || typeof provider !== 'object' || typeof provider.synthesize !== 'function') {
    throw new ApiError({
      code: 'TTS_FAILED',
      message: 'Patient speech is temporarily unavailable.',
      retryable: true,
      status: 503,
    });
  }
}

