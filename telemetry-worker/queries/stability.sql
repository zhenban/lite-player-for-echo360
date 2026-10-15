-- What failed, per version (last 30 days): features turned off after an error, failed
-- requests by kind, video stream errors by hls.js name, and the usage data's own failures;
-- each as the number of viewings it happened in and the total count.
WITH s AS (
  SELECT * FROM sessions WHERE at > (strftime('%s', 'now') - 30 * 86400) * 1000
),
items AS (
  SELECT version, 'feature off: ' || j.key AS what, j.value AS n FROM s, json_each(s.guard_off) j
  UNION ALL SELECT version, 'request: ' || j.key, j.value FROM s, json_each(s.net_errors) j
  UNION ALL SELECT version, 'stream: ' || j.key, j.value FROM s, json_each(s.stream_errors) j
  UNION ALL SELECT version, 'usage data: ' || m.value, CASE m.value WHEN 'send_fail' THEN send_fail WHEN 'dropped' THEN dropped ELSE uncaught END
    FROM s, json_each('["send_fail","dropped","uncaught"]') m
)
SELECT version, what, COUNT(*) AS sessions, SUM(n) AS total
FROM items
WHERE n > 0
GROUP BY version, what
ORDER BY version DESC, total DESC;
