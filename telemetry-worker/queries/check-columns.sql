-- The columns of every table (to check that only the listed fields are stored).
SELECT m.name AS tbl, p.name AS col, p.type
FROM sqlite_master m, pragma_table_info(m.name) p
WHERE m.type = 'table' AND m.name IN ('env', 'sessions', 'errors', 'fallbacks')
ORDER BY m.name, p.cid;
