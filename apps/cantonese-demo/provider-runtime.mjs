import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readJson, writeJson } from './pipeline.mjs';

const DEFAULT_HEALTH_DIR = process.env.CANTONES_DATA_DIR ? path.join(process.env.CANTONES_DATA_DIR, 'provider-health') : fileURLToPath(new URL('./.data/provider-health/', import.meta.url));
const nowMs = options => options.now ? options.now() : Date.now();
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const DEFAULT_COOLDOWN_MS = 60_000;
export const PREFLIGHT_TTL_MS = 5 * 60_000;

export function providerIdentity({ url, model, apiKey }) {
  return hash({ url, model: model ?? null, credentialHash: hash(apiKey) });
}
function stateFile(identity, options) {
  return path.join(options.healthDir ?? DEFAULT_HEALTH_DIR, identity + '.json');
}
async function writeHealth(identity, options, value) {
  await writeJson(stateFile(identity, options), value);
}
export function retryAfterMs(value, now = Date.now()) {
  if (value == null || value === '') return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}
export function classifyProviderFailure(status, payload) {
  const businessError = Number(payload?.base_resp?.status_code) > 0 || payload?.type === 'error' || Boolean(payload?.error);
  if (status >= 200 && status < 300 && !businessError) return null;
  // Inspect error fields only; successful model text may mention these words.
  const detail = JSON.stringify(payload?.error ?? payload?.base_resp ?? payload ?? '').slice(0, 6000);
  if (status === 402 || /insufficient.(?:balance|credit|fund|quota)|billing|quota.exceed|exceeded.*quota|余额不足|额度.*(?:不足|用尽)/iu.test(detail)) return { kind: 'quota', retryable: false, delayMs: 300_000 };
  if ([401, 403].includes(status)) return { kind: 'authentication', retryable: false, delayMs: 300_000 };
  if (status === 529 || /at capacity|overload|capacity.exceed|model.*busy|模型.*(?:繁忙|容量)|服务.*繁忙/iu.test(detail)) return { kind: 'capacity', retryable: true, delayMs: DEFAULT_COOLDOWN_MS };
  if (status === 429 || /rate.limit|too many requests|限流|请求.*频繁/iu.test(detail)) return { kind: 'rate_limit', retryable: true, delayMs: DEFAULT_COOLDOWN_MS };
  if ([502, 503, 504].includes(status)) return { kind: 'unavailable', retryable: true, delayMs: DEFAULT_COOLDOWN_MS };
  if (status === 404) return { kind: 'configuration', retryable: false, delayMs: 300_000 };
  return { kind: 'request', retryable: false, delayMs: 0 };
}

export class ProviderServiceError extends Error {
  constructor(failure, now = Date.now()) {
    const reason = {
      capacity: '模型容量不足', rate_limit: '模型请求频率受限',
      unavailable: '模型服务暂时不可用', quota: '模型服务余额或额度不足',
      authentication: '模型服务认证或权限被拒绝', configuration: '模型名称或接口路径不可用',
      request: '模型服务拒绝了请求',
    }[failure.kind] ?? '模型服务请求失败';
    const waiting = failure.retryAt && Date.parse(failure.retryAt) > now;
    const advice = ['authentication', 'configuration', 'quota'].includes(failure.kind)
      ? '请检查对应服务的 Key、模型、权限或额度。'
      : '可稍后点击继续；已完成的请求会复用。';
    super(reason + '（HTTP ' + failure.httpStatus + '）。' + (waiting ? '已暂停，约 ' + Math.ceil((Date.parse(failure.retryAt) - now) / 1000) + ' 秒后可再检查。' : '') + advice);
    this.name = 'ProviderServiceError';
    this.code = 'PROVIDER_' + failure.kind.toUpperCase();
    this.kind = failure.kind;
    this.httpStatus = failure.httpStatus;
    this.retryAt = failure.retryAt ?? null;
  }
}

export async function providerHealth(identity, options = {}) {
  const state = await readJson(stateFile(identity, options), {});
  return { ...state, blocked: Date.parse(state.retryAt ?? '') > nowMs(options) };
}
export async function assertProviderAvailable(identity, options = {}) {
  const state = await providerHealth(identity, options);
  if (state.blocked) throw new ProviderServiceError(state, nowMs(options));
  return state;
}
export async function recordProviderFailure(identity, status, payload, { retryAfter, ...options } = {}) {
  const failure = classifyProviderFailure(status, payload);
  if (!failure) return null;
  const now = nowMs(options);
  const delayMs = Math.max(failure.delayMs, retryAfterMs(retryAfter, now));
  const state = { ...failure, httpStatus: status, checkedAt: new Date(now).toISOString(), retryAt: delayMs ? new Date(now + delayMs).toISOString() : null };
  // A request/schema error does not establish that the whole provider is down.
  if (delayMs) await writeHealth(identity, options, state);
  return new ProviderServiceError(state, now);
}
export async function recordProviderSuccess(identity, options = {}) {
  const previous = await providerHealth(identity, options), now = nowMs(options);
  if (previous.blocked) return;
  await writeHealth(identity, options, {
    kind: 'available', checkedAt: new Date(now).toISOString(),
    preflightUntil: previous.preflightUntil ?? null, retryAt: null,
  });
}
export async function recordPreflightSuccess(identity, options = {}) {
  const now = nowMs(options);
  await assertProviderAvailable(identity, options);
  await writeHealth(identity, options, {
    kind: 'available', checkedAt: new Date(now).toISOString(),
    preflightUntil: new Date(now + PREFLIGHT_TTL_MS).toISOString(), retryAt: null,
  });
}

export function providerErrorStatus(error) {
  return error instanceof ProviderServiceError
    ? { errorCode: error.code, errorKind: error.kind, httpStatus: error.httpStatus, retryAt: error.retryAt }
    : {};
}
