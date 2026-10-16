-- How the player runs on slow and fast devices. A device is a user id (one browser on one
-- computer or tablet). Its speed is the median, over its viewings of the last 30 days, of
-- the 10th percentile of the fixed steps "luma" and "loud" (newest version of each only:
-- versions are never mixed). The steps are timed only in viewings with fresh analyses, so
-- a device is judged on all of those together, not one viewing at a time. Devices are
-- split into four equal groups by luma (tier 1: fastest). Per tier: devices, their luma
-- range and median loud, viewings, and the median over all their viewings of dropped
-- frames, the 90th percentile of interaction delay, slow interactions per viewing, long
-- tasks per minute, and the share of time played under serious or critical CPU pressure,
-- with and without background analyses running.
WITH recent AS (
  SELECT * FROM sessions WHERE at > (strftime('%s', 'now') - 30 * 86400) * 1000
),
lv AS (SELECT MAX(luma_v) AS v FROM recent WHERE luma_p10 IS NOT NULL),
ov AS (SELECT MAX(loud_v) AS v FROM recent WHERE loud_p10 IS NOT NULL),
lr AS (
  SELECT uid, luma_p10 AS x, ROW_NUMBER() OVER (PARTITION BY uid ORDER BY luma_p10) AS r, COUNT(*) OVER (PARTITION BY uid) AS n
  FROM recent, lv WHERE recent.luma_v = lv.v AND luma_p10 IS NOT NULL
),
orr AS (
  SELECT uid, loud_p10 AS x, ROW_NUMBER() OVER (PARTITION BY uid ORDER BY loud_p10) AS r, COUNT(*) OVER (PARTITION BY uid) AS n
  FROM recent, ov WHERE recent.loud_v = ov.v AND loud_p10 IS NOT NULL
),
lm AS (SELECT uid, AVG(x) AS luma FROM lr WHERE r IN ((n + 1) / 2, (n + 2) / 2) GROUP BY uid),
om AS (SELECT uid, AVG(x) AS loud FROM orr WHERE r IN ((n + 1) / 2, (n + 2) / 2) GROUP BY uid),
dev AS (
  SELECT lm.uid, lm.luma, om.loud, NTILE(4) OVER (ORDER BY lm.luma) AS tier
  FROM lm LEFT JOIN om ON om.uid = lm.uid
),
s AS (SELECT recent.*, dev.tier FROM recent JOIN dev ON dev.uid = recent.uid),
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
             WHEN 'cpu_serious_pct_bg' THEN CASE WHEN pressure_bg IS NOT NULL THEN COALESCE(json_extract(pressure_bg, '$.serious'), 0) + COALESCE(json_extract(pressure_bg, '$.critical'), 0) END
             WHEN 'cpu_serious_pct_idle' THEN CASE WHEN pressure_idle IS NOT NULL THEN COALESCE(json_extract(pressure_idle, '$.serious'), 0) + COALESCE(json_extract(pressure_idle, '$.critical'), 0) END
           END AS value
    FROM s, json_each('["dropped_pct","input_ms_p90","slow_inputs","long_tasks_per_min","cpu_serious_pct_bg","cpu_serious_pct_idle"]') m
    UNION ALL
    SELECT tier, 'device_loud_p10', loud FROM dev
  )
  WHERE value IS NOT NULL
)
SELECT t.tier, t.devices, t.luma_p10_from, t.luma_p10_to,
       (SELECT COUNT(*) FROM s WHERE s.tier = t.tier) AS sessions,
       r.metric, MAX(r.n) AS n,
       MAX(CASE WHEN r.r = (r.n + 1) / 2 THEN r.value END) AS median
FROM (SELECT tier, COUNT(*) AS devices, MIN(luma) AS luma_p10_from, MAX(luma) AS luma_p10_to FROM dev GROUP BY tier) t
JOIN ranked r ON r.tier = t.tier
GROUP BY t.tier, r.metric
ORDER BY t.tier, r.metric;
