-- Load on the computer and how watching went, per version (sessions of at least a minute of
-- playback, last 30 days): median and 90th percentile of each measure (for the measures that
-- are themselves percentiles of a viewing, of the viewing's median or 90th percentile, as
-- named). Times in ms.
WITH -- The timings under their former column names (migration 0004 moved them into JSON).
t AS (
  SELECT sessions.*,
         json_extract(work, '$.scanFrame.ms50') AS scan_frame_ms50,
         json_extract(work, '$.scanFrame.ms90') AS scan_frame_ms90,
         json_extract(work, '$.scanFrame.n') AS scan_frame_n,
         json_extract(work, '$.silenceMin.ms50') AS silence_min_ms50,
         json_extract(work, '$.silenceMin.ms90') AS silence_min_ms90,
         json_extract(work, '$.silenceMin.n') AS silence_min_n,
         json_extract(work, '$.ocrMpx.ms50') AS ocr_mpx_ms50,
         json_extract(work, '$.ocrMpx.ms90') AS ocr_mpx_ms90,
         json_extract(work, '$.ocrMpx.n') AS ocr_mpx_n,
         json_extract(work, '$.pdfMpx.ms50') AS pdf_mpx_ms50,
         json_extract(work, '$.pdfMpx.ms90') AS pdf_mpx_ms90,
         json_extract(work, '$.pdfMpx.n') AS pdf_mpx_n,
         json_extract(steps, '$.luma.v') AS luma_v,
         json_extract(steps, '$.luma.p10') AS luma_p10,
         json_extract(steps, '$.luma.p50') AS luma_p50,
         json_extract(steps, '$.luma.p90') AS luma_p90,
         json_extract(steps, '$.luma.n') AS luma_n,
         json_extract(steps, '$.loud.v') AS loud_v,
         json_extract(steps, '$.loud.p10') AS loud_p10,
         json_extract(steps, '$.loud.p50') AS loud_p50,
         json_extract(steps, '$.loud.p90') AS loud_p90,
         json_extract(steps, '$.loud.n') AS loud_n
  FROM sessions
),
s AS (
  SELECT * FROM t
  WHERE play_sec >= 60 AND at > (strftime('%s', 'now') - 30 * 86400) * 1000
),
ranked AS (
  SELECT version, metric, value,
         ROW_NUMBER() OVER (PARTITION BY version, metric ORDER BY value) AS r,
         COUNT(*) OVER (PARTITION BY version, metric) AS n
  FROM (
    -- One row per session and metric (D1 allows only a few UNION terms).
    SELECT version, m.value AS metric,
           CASE m.value
             WHEN 'long_tasks_per_min' THEN long_tasks_pm
             WHEN 'dropped_pct' THEN dropped_pct
             WHEN 'heap_mb' THEN heap_mb
             WHEN 'first_frame_ms' THEN first_frame_ms
             WHEN 'rebuffer_per_hour' THEN rebuffer_n * 3600.0 / play_sec
             WHEN 'scan_ms' THEN scan_ms
             WHEN 'ocr_frame_ms' THEN ocr_frame_ms
             WHEN 'silence_ms' THEN silence_ms
             WHEN 'ready_ms' THEN ready_ms
             WHEN 'seek_ms_p90' THEN seek_ms90
             WHEN 'rebuffer_pct' THEN rebuffer_pct
             WHEN 'sync_ms_max' THEN sync_ms_max
             WHEN 'input_ms_p90' THEN input_ms90
             WHEN 'slow_inputs_pct' THEN 100.0 * input_slow / input_n
             WHEN 'chapters_ms' THEN chapters_ms
             WHEN 'pdf_ms' THEN pdf_ms
             WHEN 'scan_frame_ms' THEN scan_frame_ms50
             WHEN 'silence_min_ms' THEN silence_min_ms50
             WHEN 'ocr_mpx_ms' THEN ocr_mpx_ms50
             WHEN 'pdf_mpx_ms' THEN pdf_mpx_ms50
           END AS value
    FROM s, json_each('["long_tasks_per_min","dropped_pct","heap_mb","first_frame_ms","rebuffer_per_hour","scan_ms","ocr_frame_ms","silence_ms","ready_ms","seek_ms_p90","rebuffer_pct","sync_ms_max","input_ms_p90","slow_inputs_pct","chapters_ms","pdf_ms","scan_frame_ms","silence_min_ms","ocr_mpx_ms","pdf_mpx_ms"]') m
  )
  WHERE value IS NOT NULL
)
SELECT version, metric, MAX(n) AS sessions,
       MAX(CASE WHEN r = (n + 1) / 2 THEN value END) AS median,
       MAX(CASE WHEN r = MAX(1, (n * 9 + 9) / 10) THEN value END) AS p90
FROM ranked
GROUP BY version, metric
ORDER BY version DESC, metric;
