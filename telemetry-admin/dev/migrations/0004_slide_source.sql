-- What the slide chapters came from (slide_src: frames, the video's keyframes; thumbs,
-- Echo360's per-minute preview pictures only; none) and why the keyframe scan stopped early,
-- if it did (slide_stop: noWebCodecs, the browser cannot decode video frames; noFrame, the
-- decoder gave no picture; decoder; playlist; network; other).

ALTER TABLE sessions ADD COLUMN slide_src TEXT;
ALTER TABLE sessions ADD COLUMN slide_stop TEXT;
