import { recordedRequest } from './model-client.mjs';
import { asrTransport } from './asr-transport.mjs';

export const DEFAULT_ASR_TIMEOUT_MS = 480000;
export function resolveAsrTimeout(value) {
  const timeout = value == null || String(value).trim() === '' ? DEFAULT_ASR_TIMEOUT_MS : Number(value);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 1800000) throw Error('MINIMAX_ASR_TIMEOUT_MS must be an integer from 1 to 1800000');
  return timeout;
}

// The web workflow and full-video evaluation use the same ASR time budget.
// Timeout is a transport setting, not part of the paid request/cache identity.
export function recordedAsrRequest(dir, key, asr, { language = 'yue', ...options }) {
  return recordedRequest(dir, key, {
    ...options, fetchImpl: options.fetchImpl ?? asrTransport, url: asr.endpoint, apiKey: asr.apiKey,
    headers: language === 'auto' ? {} : { language }, timeout: resolveAsrTimeout(asr.timeoutMs),
  });
}
