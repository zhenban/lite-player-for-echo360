-- Which form of the H.264 video gave pictures in the keyframe scan (slide_form): avcc, the
-- samples as they are in the MP4 with the avcC record as the decoder's description (every
-- browser but iPhone Safari); annexb, only after conversion to Annex B (start codes,
-- parameter sets in-line; iPhone Safari on iOS 17 decodes nothing from avcc); neither.
-- NULL: no scan in that viewing (chapters from the cache, or no WebCodecs).

ALTER TABLE sessions ADD COLUMN slide_form TEXT;
