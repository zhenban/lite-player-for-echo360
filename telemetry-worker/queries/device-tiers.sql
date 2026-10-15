-- How the player runs on slow and fast computers: viewings of the last 30 days with a time
-- for the fixed step "luma" (its newest version only: versions are never mixed), split into
-- four equal groups by that time's 10th percentile (tier 1: fastest). Per tier: the range of
-- luma_p10 (ms per million pixels), viewings, and the median over viewings of dropped
-- frames, the 90th percentile of interaction delay, slow interactions per viewing, long
-- tasks per minute, and the share of time under serious or critical CPU pressure.
WITH v AS (
  SELECT MAX(luma_v) AS luma_v FROM sessions WHERE luma_p10 IS NOT NULL
),
s AS (
  SELECT s.*, NTILE(4) OVER (ORDER BY luma_p10) AS tier
  FROM sessions s, v
  WHERE s.luma_v = v.luma_v AND s.luma_p10 IS NOT NULL
    AND s.at > (strftime('%s', 'now') - 30 * 86400) * 1000
),
ranked AS (
  SELECT tier, metric, value,
         ROW_NUMBER() OVER (PARTITION BY tier, metric ORDER BY value) AS r,
         COUNT(*) OVER (PARTITION BY tier, metric) AS n
  FROM (
    SELECT tier, m.value AS metric,
           CASE m.value
             WHEN 'dropped_pct' THEN dropped_pct
             WHEN 'input_ms_p90' THEN input_ms90
             WHEN 'slow_inputs' THEN input_slow
             WHEN 'long_tasks_per_min' THEN long_tasks_pm
             WHEN 'cpu_serious_pct' THEN COALESCE(json_extract(pressure, '$.serious'), 0) + COALESCE(json_extract(pressure, '$.critical'), 0)
           END AS value
    FROM s, json_each('["dropped_pct","input_ms_p90","slow_inputs","long_tasks_per_min","cpu_serious_pct"]') m
    WHERE m.value <> 'cpu_serious_pct' OR s.pressure IS NOT NULL
  )
  WHERE value IS NOT NULL
)
SELECT t.tier, t.sessions, t.luma_p10_from, t.luma_p10_to, r.metric,
       MAX(r.n) AS n,
       MAX(CASE WHEN r.r = (r.n + 1) / 2 THEN r.value END) AS median
FROM (SELECT tier, COUNT(*) AS sessions, MIN(luma_p10) AS luma_p10_from, MAX(luma_p10) AS luma_p10_to FROM s GROUP BY tier) t
JOIN ranked r ON r.tier = t.tier
GROUP BY t.tier, r.metric
ORDER BY t.tier, r.metric;
