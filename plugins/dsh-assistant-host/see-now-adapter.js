/**
 * RH04 boundary for the upstream See Now capture adapter.
 *
 * The local machine has no ffmpeg binary, so this adapter intentionally refuses
 * to start a capture. It is not a fake implementation of See Now and does not
 * silently fall back to a different capture path.
 */
export function createSeeNowAdapter({ ffmpegPath = null } = {}) {
  return {
    kind: 'see-now',
    available: false,
    reason: 'ffmpeg-unavailable',
    ffmpegPath,
    status() {
      return {
        available: false,
        reason: 'ffmpeg-unavailable',
        started: false,
        captured: false,
      };
    },
    start() {
      return {
        ok: false,
        error: 'ffmpeg-unavailable',
        message: 'See Now capture needs ffmpeg; use the synthetic observation service until it is installed.',
      };
    },
    pause() {
      return { ok: true, started: false };
    },
    stop() {
      return { ok: true, started: false };
    },
  };
}
