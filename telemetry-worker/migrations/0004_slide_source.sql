-- D1 allows at most 100 columns a table, and sessions had 100. The timings that only the
-- maintainer's queries read move into two JSON columns (the Worker builds them from the
-- same fields the player sends, so older players are unaffected):
--   work   {scanFrame|silenceMin|ocrMpx|pdfMpx: {ms50, ms90, n}}  (was <name>_ms50/_ms90/_n)
--   steps  {luma|loud: {v, p10, p50, p90, n, cond}}               (was <name>_v/_p10/...)
-- Then two new columns: what the slide chapters came from (slide_src: frames, the video's
-- keyframes; thumbs, Echo360's per-minute preview pictures only; none) and why the keyframe
-- scan stopped early, if it did (slide_stop: noWebCodecs, the browser cannot decode video
-- frames; noFrame, the decoder gave no picture; decoder; playlist; network; other).
--
-- A column cannot be added before others are dropped (it would be the 101st), so the JSON
-- is kept aside first. json_patch('{}', x) leaves out the keys whose value is NULL.

CREATE TABLE sessions_json (id INTEGER PRIMARY KEY, work TEXT, steps TEXT);

INSERT INTO sessions_json (id, work, steps)
SELECT id,
  NULLIF(json_patch('{}', json_object(
    'scanFrame', NULLIF(json_patch('{}', json_object('ms50', scan_frame_ms50, 'ms90', scan_frame_ms90, 'n', scan_frame_n)), '{}'),
    'silenceMin', NULLIF(json_patch('{}', json_object('ms50', silence_min_ms50, 'ms90', silence_min_ms90, 'n', silence_min_n)), '{}'),
    'ocrMpx', NULLIF(json_patch('{}', json_object('ms50', ocr_mpx_ms50, 'ms90', ocr_mpx_ms90, 'n', ocr_mpx_n)), '{}'),
    'pdfMpx', NULLIF(json_patch('{}', json_object('ms50', pdf_mpx_ms50, 'ms90', pdf_mpx_ms90, 'n', pdf_mpx_n)), '{}')
  )), '{}'),
  NULLIF(json_patch('{}', json_object(
    'luma', NULLIF(json_patch('{}', json_object('v', luma_v, 'p10', luma_p10, 'p50', luma_p50, 'p90', luma_p90, 'n', luma_n, 'cond', json(luma_cond))), '{}'),
    'loud', NULLIF(json_patch('{}', json_object('v', loud_v, 'p10', loud_p10, 'p50', loud_p50, 'p90', loud_p90, 'n', loud_n, 'cond', json(loud_cond))), '{}')
  )), '{}')
FROM sessions;

DROP INDEX sessions_luma;
DROP INDEX sessions_loud;

ALTER TABLE sessions DROP COLUMN scan_frame_ms50;
ALTER TABLE sessions DROP COLUMN scan_frame_ms90;
ALTER TABLE sessions DROP COLUMN scan_frame_n;
ALTER TABLE sessions DROP COLUMN silence_min_ms50;
ALTER TABLE sessions DROP COLUMN silence_min_ms90;
ALTER TABLE sessions DROP COLUMN silence_min_n;
ALTER TABLE sessions DROP COLUMN ocr_mpx_ms50;
ALTER TABLE sessions DROP COLUMN ocr_mpx_ms90;
ALTER TABLE sessions DROP COLUMN ocr_mpx_n;
ALTER TABLE sessions DROP COLUMN pdf_mpx_ms50;
ALTER TABLE sessions DROP COLUMN pdf_mpx_ms90;
ALTER TABLE sessions DROP COLUMN pdf_mpx_n;
ALTER TABLE sessions DROP COLUMN luma_v;
ALTER TABLE sessions DROP COLUMN luma_p10;
ALTER TABLE sessions DROP COLUMN luma_p50;
ALTER TABLE sessions DROP COLUMN luma_p90;
ALTER TABLE sessions DROP COLUMN luma_n;
ALTER TABLE sessions DROP COLUMN luma_cond;
ALTER TABLE sessions DROP COLUMN loud_v;
ALTER TABLE sessions DROP COLUMN loud_p10;
ALTER TABLE sessions DROP COLUMN loud_p50;
ALTER TABLE sessions DROP COLUMN loud_p90;
ALTER TABLE sessions DROP COLUMN loud_n;
ALTER TABLE sessions DROP COLUMN loud_cond;

ALTER TABLE sessions ADD COLUMN work TEXT;
ALTER TABLE sessions ADD COLUMN steps TEXT;
ALTER TABLE sessions ADD COLUMN slide_src TEXT;
ALTER TABLE sessions ADD COLUMN slide_stop TEXT;

UPDATE sessions SET
  work = (SELECT j.work FROM sessions_json j WHERE j.id = sessions.id),
  steps = (SELECT j.steps FROM sessions_json j WHERE j.id = sessions.id);

DROP TABLE sessions_json;

-- The fixed-step queries pick rows by version and order by the 10th percentile.
CREATE INDEX sessions_luma ON sessions (json_extract(steps, '$.luma.v'), json_extract(steps, '$.luma.p10'));
CREATE INDEX sessions_loud ON sessions (json_extract(steps, '$.loud.v'), json_extract(steps, '$.loud.p10'));
