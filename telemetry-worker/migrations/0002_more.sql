-- More usage data (src/schema.js): the computer's graphics, video decoding, processor and
-- power; and per viewing: how watching went (start, seeking, buffering, renditions,
-- bandwidth, the views' sync), how fast the player answered, CPU pressure and battery, what
-- the background analyses downloaded and how soon they were ready, what failed, habits,
-- the usage data's own failures, and the time per unit of the analyses' real work and of
-- the fixed steps that time this computer (*_v: the version of the timed code).
-- JSON columns: quality, pressure, speeds (percent shares); guard_off, net_errors,
-- stream_errors, *_cond (counts).

ALTER TABLE env ADD COLUMN gpu_vendor TEXT;
ALTER TABLE env ADD COLUMN gpu_arch TEXT;
ALTER TABLE env ADD COLUMN gpu_fallback INTEGER;
ALTER TABLE env ADD COLUMN gpu_f16 INTEGER;
ALTER TABLE env ADD COLUMN hw720 INTEGER;
ALTER TABLE env ADD COLUMN hw1080 INTEGER;
ALTER TABLE env ADD COLUMN arch TEXT;
ALTER TABLE env ADD COLUMN bitness INTEGER;
ALTER TABLE env ADD COLUMN os_v INTEGER;
ALTER TABLE env ADD COLUMN mobile INTEGER;
ALTER TABLE env ADD COLUMN charging INTEGER;
ALTER TABLE env ADD COLUMN pressure_api INTEGER;
ALTER TABLE env ADD COLUMN timer_us REAL;
ALTER TABLE sessions ADD COLUMN from_load INTEGER;
ALTER TABLE sessions ADD COLUMN ready_ms INTEGER;
ALTER TABLE sessions ADD COLUMN seek_n INTEGER;
ALTER TABLE sessions ADD COLUMN seek_ms50 REAL;
ALTER TABLE sessions ADD COLUMN seek_ms90 REAL;
ALTER TABLE sessions ADD COLUMN rebuffer_pct REAL;
ALTER TABLE sessions ADD COLUMN quality TEXT;
ALTER TABLE sessions ADD COLUMN level_switches INTEGER;
ALTER TABLE sessions ADD COLUMN bw_kbps REAL;
ALTER TABLE sessions ADD COLUMN sync_ms50 REAL;
ALTER TABLE sessions ADD COLUMN sync_ms_max REAL;
ALTER TABLE sessions ADD COLUMN input_n INTEGER;
ALTER TABLE sessions ADD COLUMN input_ms50 REAL;
ALTER TABLE sessions ADD COLUMN input_ms90 REAL;
ALTER TABLE sessions ADD COLUMN input_slow INTEGER;
ALTER TABLE sessions ADD COLUMN long_tasks INTEGER;
ALTER TABLE sessions ADD COLUMN pressure TEXT;
ALTER TABLE sessions ADD COLUMN battery_pct REAL;
ALTER TABLE sessions ADD COLUMN stream_mb_ph REAL;
ALTER TABLE sessions ADD COLUMN bg_mb_ph REAL;
ALTER TABLE sessions ADD COLUMN cache_hit INTEGER;
ALTER TABLE sessions ADD COLUMN cache_miss INTEGER;
ALTER TABLE sessions ADD COLUMN chapters_ms REAL;
ALTER TABLE sessions ADD COLUMN pdf_ms REAL;
ALTER TABLE sessions ADD COLUMN guard_off TEXT;
ALTER TABLE sessions ADD COLUMN uncaught INTEGER;
ALTER TABLE sessions ADD COLUMN net_errors TEXT;
ALTER TABLE sessions ADD COLUMN stream_errors TEXT;
ALTER TABLE sessions ADD COLUMN watched_pct REAL;
ALTER TABLE sessions ADD COLUMN speeds TEXT;
ALTER TABLE sessions ADD COLUMN skip_silence_sec INTEGER;
ALTER TABLE sessions ADD COLUMN skip_blank_sec INTEGER;
ALTER TABLE sessions ADD COLUMN lang TEXT;
ALTER TABLE sessions ADD COLUMN theme TEXT;
ALTER TABLE sessions ADD COLUMN original_after_sec INTEGER;
ALTER TABLE sessions ADD COLUMN send_fail INTEGER;
ALTER TABLE sessions ADD COLUMN dropped INTEGER;
ALTER TABLE sessions ADD COLUMN timer_us REAL;
ALTER TABLE sessions ADD COLUMN scan_frame_ms50 REAL;
ALTER TABLE sessions ADD COLUMN scan_frame_ms90 REAL;
ALTER TABLE sessions ADD COLUMN scan_frame_n INTEGER;
ALTER TABLE sessions ADD COLUMN silence_min_ms50 REAL;
ALTER TABLE sessions ADD COLUMN silence_min_ms90 REAL;
ALTER TABLE sessions ADD COLUMN silence_min_n INTEGER;
ALTER TABLE sessions ADD COLUMN ocr_mpx_ms50 REAL;
ALTER TABLE sessions ADD COLUMN ocr_mpx_ms90 REAL;
ALTER TABLE sessions ADD COLUMN ocr_mpx_n INTEGER;
ALTER TABLE sessions ADD COLUMN pdf_mpx_ms50 REAL;
ALTER TABLE sessions ADD COLUMN pdf_mpx_ms90 REAL;
ALTER TABLE sessions ADD COLUMN pdf_mpx_n INTEGER;
ALTER TABLE sessions ADD COLUMN luma_v INTEGER;
ALTER TABLE sessions ADD COLUMN luma_p10 REAL;
ALTER TABLE sessions ADD COLUMN luma_p50 REAL;
ALTER TABLE sessions ADD COLUMN luma_p90 REAL;
ALTER TABLE sessions ADD COLUMN luma_n INTEGER;
ALTER TABLE sessions ADD COLUMN luma_cond TEXT;
ALTER TABLE sessions ADD COLUMN loud_v INTEGER;
ALTER TABLE sessions ADD COLUMN loud_p10 REAL;
ALTER TABLE sessions ADD COLUMN loud_p50 REAL;
ALTER TABLE sessions ADD COLUMN loud_p90 REAL;
ALTER TABLE sessions ADD COLUMN loud_n INTEGER;
ALTER TABLE sessions ADD COLUMN loud_cond TEXT;
CREATE INDEX sessions_luma ON sessions (luma_v, luma_p10);
CREATE INDEX sessions_loud ON sessions (loud_v, loud_p10);
