-- CPU pressure split by whether background analyses were running (pressure_bg,
-- pressure_idle: percent shares of the time played in a visible tab), the power source over
-- the whole time played (power: ac, battery or mixed) instead of a share of the time open,
-- the device model (Android only), and how the script started: the way in (boot_path:
-- intercept, takeover, fallback), the page's state when it ran (inject_state), the time
-- from then until the player was shown (boot_ms) and the original player's watch reports
-- stopped after a takeover (blocked_reports). The two replaced columns were never filled by
-- a released version.

ALTER TABLE sessions DROP COLUMN pressure;
ALTER TABLE sessions DROP COLUMN battery_pct;
ALTER TABLE sessions ADD COLUMN pressure_bg TEXT;
ALTER TABLE sessions ADD COLUMN pressure_idle TEXT;
ALTER TABLE sessions ADD COLUMN power TEXT;
ALTER TABLE sessions ADD COLUMN boot_path TEXT;
ALTER TABLE sessions ADD COLUMN inject_state TEXT;
ALTER TABLE sessions ADD COLUMN boot_ms INTEGER;
ALTER TABLE sessions ADD COLUMN blocked_reports INTEGER;
ALTER TABLE env ADD COLUMN model TEXT;
ALTER TABLE fallbacks ADD COLUMN inject_state TEXT;
