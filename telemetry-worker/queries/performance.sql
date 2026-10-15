-- Load on the computer per version (sessions of at least a minute of playback, last 30 days):
-- median and 90th percentile of long tasks per minute, dropped frames, JS heap, time to the
-- first picture, and rebuffering per hour played.
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
           END AS value
    FROM s, json_each('["long_tasks_per_min","dropped_pct","heap_mb","first_frame_ms","rebuffer_per_hour","scan_ms","ocr_frame_ms","silence_ms"]') m
  )
  WHERE value IS NOT NULL
)
SELECT version, metric, MAX(n) AS sessions,
       MAX(CASE WHEN r = (n + 1) / 2 THEN value END) AS median,
       MAX(CASE WHEN r = MAX(1, (n * 9 + 9) / 10) THEN value END) AS p90
FROM ranked
GROUP BY version, metric
ORDER BY version DESC, metric;
