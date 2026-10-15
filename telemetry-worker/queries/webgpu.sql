-- WebGPU, WebCodecs, the browser's built-in AI, CPU pressure readings and video decoding
-- in hardware (H.264 720p and 1080p): share of users where available (each user's latest
-- environment row of the last 30 days), by browser.
WITH latest AS (
  SELECT * FROM env e
  WHERE at > (strftime('%s', 'now') - 30 * 86400) * 1000
    AND at = (SELECT MAX(at) FROM env WHERE uid = e.uid)
)
SELECT browser, COUNT(*) AS users,
       ROUND(100.0 * SUM(webgpu) / COUNT(webgpu), 1) AS pct_webgpu,
       ROUND(100.0 * SUM(webcodecs) / COUNT(webcodecs), 1) AS pct_webcodecs,
       ROUND(100.0 * SUM(builtin_ai) / COUNT(builtin_ai), 1) AS pct_builtin_ai,
       ROUND(100.0 * SUM(pressure_api) / COUNT(pressure_api), 1) AS pct_pressure_api,
       ROUND(100.0 * SUM(hw720) / COUNT(hw720), 1) AS pct_hw720,
       ROUND(100.0 * SUM(hw1080) / COUNT(hw1080), 1) AS pct_hw1080
FROM latest
GROUP BY browser
ORDER BY users DESC;
