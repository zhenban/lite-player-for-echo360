// Values the player cannot produce, one bit each, stored in a row's `flags`. Only noted: the
// row is stored as sent; the maintainer's queries and the dashboard can leave flagged rows
// out. Each rule allows for rounding, so the real player never sets one (test/telemetry.test.mjs
// runs them over real summaries).
import { KINDS } from './schema.js';

export const FLAGS = {
  playOverOpen: 1,     // played longer than the page was open (play time is wall time while playing)
  workOverOpen: 2,     // a slide or silence analysis took longer than the page was open
  slowFirstFrame: 4,   // first picture after more than two minutes
  chaptersNoSlides: 8, // slide chapters per hour, while no slide source
  streamRate: 16,      // video downloaded per hour of playing outside 20-3000 MB (wide on
                       // purpose: measured so far only 560 MB/h, two views; audio-only
                       // recordings may be far lower; revisit with more data)
  precision: 32,       // a timing with more than the two significant digits the player sends
};

// Fields the player rounds to two significant digits (sig2 in 87-telemetry.js); the schema
// checks them with num2.
const TWO_DIGITS = KINDS.session.filter((f) => f[2].twoDigits).map((f) => f[0]);

// ev: the event as sent; row: its columns as stored (schema.js cleanEvent).
export function flagsOf(kind, ev, row) {
  if (kind !== 'session') return 0;
  let flags = 0;
  const has = (v) => v != null;
  if (has(row.play_sec) && has(row.open_sec) && row.play_sec > row.open_sec * 1.05 + 2) flags |= FLAGS.playOverOpen;
  if (has(row.open_sec) && [row.scan_ms, row.silence_ms].some((ms) => has(ms) && ms > row.open_sec * 1050 + 2000)) flags |= FLAGS.workOverOpen;
  if (has(row.first_frame_ms) && row.first_frame_ms > 120000) flags |= FLAGS.slowFirstFrame;
  if (row.chapters_ph > 0 && row.slide_src === 'none') flags |= FLAGS.chaptersNoSlides;
  if (has(row.stream_mb_ph) && (row.stream_mb_ph < 20 || row.stream_mb_ph > 3000)) flags |= FLAGS.streamRate;
  for (const f of TWO_DIGITS) {
    const v = ev[f];
    if (typeof v === 'number' && Number.isFinite(v) && Number(v.toPrecision(2)) !== v) { flags |= FLAGS.precision; break; }
  }
  return flags;
}
