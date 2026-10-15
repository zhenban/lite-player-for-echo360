-- Most frequent errors of the last 30 days: occurrences, users, versions.
SELECT feature, type, msg, SUM(IFNULL(n, 1)) AS times, COUNT(DISTINCT uid) AS users,
       GROUP_CONCAT(DISTINCT version) AS versions
FROM errors
WHERE at > (strftime('%s', 'now') - 30 * 86400) * 1000
GROUP BY feature, type, msg
ORDER BY users DESC, times DESC
LIMIT 50;
