// ===================================================================================
// Site adapters. Everything that knows about a particular Echo360 deployment lives here;
// the player only sees the normalised "lesson" object returned by parse().
//
// Adapter interface:
//   id                       string
//   matches()                -> boolean, is this page handled by the adapter
//   intercept(onBoot)        call onBoot(arg, callOriginal) when the page would start its
//                            own player (the trap itself is set first, by 00-boot.js)
//   bootArg()                -> the bootstrap argument of a page that already started its
//                            player (taken over), or null
//   original()               -> a function starting the page's own player, or null
//   stopOriginal(arg)        stop the page's own player: -> { at, playing, unmounted, restore() }
//   isWatchReport(method, url)  a watch report of the original player (stopped while taken over)
//   parse(arg)               -> lesson (throws if the page is not understood)
//   withStartTime(arg, sec)  -> arg with the resume point moved (for handing over)
// ===================================================================================

const echo360ClassroomAdapter = {
  id: 'echo360-classroom',

  matches() {
    return isEcho360Host() && /^\/lesson\//.test(location.pathname);
  },

  // The page's bootstrap call is trapped by 00-boot.js, set before anything else; onBoot
  // receives it from there.
  intercept(onBoot) {
    boot.handler = onBoot;
  },

  // The bootstrap argument of a page that started its player before this script ran: the
  // same text the page passed, read from its inline script. null if it is not there.
  bootArg() {
    const call = /Echo\s*(?:\[\s*(["'])echoPlayerV2FullApp\1\s*\]|\.echoPlayerV2FullApp)\s*\(\s*(?=["'])/g;
    for (const s of document.scripts) {
      if (s.src) continue;
      const text = s.textContent || '';
      call.lastIndex = 0;
      const m = call.exec(text);
      if (!m) continue;
      const arg = readJsString(text, m.index + m[0].length);
      if (arg != null) return arg;
    }
    return null;
  },

  // A call to the page's own bootstrap function (for a page taken over: the trap was set
  // after the page had started, and found it on window.Echo).
  original() {
    const fn = boot.original();
    if (typeof fn !== 'function') return null;
    return (a) => fn.call(platform.page.Echo, a);
  },

  // Stops the original player of a page taken over: where it was and whether it was
  // playing, then its videos are paused and muted at once, its React tree is unmounted (as
  // its own bootstrap does before it renders again), and any video left is emptied, so
  // nothing plays, downloads or sends timeupdates. Where React cannot be reached, its
  // container is taken out of the page instead (put back by restore()).
  // -> { at (seconds, or null), playing, unmounted, container, restore() }
  stopOriginal(arg) {
    let id = null;
    try { id = (typeof arg === 'string' ? JSON.parse(arg) : arg).id; } catch (e) { id = null; }
    const container = typeof id === 'string' && id ? document.getElementById(id) : null;
    /** @type {HTMLMediaElement[]} */
    const media = [...document.querySelectorAll('video, audio')].map((m) => /** @type {HTMLMediaElement} */ (m));
    let at = null;
    let playing = false;
    for (const v of media) {
      if (at == null && v.readyState > 0 && v.currentTime > 0) at = v.currentTime;
      if (!v.paused && !v.ended) playing = true;
    }
    for (const v of media) { try { v.muted = true; v.pause(); } catch (e) { /* gone */ } }
    let unmounted = false;
    const root = container && /** @type {any} */ (container)._reactRootContainer;
    if (root && typeof root.unmount === 'function') {
      try {
        root.unmount();
        /** @type {any} */ (container)._reactRootContainer = null;
        unmounted = !container.querySelector('video, audio');
      } catch (e) { log.warn('the original player could not be unmounted:', e); }
    }
    for (const v of media) {
      try { v.removeAttribute('src'); v.load(); } catch (e) { /* gone */ }
    }
    let removed = null;
    if (!unmounted && container && container.parentNode) {
      removed = { parent: container.parentNode, next: container.nextSibling };
      container.remove();
    }
    return {
      at, playing, unmounted, container,
      restore() {
        if (!removed || container.isConnected) return;
        removed.parent.insertBefore(container, removed.next && removed.next.parentNode === removed.parent ? removed.next : null);
      },
    };
  },

  // The original player's watch reports (what 20-reporter.js sends for ours).
  isWatchReport(method, url) {
    return method === 'POST' && /^https:\/\/api\.[^/]+\/a\/player\/(session|beacon)(\?|$)/.test(url);
  },

  withStartTime(arg, sec) {
    const cfg = typeof arg === 'string' ? JSON.parse(arg) : Object.assign({}, arg);
    cfg.startTimeMillis = Math.max(0, Math.round(sec * 1000));
    return typeof arg === 'string' ? JSON.stringify(cfg) : cfg;
  },

  /** @returns {Lesson} */
  parse(arg) {
    const cfg = typeof arg === 'string' ? JSON.parse(arg) : arg;
    const video = cfg && cfg.video;
    if (!video || !Array.isArray(video.playableMedias)) throw new Error('video.playableMedias missing');
    if (video.playableMedias.some((m) => m && m.isLive)) throw new Error('live lessons are not supported');
    const cr = cfg.copyrightData;
    if (cr && cr.enforceCopyrightAcknowledgement && !cr.copyrightAcknowledged) {
      throw new Error('copyright acknowledgement required (handled by the original player)');
    }

    const bySource = new Map();
    for (const m of video.playableMedias) {
      if (!m || !m.isHls || typeof m.uri !== 'string') continue;
      const kind = (m.trackType || []).join('+');
      const s = bySource.get(m.sourceIndex) || {};
      if (kind === 'Audio+Video') s.av = m.uri;
      else if (kind === 'Video') s.v = m.uri;
      bySource.set(m.sourceIndex, s);
    }
    const posters = new Map((video.posterMedia || []).map((p) => [p.sourceIndex, p.uri]));
    const sources = [...bySource.entries()]
      .filter(([, s]) => s.av || s.v)
      .sort((a, b) => a[0] - b[0])
      .map(([index, s], i) => ({ index, n: i + 1, av: s.av || null, v: s.v || null, poster: posters.get(index) || null }));
    if (!sources.some((s) => s.av)) throw new Error('no audio+video HLS stream');

    const duration = parseIsoDuration(video.duration);
    const sectionId = cfg.sectionInfo && cfg.sectionInfo.section && cfg.sectionInfo.section.id;
    const ctx = cfg.context || {};
    const hostMatch = location.hostname.match(/echo360.+/);

    let analytics = null;
    if (cfg.sessionId && video.mediaId && hostMatch) {
      analytics = {
        gatewayUrl: location.protocol + '//api.' + hostMatch[0],
        appUrl: location.origin,
        sessionId: cfg.sessionId,
        mediaId: video.mediaId,
        context: {
          course_id: ctx.courseId, department_id: ctx.departmentId, group_id: ctx.groupId,
          lesson_id: ctx.lessonId, lti_id: ctx.ltiId, organization_id: ctx.organizationId,
          section_id: ctx.sectionId, term_id: ctx.termId,
        },
        link: { lti: ctx.ltiId, public: ctx.publicLinkId, secure: ctx.secureLinkId, secure_data: ctx.secureLinkAccessDataId },
        user: cfg.user ? { id: cfg.user.id, role: cfg.user.currentRole } : undefined,
      };
    }

    const lessonId = cfg.lesson && cfg.lesson.id;
    return {
      id: video.mediaId || lessonId || location.pathname,
      lessonId,
      sectionId: ctx.sectionId || sectionId || null,
      userId: cfg.user ? cfg.user.id : null,
      isAnonymousUser: !cfg.user || cfg.user.currentRole === 'Anonymous',
      mediaId: video.mediaId,
      transcriptUrl: lessonId && video.mediaId
        ? '/api/ui/echoplayer/lessons/' + encodeURIComponent(lessonId) + '/medias/' + encodeURIComponent(video.mediaId) + '/transcript'
        : null,
      title: cfg.title || (cfg.lesson && cfg.lesson.name) || document.title,
      courseName: (cfg.sectionInfo && cfg.sectionInfo.course && (cfg.sectionInfo.course.courseName || cfg.sectionInfo.course.courseIdentifier)) || '',
      // How often the page renews the video access cookies (see 36-session.js).
      sessionRenewMs: typeof cfg.cookieRenewalIntervalMillis === 'number' ? cfg.cookieRenewalIntervalMillis : null,
      backUrl: sectionId ? '/section/' + encodeURIComponent(sectionId) + '/home' : null,
      duration: isFinite(duration) ? duration : NaN,
      resumeAt: typeof cfg.startTimeMillis === 'number' ? cfg.startTimeMillis / 1000 : null,
      sources,
      captionsUrl: typeof cfg.captions === 'string' && cfg.captions ? cfg.captions : null,
      thumbnails: Array.isArray(video.thumbnailMedia) ? video.thumbnailMedia : [],
      // Content only the original player can show; we point users there instead.
      extras: {
        polls: Array.isArray(cfg.polls) && cfg.polls.length > 0,
        slides: !!(cfg.slides && cfg.slides.slideDeck),
        audioDescription: Array.isArray(video.audioDescriptions) && video.audioDescriptions.length > 0,
      },
      analytics,
    };
  },
};

// Transcript cues as [{ start, end, text, speaker }] (seconds), sorted by start. Uses the
// transcript API (same cues as the captions, with speaker labels) and falls back to the
// WebVTT captions file. Resolves to [] when the recording has neither; rejects when the
// transcript failed for now (isTransient: no connection, server error) and there is no
// captions file to fall back on, so the player can offer to try again.
echo360ClassroomAdapter.fetchCues = function (lesson) {
  const fromTranscript = () => {
    if (!lesson.transcriptUrl) return Promise.reject(new Error('no transcript url'));
    // As Echo360Api.request: a redirect only goes to the login page (sign-in expired).
    return fetch(lesson.transcriptUrl, { credentials: 'include', redirect: 'manual', headers: { Accept: 'application/json' } })
      .then((r) => {
        if (r.type === 'opaqueredirect') throw Object.assign(new Error('HTTP 401'), { status: 401, login: true });
        return r.ok ? r.json() : Promise.reject(Object.assign(new Error('HTTP ' + r.status), { status: r.status }));
      })
      .then((j) => {
        const raw = j && j.data && j.data.contentJSON && j.data.contentJSON.cues;
        if (!Array.isArray(raw) || !raw.length) throw new Error('empty transcript');
        return raw
          .filter((c) => typeof c.startMs === 'number' && typeof c.content === 'string' && c.content.trim())
          .map((c) => ({ start: c.startMs / 1000, end: (typeof c.endMs === 'number' ? c.endMs : c.startMs + CUE_DEFAULT_MS) / 1000, text: c.content.trim(), speaker: c.speaker || '' }));
      });
  };
  const fromVtt = () => {
    if (!lesson.captionsUrl) return [];
    return fetch(lesson.captionsUrl)
      .then((r) => (r.ok ? r.text() : ''))
      .then(parseVtt);
  };
  let failed = null;
  return fromTranscript()
    .catch((e) => { failed = e; return fromVtt(); })
    .catch(() => [])
    .then((cues) => {
      if (!cues.length && failed && (isTransient(failed) || failed.login)) throw failed;
      return cues.sort((a, b) => a.start - b.start);
    });
};

function parseVttTime(s) {
  const m = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/.exec(s);
  if (!m) return NaN;
  return (+m[1] || 0) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4].padEnd(3, '0')) / 1000;
}

// Minimal WebVTT parser: cue timing lines plus text, NOTE blocks and tags removed.
/** @returns {Cue[]} */
function parseVtt(text) {
  const cues = [];
  const blocks = String(text || '').replace(/\r/g, '').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const [a, b] = lines[ti].split('-->');
    const start = parseVttTime(a);
    const end = parseVttTime(b);
    if (!isFinite(start) || !isFinite(end)) continue;
    let speaker = '';
    const body = lines.slice(ti + 1).join(' ').replace(/<v\s+([^>]*)>/g, (m, who) => { speaker = who.trim(); return ''; })
      .replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (body) cues.push({ start, end, text: decodeEntities(body), speaker });
  }
  return cues;
}

function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, '\'').replace(/&nbsp;/g, ' ');
}

// One implementation today; the list is where support for other sites would be added.
const ADAPTERS = [echo360ClassroomAdapter];
