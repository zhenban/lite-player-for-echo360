-- Active users per day and per week (a user: one uid with any session or environment row).
SELECT 'day' AS span, date(at / 1000, 'unixepoch') AS period, COUNT(DISTINCT uid) AS users
FROM (SELECT uid, at FROM sessions UNION ALL SELECT uid, at FROM env)
GROUP BY period
UNION ALL
SELECT 'week', strftime('%Y-W%W', at / 1000, 'unixepoch'), COUNT(DISTINCT uid)
FROM (SELECT uid, at FROM sessions UNION ALL SELECT uid, at FROM env)
GROUP BY 2
ORDER BY span, period DESC
LIMIT 120;
