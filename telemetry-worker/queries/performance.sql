-- Load on the computer and how watching went, per version (sessions of at least a minute of
-- playback, last 30 days): median and 90th percentile of each measure (for the measures that
-- are themselves percentiles of a viewing, of the viewing's median or 90th percentile, as
-- named). Times in ms.
WITH s AS (
  SELECT * FROM sessions
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
