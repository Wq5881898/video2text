import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { modelTool, messagesEndpoint } from './model-client.mjs';
import { assertProviderAvailable, providerHealth, providerIdentity, recordPreflightSuccess } from './provider-runtime.mjs';

const pending = new Map();
const PROBE_TOOL = {
  name: 'submit_service_check',
  description: 'Return the service connectivity check.',
  input_schema: {
    type: 'object', additionalProperties: false, required: ['ok'],
    properties: { ok: { type: 'boolean', enum: [true] } },
  },
};
function endpoint(value, label) {
  let url;
  try { url = new URL(value); } catch { throw new Error(label + '地址格式无效'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(label + '地址格式无效');
  return url.href;
}
export function validatePreflightConfig(config, { source = true, mediaTools = true } = {}) {
  if (!mediaTools) throw new Error('FFmpeg / FFprobe 尚不可用，请先安装或配置路径');
  if (!config.translation?.apiKey?.trim() || !config.translation?.model?.trim()) throw new Error('审校／翻译 Key 或模型名称未配置');
  endpoint(config.translation.baseUrl, '审校／翻译');
  if (source) {
    if (!config.asr?.apiKey?.trim() || !config.asr?.model?.trim()) throw new Error('ASR Key 或模型名称未配置');
    endpoint(config.asr.endpoint, 'ASR');
  }
}
export async function inspectServices(config, runtime = {}) {
  const inspect = async (url, spec) => {
    if (!spec?.apiKey || !spec?.model || !url) return { kind: 'unconfigured', blocked: false };
    const state = await providerHealth(providerIdentity({ url, model: spec.model, apiKey: spec.apiKey }), runtime);
    return { kind: state.kind ?? 'unchecked', blocked: state.blocked, checkedAt: state.checkedAt ?? null, retryAt: state.retryAt ?? null };
  };
  return {
    translation: await inspect(config.translation?.baseUrl ? messagesEndpoint(config.translation.baseUrl) : null, config.translation),
    asr: await inspect(config.asr?.endpoint, config.asr),
  };
}
export async function assertServiceAvailability(config, { source = true, ...runtime } = {}) {
  await assertProviderAvailable(providerIdentity({ url: messagesEndpoint(config.translation.baseUrl), model: config.translation.model, apiKey: config.translation.apiKey }), runtime);
  if (source) await assertProviderAvailable(providerIdentity({ url: config.asr.endpoint, model: config.asr.model, apiKey: config.asr.apiKey }), runtime);
}
export async function preflight(config, { source = true, mediaTools = true, healthDir, now, fetchImpl } = {}) {
  validatePreflightConfig(config, { source, mediaTools });
  const runtime = { healthDir, now };
  await assertServiceAvailability(config, { source, ...runtime });
  const identity = providerIdentity({ url: messagesEndpoint(config.translation.baseUrl), model: config.translation.model, apiKey: config.translation.apiKey });
  const state = await providerHealth(identity, runtime);
  const report = cached => ({
    ok: true, model: config.translation.model, cached,
    checkedAt: cached ? state.checkedAt : new Date(now?.() ?? Date.now()).toISOString(),
    textToolsVerified: true, visualVerified: false,
    asr: source ? 'configuration-only' : 'not-needed',
    message: '审校／翻译连接与结构化响应已验证。' + (source ? 'ASR 已检查配置，权限及识别效果在首个真实音频块确认。' : ''),
  });
  if (Date.parse(state.preflightUntil ?? '') > (now?.() ?? Date.now())) return report(true);
  // Repeated clicks within one server share the same small probe.
  const key = path.resolve(healthDir ?? '.') + ':' + identity;
  if (pending.has(key)) return pending.get(key);
  const check = (async () => {
    // Separate probes have unique ledgers. A timeout stops this attempt; a later
    // explicit check uses a new ledger without replaying any subtitle/audio.
    const dir = healthDir ?? (process.env.CANTONES_DATA_DIR ? path.join(process.env.CANTONES_DATA_DIR, 'provider-health') : fileURLToPath(new URL('./.data/provider-health/', import.meta.url)));
    const probePath = path.join(dir, 'probes');
    await modelTool(probePath, 'preflight-' + randomUUID(), config.translation, {
      prompt: 'Connectivity check. Call submit_service_check with ok=true. No explanation.',
      input: { check: true }, tool: PROBE_TOOL, maxTokens: 256, maxRepairs: 0, timeout: 30000, fetchImpl, runtime,
      validate: payload => {
        if (payload?.ok !== true || Object.keys(payload).length !== 1) throw new Error('服务检查未获得约定的结构化响应');
        return payload;
      },
    });
    await recordPreflightSuccess(identity, runtime);
    return report(false);
  })();
  pending.set(key, check);
  try { return await check; } finally { pending.delete(key); }
}
