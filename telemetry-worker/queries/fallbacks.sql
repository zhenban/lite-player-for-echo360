-- Why pages went to the original player (last 30 days), and Echo360 front-end versions seen
-- with each reason.
SELECT reason, COUNT(*) AS times, COUNT(DISTINCT uid) AS users, GROUP_CONCAT(DISTINCT frontend) AS frontends
FROM fallbacks
WHERE at > (strftime('%s', 'now') - 30 * 86400) * 1000
GROUP BY reason
ORDER BY times DESC;
