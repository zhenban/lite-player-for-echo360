-- The fixed steps by browser, system and processor cores (last 90 days): viewings, and the
-- median over viewings of each step's 10th percentile (the computer at its best) and median
-- (what the analyses got), in ms per million units. One row per step version: versions
-- time different code and are never compared. The conditions the batches ran in are in
-- *_cond (JSON counts: playing/paused, rate, CPU pressure, power).
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
  SELECT st.value AS step,
         CASE st.value WHEN 'luma' THEN luma_v ELSE loud_v END AS v,
         CASE st.value WHEN 'luma' THEN luma_p10 ELSE loud_p10 END AS p10,
         CASE st.value WHEN 'luma' THEN luma_p50 ELSE loud_p50 END AS p50,
         e.browser, e.os, e.cores
  FROM t x
  JOIN json_each('["luma","loud"]') st
  LEFT JOIN env e ON e.uid = x.uid AND e.day = date(x.at / 1000, 'unixepoch')
  WHERE x.at > (strftime('%s', 'now') - 90 * 86400) * 1000
),
ranked AS (
  SELECT *,
         ROW_NUMBER() OVER (PARTITION BY step, v, browser, os, cores ORDER BY p10) AS r10,
         ROW_NUMBER() OVER (PARTITION BY step, v, browser, os, cores ORDER BY p50) AS r50,
         COUNT(*) OVER (PARTITION BY step, v, browser, os, cores) AS n
  FROM s
  WHERE p10 IS NOT NULL
)
SELECT step, v, browser, os, cores, MAX(n) AS sessions,
       MAX(CASE WHEN r10 = (n + 1) / 2 THEN p10 END) AS median_p10,
       MAX(CASE WHEN r50 = (n + 1) / 2 THEN p50 END) AS median_p50
FROM ranked
GROUP BY step, v, browser, os, cores
ORDER BY step, v DESC, median_p10;
