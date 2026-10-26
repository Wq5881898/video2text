import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readJson, writeJson } from './pipeline.mjs';
import { providerIdentity, classifyProviderFailure, assertProviderAvailable, recordProviderFailure, recordProviderSuccess } from './provider-runtime.mjs';

export const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export async function digestFile(file) {
  const hash = createHash('sha256'); for await (const bytes of createReadStream(file)) hash.update(bytes); return hash.digest('hex');
}
export function messagesEndpoint(baseUrl) {
  const url = new URL(baseUrl);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('无效的模型地址');
  return `${url.origin}/anthropic/v1/messages`;
}

// Requests have a durable intent BEFORE sending. Unknown network outcomes are
// never silently retried. Explicit overloads pause requests to the same model.
export async function recordedRequest(dir, key, { url, apiKey, body, headers = {}, timeout = 180000, identity, retryUnknown = false, fetchImpl = globalThis.fetch, runtime = {} }) {
  if (!/^[a-zA-Z0-9_-]+$/.test(key)) throw new Error('Invalid request key');
  const folder = path.join(dir, 'requests'); await fs.mkdir(folder, { recursive: true });
  const legacyFingerprint = digest({ request: identity ?? body, credentialHash: digest(apiKey) });
  const fingerprint = digest({ url, request: identity ?? body, credentialHash: digest(apiKey) });
  const serviceId = providerIdentity({ url, apiKey, model: identity?.model ?? body?.model });
  let lastFailure = null;
  for (let attempt = 0; attempt < 10000; attempt++) {
    const file = path.join(folder, `${key}-${attempt}`);
    let response = await readJson(`${file}-response.json`);
    const intent = await readJson(`${file}-intent.json`);
    if (intent && intent.fingerprint !== fingerprint && !(intent.fingerprint === legacyFingerprint && intent.url === url)) throw new Error('请求缓存版本不一致，不能混用旧结果');
    // Successful caches are usable even while the provider is cooling down.
    if (response) {
      const failure = classifyProviderFailure(response.status, response.payload);
      if (!failure) return response.payload;
      if (!failure.retryable && !failure.delayMs) throw await recordProviderFailure(serviceId, response.status, response.payload, runtime);
      lastFailure = response;
      continue;
    }
    if (!response && intent && !retryUnknown) throw new Error('上一请求结果未知；请先核对服务商记录，再选择“允许重发未知请求”。可能再次消耗额度。');
    if (!response) {
      const state = await assertProviderAvailable(serviceId, runtime);
      // Backfill health state for records made by the earlier client.
      const priorFailure = lastFailure && classifyProviderFailure(lastFailure.status, lastFailure.payload);
      if (!state.checkedAt && priorFailure && Date.parse(lastFailure.at) + priorFailure.delayMs > (runtime.now?.() ?? Date.now())) {
        throw await recordProviderFailure(serviceId, lastFailure.status, lastFailure.payload, runtime);
      }
      if (intent) {
        const stamp = Date.now();
        await writeJson(`${file}-unknown-${stamp}.json`, intent);
        const interrupted = await readJson(`${file}-interrupted.json`);
        if (interrupted) await writeJson(`${file}-unknown-${stamp}-interrupted.json`, interrupted);
      }
      await writeJson(`${file}-intent.json`, { at: new Date().toISOString(), url, fingerprint, attempt, model: identity?.model ?? body?.model ?? null, timeoutMs: timeout, explicitUnknownRetry: Boolean(intent) });
      // Never persist authorization, key or multipart audio bytes.
      if (!(body instanceof FormData)) await writeJson(`${file}-input.json`, body);
      let raw, httpStatus = null, phase = 'awaiting-response-headers';
      const started = Date.now(), signal = AbortSignal.timeout(timeout);
      try {
        const r = await fetchImpl(url, { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${apiKey}`, ...headers }, body: body instanceof FormData ? body : JSON.stringify(body), signal });
        httpStatus = r.status; phase = 'reading-response-body';
        raw = (await r.text()).replaceAll(apiKey, '[REDACTED]');
        let payload; try { payload = JSON.parse(raw); } catch { payload = { nonJsonResponse: raw.slice(0, 2000) }; }
        response = { status: r.status, at: new Date().toISOString(), payload, retryAfter: r.headers.get('retry-after') };
        phase = 'saving-response'; await writeJson(`${file}-response.json`, response);
      } catch (error) {
        const timeoutError = error.name === 'TimeoutError' || signal.aborted && signal.reason?.name === 'TimeoutError';
        const code = String(error.code ?? error.cause?.code ?? '');
        await writeJson(`${file}-interrupted.json`, { at: new Date().toISOString(), outcome: 'unknown', kind: timeoutError ? 'timeout' : 'interrupted', phase, httpStatus, timeoutMs: timeout, elapsedMs: Date.now() - started, transportCode: /^[A-Z0-9_]{1,80}$/u.test(code) ? code : null });
        throw new Error(`模型请求结果未知，已保留提交记录；未自动重发。${timeoutError ? 'TimeoutError' : error.name}`);
      }
    }
    const failure = await recordProviderFailure(serviceId, response.status, response.payload, { ...runtime, retryAfter: response.retryAfter });
    if (failure) throw failure;
    await recordProviderSuccess(serviceId, runtime);
    return response.payload;
  }
  throw new Error('请求记录数量超出限制，请检查本地任务记录');
}

export async function modelTool(dir, key, config, { prompt, input, tool, images = [], validate, retryUnknown = false, fetchImpl, runtime = {}, maxTokens = 12000, maxRepairs = 2, timeout = 180000 }) {
  const content = [{ type: 'text', text: JSON.stringify(input) }];
  for (const frame of images) {
    content.push({ type: 'text', text: `${frame.id}：原视频 ${frame.time} 秒` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: (await fs.readFile(frame.path)).toString('base64') } });
  }
  const body = { model: config.model, max_tokens: maxTokens, system: prompt, messages: [{ role: 'user', content }], tools: [tool], tool_choice: { type: 'tool', name: tool.name } };
  // M3.1-Flash requires thinking; M3 permits disabled. No temperature claim:
  // the provider currently ignores that parameter for M3.
  if (!/M3\.1/i.test(config.model)) body.thinking = { type: 'disabled' };
  let last;
  for (let repair = 0; repair <= maxRepairs; repair++) {
    const payload = await recordedRequest(dir, `${key}-schema${repair}`, { url: messagesEndpoint(config.baseUrl), apiKey: config.apiKey, headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }, body, retryUnknown, fetchImpl, runtime, timeout });
    try {
      if (payload.stop_reason === 'max_tokens') throw new Error('模型输出被截断');
      const block = payload.content?.find(item => item.type === 'tool_use' && item.name === tool.name);
      let structured;
      if (block) structured = typeof block.input === 'string' ? JSON.parse(block.input) : block.input;
      else {
        // Some M3 responses use end_turn JSON text despite tool_choice. Accept
        // a complete JSON value only, with exactly the same strict validator.
        const text = payload.content?.filter(item => item.type === 'text').map(item => item.text).join('\n').trim() ?? '';
        const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/u);
        structured = JSON.parse(fence ? fence[1] : text);
      }
      const result = validate(structured);
      await writeJson(path.join(dir, 'requests', `${key}-accepted.json`), { model: config.model, mode: block ? 'tool_use' : 'json_text', resultHash: digest(result) });
      return result;
    } catch (error) {
      last = error; body.messages[0].content[0].text = JSON.stringify({ ...input, schemaRepair: `上次输出校验未通过：${error.message}。重新完整输出，不修改源ID或时间。` });
    }
  }
  throw new Error(`结构化校验未通过：${last.message}`);
}
