import fs from 'node:fs';
import path from 'node:path';

export function loadConfig(root, env = process.env) {
  const configRoot = env.VIDEO2TEXT_CONFIG_DIR || path.resolve(root, '../../config');
  const providersFile = path.join(configRoot, 'providers.json');
  const legacyMinimaxFile = path.join(configRoot, 'minimax.json');
  const providersPayload = fs.existsSync(providersFile) ? JSON.parse(fs.readFileSync(providersFile, 'utf8').replace(/^\uFEFF/, '')) : {};
  const minimax = providersPayload.providers?.minimax || (fs.existsSync(legacyMinimaxFile) ? JSON.parse(fs.readFileSync(legacyMinimaxFile, 'utf8').replace(/^\uFEFF/, '')) : {});
  const keyFile = env.GLADIA_KEYS_PATH || path.join(configRoot, 'gladia_keys.txt');
  const keys = fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#')) : [];
  return {
    asr: {
      apiKey: env.MINIMAX_ASR_API_KEY || env.MINIMAX_API_KEY || minimax.api_key || '',
      endpoint: env.MINIMAX_ASR_ENDPOINT || 'https://api.minimax.cn/v1/speech_to_text',
      model: env.MINIMAX_ASR_MODEL || 'asr-1.0',
    },
    gladiaKey: env.GLADIA_API_KEY || keys[Number(env.GLADIA_KEY_INDEX || 0)] || '',
    translation: {
      apiKey: env.TRANSLATION_API_KEY || env.MINIMAX_API_KEY || minimax.api_key || '',
      baseUrl: env.TRANSLATION_BASE_URL || env.MINIMAX_BASE_URL || minimax.base_url || 'https://api.minimaxi.com/v1',
      model: env.TRANSLATION_MODEL || env.MINIMAX_MODEL || minimax.model || 'MiniMax-M3',
    },
    ffmpeg: env.FFMPEG_PATH || 'ffmpeg', ffprobe: env.FFPROBE_PATH || 'ffprobe',
  };
}
