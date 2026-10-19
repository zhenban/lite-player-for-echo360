-- Which of Echo360's sites a user, viewing or fallback was on (site: au, us, uk, ca; the
-- player runs on all four from 1.0.0, tested only on au), and whether the page was in
-- another page's frame (framed: a learning system embedding Echo360). Never the address.
-- NULL: sent by a version before 1.0.0.

ALTER TABLE env ADD COLUMN site TEXT;
ALTER TABLE sessions ADD COLUMN site TEXT;
ALTER TABLE sessions ADD COLUMN framed INTEGER;
ALTER TABLE fallbacks ADD COLUMN site TEXT;
ALTER TABLE fallbacks ADD COLUMN framed INTEGER;
