-- Share of users who changed each setting from its default (each user's latest session of
-- the last 30 days).
WITH latest AS (
  SELECT * FROM sessions s
  WHERE at > (strftime('%s', 'now') - 30 * 86400) * 1000
    AND at = (SELECT MAX(at) FROM sessions WHERE uid = s.uid)
),
total AS (SELECT COUNT(*) AS n FROM latest)
SELECT j.value AS setting, COUNT(*) AS users, ROUND(100.0 * COUNT(*) / (SELECT n FROM total), 1) AS pct_users
FROM latest, json_each(latest.changed) AS j
GROUP BY j.value
ORDER BY users DESC;
