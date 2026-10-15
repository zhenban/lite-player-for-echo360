-- Where users are (country, region, network operator), last 30 days, by distinct users.
SELECT country, region, asorg, COUNT(DISTINCT uid) AS users
FROM env
WHERE at > (strftime('%s', 'now') - 30 * 86400) * 1000
GROUP BY country, region, asorg
ORDER BY users DESC
LIMIT 100;
