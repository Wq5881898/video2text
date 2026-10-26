import { runProcess } from './pipeline.mjs';

function failureReason(error) {
  const detail = `${error?.code ?? ''} ${error?.message ?? ''}`;
  if (/ENOENT/u.test(detail)) return 'not-found';
  if (/EACCES|EPERM/u.test(detail)) return 'permission-denied';
  if (/timeout|超时/iu.test(detail)) return 'timeout';
  return 'execution-failed';
}

// Startup, operator diagnostics and tests use the same executable checks.
// Only stable reason codes are exposed by the public configuration endpoint.
export async function inspectMediaTools(config, { run = runProcess, timeout = 10000 } = {}) {
  return Object.fromEntries(await Promise.all(['ffmpeg', 'ffprobe'].map(async name => {
    try {
      const output = await run(config[name], ['-version'], timeout);
      const version = String(output).split(/\r?\n/u).find(line => line.startsWith(`${name} version `));
      if (!version) return [name, { ready: false, reason: 'unexpected-output' }];
      return [name, { ready: true, reason: null, version: version.slice(0, 200) }];
    } catch (error) {
      return [name, { ready: false, reason: failureReason(error) }];
    }
  })));
}

export function publicMediaStatus(tools) {
  return Object.fromEntries(Object.entries(tools).map(([name, result]) => [name, { ready: result.ready, reason: result.reason }]));
}
