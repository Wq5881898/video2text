// No application-level size or duration ceiling on an original video.
// Provider request limits still apply to the separately encoded audio chunks.
export const MEDIA_UPLOAD_LIMITS = Object.freeze({ maxBytes: null, maxMinutes: null });
export function isSupportedVideoFile(file) {
  return Boolean(file && /\.(mp4|mov|mkv|webm)$/iu.test(file.name)
    && Number.isFinite(file.size) && file.size > 0);
}
export function sourceMediaDuration(probe) {
  const duration = Number(probe?.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0 || !probe.streams?.some(s => s.codec_type === 'audio')) {
    throw Error('需要可讀取有效時長、並含有音軌的媒體');
  }
  return duration;
}
export function mediaWorkTimeoutMs(duration) {
  // Scale local processing allowance with media length, without treating it as
  // an input-duration limit. Respect the JS timer's representable range.
  return Math.min(2147483647, Math.max(180000, Math.ceil(duration * 1000)));
}
