-- How the analyses do (sessions of the last 30 days): how the screen view was found, chapters
-- per hour, share of the time the PDF follower recognised no page, corrections by hand, and
-- automatic layout changes undone.
SELECT version, screen, COUNT(*) AS sessions,
       ROUND(AVG(chapters_ph), 1) AS chapters_per_hour,
       ROUND(AVG(pdf_unrec_pct), 1) AS pdf_unrecognised_pct,
       SUM(page_fixes) AS page_fixes, SUM(layout_undos) AS layout_undos,
       SUM(renew_ok) AS renewals, SUM(renew_fail) AS renewals_failed
FROM sessions
WHERE at > (strftime('%s', 'now') - 30 * 86400) * 1000
GROUP BY version, screen
ORDER BY version DESC, sessions DESC;
