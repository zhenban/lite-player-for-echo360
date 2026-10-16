-- How the script started (last 30 days), per browser and script manager: the way in
-- (intercept: the page's player was caught before it started; takeover: the script ran
-- after the page had started its player; fallback: the original player kept the page),
-- the page's state when the script ran, viewings, the median time from the script running
-- until the player was shown, and the original player's watch reports stopped after a
-- takeover. Pages that went to the original player are in the fallbacks table (by reason
-- and the page's state then).
WITH s AS (
  SELECT s.*, (SELECT e.browser || ' / ' || COALESCE(e.manager, '-') FROM env e WHERE e.uid = s.uid ORDER BY e.at DESC LIMIT 1) AS who
  FROM sessions s
  WHERE s.at > (strftime('%s', 'now') - 30 * 86400) * 1000 AND s.boot_path IS NOT NULL
),
ranked AS (
  SELECT who, boot_path, inject_state, boot_ms, blocked_reports,
         ROW_NUMBER() OVER (PARTITION BY who, boot_path, inject_state ORDER BY boot_ms) AS r,
         COUNT(boot_ms) OVER (PARTITION BY who, boot_path, inject_state) AS n
  FROM s
)
SELECT COALESCE(who, '-') AS browser_manager, boot_path, inject_state, COUNT(*) AS sessions,
       MAX(CASE WHEN boot_ms IS NOT NULL AND r = (n + 1) / 2 THEN boot_ms END) AS boot_ms_median,
       SUM(blocked_reports) AS blocked_reports
FROM ranked
GROUP BY who, boot_path, inject_state
UNION ALL
SELECT 'fallback: ' || reason, 'fallback', inject_state, COUNT(*), NULL, NULL
FROM fallbacks
WHERE at > (strftime('%s', 'now') - 30 * 86400) * 1000
GROUP BY reason, inject_state
ORDER BY 1, 2, 3;
