-- Script versions, browsers and script managers in use (each user's latest environment row
-- of the last 30 days).
WITH latest AS (
  SELECT * FROM env e
  WHERE at > (strftime('%s', 'now') - 30 * 86400) * 1000
    AND at = (SELECT MAX(at) FROM env WHERE uid = e.uid)
)
SELECT 'version' AS what, version AS value, COUNT(*) AS users FROM latest GROUP BY version
UNION ALL SELECT 'browser', browser || ' ' || browser_v, COUNT(*) FROM latest GROUP BY browser, browser_v
UNION ALL SELECT 'os', os, COUNT(*) FROM latest GROUP BY os
UNION ALL SELECT 'manager', manager || ' ' || IFNULL(manager_v, ''), COUNT(*) FROM latest GROUP BY manager, manager_v
UNION ALL SELECT 'touch', CASE touch WHEN 1 THEN 'touch' WHEN 0 THEN 'desktop' ELSE 'unknown' END, COUNT(*) FROM latest GROUP BY touch
ORDER BY what, users DESC;
