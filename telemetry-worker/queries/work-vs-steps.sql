-- Whether the fixed steps say how fast the real work goes: Spearman's rank correlation
-- (1: same order, 0: none) between a fixed step's 10th percentile and the median of a
-- measure of the real work, over viewings of the last 90 days that have both (newest
-- version of each step only). Ranks, not values: the relation need not be a straight line.
WITH v AS (
  SELECT (SELECT MAX(luma_v) FROM sessions WHERE luma_p10 IS NOT NULL) AS luma_v,
         (SELECT MAX(loud_v) FROM sessions WHERE loud_p10 IS NOT NULL) AS loud_v
),
pairs AS (
  SELECT p.value AS pair,
         CASE WHEN p.value LIKE 'luma%' THEN luma_p10 ELSE loud_p10 END AS x,
         CASE p.value
           WHEN 'luma~scan_frame' THEN scan_frame_ms50
           WHEN 'luma~ocr_mpx' THEN ocr_mpx_ms50
           WHEN 'luma~pdf_mpx' THEN pdf_mpx_ms50
           WHEN 'loud~silence_min' THEN silence_min_ms50
           WHEN 'loud~luma' THEN luma_p10
         END AS y
  FROM sessions s, v, json_each('["luma~scan_frame","luma~ocr_mpx","luma~pdf_mpx","loud~silence_min","loud~luma"]') p
  WHERE s.at > (strftime('%s', 'now') - 90 * 86400) * 1000
    AND (p.value NOT LIKE 'luma%' OR s.luma_v = v.luma_v)
    AND (p.value NOT LIKE 'loud%' OR s.loud_v = v.loud_v)
    AND (p.value <> 'loud~luma' OR s.luma_v = v.luma_v)
),
ranked AS (
  SELECT pair,
         RANK() OVER (PARTITION BY pair ORDER BY x) AS rx,
         RANK() OVER (PARTITION BY pair ORDER BY y) AS ry,
         COUNT(*) OVER (PARTITION BY pair) AS n
  FROM pairs
  WHERE x IS NOT NULL AND y IS NOT NULL
)
SELECT pair, MAX(n) AS sessions,
       CASE WHEN MAX(n) > 2 THEN ROUND(1 - 6.0 * SUM((rx - ry) * (rx - ry)) / (MAX(n) * (MAX(n) * MAX(n) - 1.0)), 2) END AS spearman
FROM ranked
GROUP BY pair
ORDER BY pair;
