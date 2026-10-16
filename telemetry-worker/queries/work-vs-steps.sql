-- Whether the fixed steps say how fast the real work goes: Spearman's rank correlation
-- (1: same order, 0: none), over devices (user ids), between a device's fixed-step time
-- and its time for a measure of the real work. Both are the device's median over its
-- viewings of the last 90 days (of a step's 10th percentile, of a measure's median; newest
-- version of each step only): the steps are timed only in some viewings, so devices are
-- compared, not single viewings. Ranks, not values: the relation need not be a straight
-- line.
WITH v AS (
  SELECT (SELECT MAX(luma_v) FROM sessions WHERE luma_p10 IS NOT NULL) AS luma_v,
         (SELECT MAX(loud_v) FROM sessions WHERE loud_p10 IS NOT NULL) AS loud_v
),
vals AS (
  SELECT s.uid, m.value AS what,
         CASE m.value
           WHEN 'luma' THEN CASE WHEN s.luma_v = v.luma_v THEN luma_p10 END
           WHEN 'loud' THEN CASE WHEN s.loud_v = v.loud_v THEN loud_p10 END
           WHEN 'scan_frame' THEN scan_frame_ms50
           WHEN 'ocr_mpx' THEN ocr_mpx_ms50
           WHEN 'pdf_mpx' THEN pdf_mpx_ms50
           WHEN 'silence_min' THEN silence_min_ms50
         END AS x
  FROM sessions s, v, json_each('["luma","loud","scan_frame","ocr_mpx","pdf_mpx","silence_min"]') m
  WHERE s.at > (strftime('%s', 'now') - 90 * 86400) * 1000
),
ordered AS (
  SELECT uid, what, x, ROW_NUMBER() OVER (PARTITION BY uid, what ORDER BY x) AS r, COUNT(*) OVER (PARTITION BY uid, what) AS n
  FROM vals WHERE x IS NOT NULL
),
dev AS (
  SELECT uid, what, AVG(x) AS x FROM ordered WHERE r IN ((n + 1) / 2, (n + 2) / 2) GROUP BY uid, what
),
pairs AS (
  SELECT p.value AS pair, a.x AS x, b.x AS y
  FROM json_each('["luma~scan_frame","luma~ocr_mpx","luma~pdf_mpx","loud~silence_min","loud~luma"]') p
  JOIN dev a ON a.what = substr(p.value, 1, instr(p.value, '~') - 1)
  JOIN dev b ON b.uid = a.uid AND b.what = substr(p.value, instr(p.value, '~') + 1)
),
ranked AS (
  SELECT pair,
         RANK() OVER (PARTITION BY pair ORDER BY x) AS rx,
         RANK() OVER (PARTITION BY pair ORDER BY y) AS ry,
         COUNT(*) OVER (PARTITION BY pair) AS n
  FROM pairs
)
SELECT pair, MAX(n) AS devices,
       CASE WHEN MAX(n) > 2 THEN ROUND(1 - 6.0 * SUM((rx - ry) * (rx - ry)) / (MAX(n) * (MAX(n) * MAX(n) - 1.0)), 2) END AS spearman
FROM ranked
GROUP BY pair
ORDER BY pair;
