import http from 'node:http';
import https from 'node:https';

// Node fetch has its own response-header/body deadlines. ASR uses native HTTP
// so the shared AbortSignal is the actual total budget, including long silence
// while a synchronous recognition request is processed. No proxy or TLS bypass.
export async function asrTransport(url, { method, headers, body, signal }) {
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw Error('Invalid ASR transport URL');
  signal?.throwIfAborted();
  // Use the platform multipart encoder, then send its exact Content-Length.
  // Callers already limit audio chunks to 50 MiB; no media is written here.
  const encoded = new Request(url, { method, headers, body });
  const bytes = Buffer.from(await encoded.arrayBuffer());
  signal?.throwIfAborted();
  const outgoing = Object.fromEntries(encoded.headers);
  outgoing['content-length'] = String(bytes.length);
  return new Promise((resolve, reject) => {
    const request = (target.protocol === 'https:' ? https : http).request(target, { method, headers: outgoing, signal }, response => {
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(response.headers)) {
        for (const entry of Array.isArray(value) ? value : value == null ? [] : [value]) responseHeaders.append(key, entry);
      }
      resolve({ status: response.statusCode, headers: responseHeaders, async text() {
        const parts = []; for await (const part of response) parts.push(part);
        return Buffer.concat(parts).toString('utf8');
      } });
    });
    request.on('error', reject);
    request.end(bytes);
  });
}
