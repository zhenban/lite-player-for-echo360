-- How people watch (viewings of the last 30 days with some playback): median length and
-- share of the recording watched, time at each speed and rendition, seconds of silence and
-- empty screen skipped, theme and language, and how long people watched before going to
-- the original player.
WITH s AS (
  SELECT * FROM sessions WHERE play_sec > 0 AND at > (strftime('%s', 'now') - 30 * 86400) * 1000
),
shares AS (
  SELECT 'speed ' || j.key AS what, SUM(j.value * s.play_sec) AS w FROM s, json_each(s.speeds) j GROUP BY j.key
  UNION ALL SELECT 'rendition ' || j.key || 'p', SUM(j.value * s.play_sec) FROM s, json_each(s.quality) j GROUP BY j.key
  UNION ALL SELECT 'theme ' || theme, SUM(100.0 * play_sec) FROM s WHERE theme IS NOT NULL GROUP BY theme
  UNION ALL SELECT 'language ' || lang, SUM(100.0 * play_sec) FROM s WHERE lang IS NOT NULL GROUP BY lang
)
SELECT what, ROUND(w / (SELECT SUM(play_sec) FROM s), 1) AS pct_of_playback, NULL AS value
FROM shares
UNION ALL
SELECT 'totals', NULL,
       json_object('viewings', COUNT(*), 'hours_played', ROUND(SUM(play_sec) / 3600.0, 1),
                   'avg_watched_pct', ROUND(AVG(watched_pct), 1),
                   'silence_skipped_min', ROUND(SUM(skip_silence_sec) / 60.0, 1),
                   'empty_skipped_min', ROUND(SUM(skip_blank_sec) / 60.0, 1),
                   'to_original', SUM(original_after_sec IS NOT NULL),
                   'avg_sec_before_original', ROUND(AVG(original_after_sec)))
FROM s
ORDER BY what;
