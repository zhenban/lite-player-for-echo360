-- Share of users (last 30 days) who used each feature at least once, and how often in all.
WITH s AS (SELECT * FROM sessions WHERE at > (strftime('%s', 'now') - 30 * 86400) * 1000),
total AS (SELECT COUNT(DISTINCT uid) AS n FROM s)
SELECT j.key AS feature, COUNT(DISTINCT s.uid) AS users,
       ROUND(100.0 * COUNT(DISTINCT s.uid) / (SELECT n FROM total), 1) AS pct_users,
       SUM(j.value) AS uses
FROM s, json_each(s.features) AS j
GROUP BY j.key
ORDER BY users DESC;
-- Keyboard or mouse/touch: share of commands given by key.
-- SELECT ROUND(100.0 * SUM(keys) / NULLIF(SUM(keys) + SUM(clicks), 0), 1) AS pct_keys FROM sessions;
