import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectMediaTools, publicMediaStatus } from '../media-tools.mjs';
import { serviceStateKey, message } from '../public/cantones-i18n.mjs';

test('each tool must execute and identify itself; a working ffmpeg cannot mask a broken ffprobe', async () => {
  const tools = await inspectMediaTools({ ffmpeg: '/private/ffmpeg', ffprobe: '/private/ffprobe' }, {
    run: async (command, args) => {
      assert.deepEqual(args, ['-version']);
      if (command.endsWith('ffprobe')) throw Error('无法启动 ffprobe：ENOENT');
      return 'ffmpeg version synthetic-build\nconfiguration: hidden';
    },
  });
  assert.equal(tools.ffmpeg.ready, true); assert.equal(tools.ffprobe.ready, false);
  assert.equal(tools.ffprobe.reason, 'not-found');
  assert.deepEqual(publicMediaStatus(tools), { ffmpeg: { ready: true, reason: null }, ffprobe: { ready: false, reason: 'not-found' } });
  assert.ok(!JSON.stringify(publicMediaStatus(tools)).includes('private'));
});

test('startup diagnostics distinguish permissions, timeout, failed execution and unexpected executable output', async () => {
  for (const [error, reason] of [[Error('EACCES secret-path'), 'permission-denied'], [Error('音视频处理超时'), 'timeout'], [Error('exit 127 hidden-loader-error'), 'execution-failed']]) {
    const tools = await inspectMediaTools({}, { run: async () => { throw error; } });
    assert.equal(tools.ffmpeg.reason, reason); assert.equal(tools.ffprobe.reason, reason);
    assert.ok(!JSON.stringify(tools).includes(error.message));
  }
  const tools = await inspectMediaTools({}, { run: async () => 'some other program' });
  assert.equal(tools.ffmpeg.reason, 'unexpected-output');
});

test('both UI languages identify media readiness failures and retain the configuration gate', () => {
  assert.equal(serviceStateKey(null), 'checking');
  assert.equal(serviceStateKey({ configured: false, asr: true, translation: true, mediaTools: false }), 'mediaUnavailable');
  assert.match(message('zh-Hant', 'mediaUnavailable'), /媒體處理工具/);
  assert.match(message('en', 'mediaUnavailable'), /Media processing tools/);
  assert.equal(serviceStateKey({ configured: false, mediaTools: true }), 'unconfigured');
  assert.equal(serviceStateKey({ configured: true, mediaTools: true }), 'ready');
});
