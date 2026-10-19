// ===================================================================================
// The player
//
// Streams: the "clock" <video> plays an audio+video rendition and drives everything
// (reporting, time display, seeking). In dual layouts a muted "follower" <video> plays the
// other view's video-only rendition and is kept in step by FollowerSync, so audio is never
// downloaded twice.
//
// Layout: which source is shown big ("primary") is independent of which one is the clock.
// Swapping views in the side-by-side and picture-in-picture layouts only moves the two
// elements (CSS); in the single layout the clock is reloaded with the shown source.
//
// The player assembles its parts and keeps what they share: the streams, the layout and
// the settings. Each part gets only the functions and elements it needs, and is owned
// through a child of the player's Disposer (released with it, or alone if it fails):
//   Popovers and Tooltips (32), SeekBar (41), KeyboardShortcuts (42), LayoutControls (43),
//   QualityController (44), MenuBar (45), PopoutController (46), SilenceUi (47),
//   SpeedControl (48), VolumeControl (49); and the features: captions and
//   transcript (53), side panel (54), notes (55), discussion (57), slides (64-68),
//   zoom (50), A-B loop (51), watched parts (52), audio tools (60).
// ===================================================================================

class LitePlayer {
  constructor(lesson, opts) {
    this.d = new Disposer();
    this.destroyed = false;
    // A failure half-way must not leave a half-built player (a black overlay over the
    // original player, timers, requests): release everything made so far, then let the
    // caller fall back.
    this.constructing = true;
    try {
      this.init(lesson, opts);
      this.constructing = false;
    } catch (e) {
      this.destroyed = true;
      try { this.d.dispose(); } catch (err) { /* keep the first error */ }
      throw e;
    }
  }

  init(lesson, opts) {
    this.startedAt = performance.now();   // usage data: times are measured from here
    this.lesson = lesson;
    this.opts = opts;
    // A feature that fails is announced once (playback goes on).
    featureErrors.notify = (name) => { if (!this.destroyed && this.root) this.toast(tr('featureFailed', { name: featureName(name) })); };
    this.d.add(() => { featureErrors.notify = null; });
    this.prefs = sanitizePrefs(store.get('prefs', null));
    this.played = new PlayedRanges();
    // Shared by the parts that drag (seek bar, divider, picture-in-picture window) and
    // those that must not interfere meanwhile (hiding the controls, skipping silences).
    this.ui = { dragging: false };
    this.sync = null;
    this.followerFailed = false;
    this.playbackFailed = false;    // the "playback failed" message is up
    this.partRetries = new Map();   // side-panel tab -> load again, for loads that failed for now
    this.frame = new FrameTask(() => this.render(), () => this.host);
    this.d.add(() => this.frame.cancel());

    this.sources = lesson.sources;
    this.dual = this.sources.length >= 2;
    const savedPrimary = this.sources.findIndex((s) => s.index === this.prefs.primary);
    this.primaryPos = savedPrimary >= 0 ? savedPrimary : 0;
    this.onlyFrom = null;     // the shown view before showOnly(), or null
    this.emptyScreen = null;
    this.toastNext = null;    // a message waiting for the shown one to close (toast)
    this.toastFrom = null;    // the source of the automatic message shown
    this.clockPos = this.sources[this.primaryPos].av ? this.primaryPos : this.sources.findIndex((s) => s.av);

    this.buildDom();
    this.session = new SessionKeeper({
      url: location.href, renewMs: lesson.sessionRenewMs, disposer: this.d.feature('session renewal'),
      onState: (st) => { if (!this.destroyed) this.$('.sessionhint').hidden = st !== 'renewing'; },
    });
    this.clock = new Stream(this.video, (f) => this.onClockFatal(f));
    this.follower = new Stream(this.fvideo, (f) => (f.auth ? this.recoverAccess(this.follower, () => this.onFollowerFatal()) : this.onFollowerFatal()));
    this.followerPos = -1;
    this.hold = null;          // Disposer of a held follower (holdFollower), or null
    for (const st of [this.clock, this.follower]) {
      st.onLevel = () => { if (!this.destroyed) this.quality.levelChanged(); };
      // Refused but still retrying: renew in the background (once at a time).
      st.onAuth = () => {
        if (this.destroyed) return;
        if (!this.session.failed) { this.session.renew(true).catch(() => {}); return; }
        // Renewal has already given up: say so now rather than after hls.js's retries.
        if (st === this.clock) this.showAuthError(); else this.onFollowerFatal();
      };
    }
    this.d.add(() => { this.dropFollower(); this.clock.destroy(); });
    this.setupParts();
    this.bindVideo();
    this.bindControls();
    this.watched = new WatchedStore(lesson, this.video, this.played);
    this.watched.load().then(() => { if (!this.destroyed) this.renderWatched(); }).catch(() => {});
    this.d.listen(window, 'pagehide', () => this.watched.save(this.duration()));
    this.reporter = lesson.analytics ? new Reporter(lesson.analytics, this.video, this.played, this.d.child()) : null;
    if (this.reporter) this.reporter.stateFn = () => ({ captions: this.cc.on, transcript: this.sidebar.visible('transcript') });
    // Optional features: one failing to start is turned off, the others and playback go on.
    featureGuard('silence detection', () => {
      this.silence = new SilenceUi({
        $: (sel) => this.$(sel), lesson, video: this.video, sources: this.sources, prefs: this.prefs, savePrefs: () => this.savePrefs(),
        seek: (t) => this.seek(t), duration: () => this.duration(), toast: (...a) => this.toast(...a), ui: this.ui,
        uniform: () => (this.slides ? this.slides.uniform : []),
        onChange: () => this.menus.refresh(),
        onSkips: (skips, end) => {
          this.seekBar.renderSkips(skips);
          if (this.watched) this.watched.contentEnd = end && end < this.duration() ? end : null;
        },
      }, this.d.feature('silence detection'));
      this.menuPages.silence = () => this.silence.items();
      this.menuValues.silence = () => this.silence.value();
    });
    featureGuard('slide chapters', () => this.setupSlides());
    featureGuard('camera for an empty screen', () => {
      this.emptyScreen = new EmptyScreenLayout({
        lesson, prefs: this.prefs, savePrefs: () => this.savePrefs(), duration: () => this.duration(), sources: this.sources,
        uniform: () => (this.slides ? this.slides.uniform : []),
        screenIndex: () => (this.slides ? this.slides.screenIndex : null),
        primaryPos: () => this.primaryPos, layout: () => this.prefs.layout,
        canSwitch: () => this.dual && !this.followerFailed && !this.pdfMode,
        showOnly: (pos) => this.showOnly(pos), toast: (msg, action, fn, valid) => this.toast(msg, action, fn, { later: true, from: 'emptyScreen', valid }),
      }, this.d.feature('camera for an empty screen'));
    });
    featureGuard('slide reader', () => this.setupDeck());
    featureGuard('captions', () => this.loadCues());
    featureGuard('notes and discussion', () => this.loadInteractions());
    featureGuard('audio tools', () => this.setupAudio());
    featureGuard('usage data', () => {
      this.usage = new UsageSession({
        root: this.root, video: this.video, videos: () => [this.video, this.fvideo], prefs: this.prefs,
        layout: () => (this.pdfMode ? 'pdf' : this.layout),
        slides: () => this.slides || null, deck: () => this.deck || null,
        silence: () => (this.silence && this.silence.analyzer) || null, emptyScreen: () => this.emptyScreen,
        session: () => this.session, duration: () => this.duration(), startedAt: this.startedAt,
        height: () => this.clock.height, bandwidth: () => (this.clock.hls ? this.clock.hls.bandwidthEstimate : NaN),
        played: () => this.played.merged(this.video.played),
      }, this.d.child());
      telemetry.envDaily();
    });

    const start = this.pickStart();
    this.startAt = start;
    // A page taken over goes on as the original player was: there, playing or not.
    this.loadClock(this.clockPos, start, !!(opts.takeover && opts.takeover.playing));
    this.applyLayout();
    if (start > 1) this.toast(tr('resumedAt', { time: fmtTime(start) }), tr('startOver'), () => this.seek(0));
    // Development's dry run is a switch in the page's storage: never on without saying so,
    // or writes would look saved while nothing is sent.
    if (this.writesHeld) this.toast(tr(this.writesHeld === 'all' ? 'dryRunAll' : 'dryRunPublic'), null, null, { later: true, from: 'dryRun' });
  }

  // An element of the player's own markup. Each selector must name exactly one element:
  // two elements sharing a class once bound one button's action to another. Looked up
  // once and remembered (the markup is fixed; parts that are redrawn are not looked up
  // this way).
  $(sel) {
    let elem = this.refs.get(sel);
    if (!elem) {
      const all = this.root.querySelectorAll(sel);
      if (all.length !== 1) throw new Error('player markup: "' + sel + '" matches ' + all.length + ' elements');
      elem = all[0];
      this.refs.set(sel, elem);
    }
    return elem;
  }

  // All elements of the player's markup matching sel (for groups such as menu items).
  all(sel) {
    return /** @type {HTMLElement[]} */ ([...this.root.querySelectorAll(sel)]);
  }

  get secondaryPos() {
    return this.dual ? (this.primaryPos + 1) % this.sources.length : -1;
  }

  get layout() {
    if (this.pdfMode) return this.prefs.layout;
    if (this.onlyFrom !== null) return 'single';
    return this.dual && !this.followerFailed ? this.prefs.layout : 'single';
  }

  // Shows the view at `pos` alone for now (the other one is empty), without changing the
  // chosen layout; null goes back to it (EmptyScreenLayout).
  showOnly(pos) {
    if (pos === null) {
      if (this.onlyFrom === null) return;
      this.primaryPos = this.onlyFrom;
      this.onlyFrom = null;
    } else {
      if (this.onlyFrom === null) this.onlyFrom = this.primaryPos;
      this.primaryPos = pos;
    }
    this.applyLayout();
  }

  // The lecturer's PDF shown in the picture area, next to one video (see SlideReader).
  get pdfMode() {
    return !!(this.prefs.pdfMain && this.deck && this.deck.pages.length);
  }

  buildDom() {
    const host = document.createElement('div');
    host.id = 'lite-player-for-echo360';
    host.lang = uiLocale();
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<style>' + PLAYER_CSS + '</style>' + playerTemplate();
    this.host = host;
    this.root = root;
    this.refs = new Map();
    this.stage = this.$('.stage');
    this.video = this.$('video.clock');
    this.fvideo = this.$('video.follower');
    this.app = this.$('.app');
    this.$('.title').textContent = this.lesson.title;
    document.title = this.lesson.title;
    const back = this.$('.back');
    if (this.lesson.backUrl) back.href = this.lesson.backUrl; else back.style.display = 'none';
    this.app.dataset.theme = this.prefs.theme;
    this.stage.classList.toggle('hidecc-paused', !!this.prefs.capHidePaused);
    this.stage.style.setProperty('--ratio', String(clamp(this.prefs.ratio, 0.2, 0.8)));
    this.stage.style.setProperty('--pipw', String(clamp(this.prefs.pipw, 0.15, 0.6)));
    this.app.style.setProperty('--panelw', clamp(this.prefs.panelw, 260, 640) + 'px');
    this.cc = new CaptionsView(this.$('.captions'), this.video);
    this.d.add(() => this.cc.dispose());
    this.cc.setSize(this.prefs.capSize);
    this.sidebar = new Sidebar(this, this.$('.panel'), this.d.child());
    this.transcript = new TranscriptPanel(this, this.$('.pane[data-pane=transcript]'), this.$('.marks'), this.d.child());
    this.markers = new MarkersLayer(this.$('.imarks'));
    this.notes = null;
    this.discussion = null;
    this.renderExtras();
    (document.body || document.documentElement).appendChild(host);
    const prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    this.d.add(() => {
      if (fullscreenElement() === host) exitFullscreen();
      host.remove();
      document.documentElement.style.overflow = prevOverflow;
    });
  }

  // A link to a moment (#t=<seconds>, as in exported notes) wins over the resume position.
  linkTime() {
    const m = /(?:^#|&)t=(\d+(?:\.\d+)?)/.exec(location.hash);
    return m ? +m[1] : null;
  }

  pickStart() {
    // Taken over from the original player (90-main.js): where it was.
    const took = this.opts.takeover;
    if (took && took.at != null) return took.at;
    const dur = this.lesson.duration;
    // A link's time past the end (a link to another recording, a typo) starts at the end.
    const link = this.linkTime();
    if (link != null) return isFinite(dur) && dur > 0 ? Math.min(link, dur) : link;
    // Back from a reload the player made (reloadHere): where it was, once.
    const back = store.get('reloadAt', null);
    if (back) {
      store.set('reloadAt', null);
      if (back.id === this.lesson.id && typeof back.t === 'number' && back.t >= 0 && Math.abs(Date.now() - back.at) < RELOAD_RESUME_MS) return back.t;
    }
    let t0 = this.lesson.resumeAt;
    if (t0 == null) {
      const local = sanitizePos(store.get('pos:' + this.lesson.id, null));
      t0 = local ? local.t : 0;
    }
    if (!(t0 > 0) || (isFinite(dur) && t0 > dur - RESUME_END_SEC)) t0 = 0;
    return t0;
  }

  // ---- streams and layout ----

  // Core playback: an error here hands over to the original player.
  loadClock(pos, startAt, autoplay) {
    try { this.loadClockNow(pos, startAt, autoplay); } catch (e) { if (this.constructing) throw e; reportUnexpected(e); }
  }

  loadClockNow(pos, startAt, autoplay) {
    const v = this.video;
    const source = this.sources[pos];
    this.played.absorb(v.played);
    this.clockPos = pos;
    if (source.poster && startAt < 1) v.poster = source.poster; else v.removeAttribute('poster');
    v.defaultPlaybackRate = this.prefs.rate;
    v.volume = clamp(this.prefs.volume, 0, 1);
    v.muted = !!this.prefs.muted;
    this.volumeCtl.render();
    this.clock.quality = this.quality.qualityFor(pos);
    this.clock.priority = this.quality.roleOf(pos) === 'camera' ? 'low' : 'high';
    this.clock.load(source.av, startAt, () => {
      v.playbackRate = this.prefs.rate;
      // Refused by the browser (autoplay not allowed): no longer meant to play, so the button
      // says Play again. Interrupted by another load: that load carries the intent on.
      if (this.clock.playing()) {
        v.play().catch((e) => { if (e && e.name === 'NotAllowedError') { this.clock.intend(null, false); this.renderPlay(); } });
      }
    }, autoplay);
    this.renderPlay();
  }

  // Which element shows in which place. While the follower is held (holdFollower), it
  // keeps the place the reloading clock will take.
  assignSlots() {
    const pdfView = this.$('.pdfview');
    const held = !!this.hold;
    if (this.pdfMode) {
      const pdfFirst = !!this.prefs.pdfFirst;
      const videoSlot = pdfFirst ? 'secondary' : 'primary';
      this.video.dataset.slot = held ? 'off' : videoSlot;
      this.fvideo.dataset.slot = held ? videoSlot : 'off';
      pdfView.dataset.slot = pdfFirst ? 'primary' : 'secondary';
    } else {
      const clockIsPrimary = !held && (this.clockPos === this.primaryPos || this.layout === 'single');
      this.video.dataset.slot = clockIsPrimary ? 'primary' : 'secondary';
      this.fvideo.dataset.slot = clockIsPrimary ? 'secondary' : 'primary';
      pdfView.dataset.slot = 'off';
    }
  }

  // The clock is reloading with the view the follower shows (single view or the PDF after a
  // swap): the follower stops on its picture and stays in place instead of a black moment,
  // until the clock has a picture at its position; then only the clock plays.
  holdFollower() {
    if (this.sync) { this.sync.dispose(); this.sync = null; }
    this.fvideo.pause();
    const d = this.hold = this.d.child();
    const arrived = () => {
      if (this.hold !== d || this.clock.starting || this.video.readyState < 2) return;
      this.endHold();
      this.assignSlots();
    };
    for (const type of ['canplay', 'seeked', 'playing']) d.listen(this.video, type, arrived);
    // Never arrives (an error, offline): not held for ever.
    d.timeout(() => { if (this.hold === d) { this.endHold(); this.assignSlots(); } }, HOLD_FOLLOWER_MAX_MS);
  }

  // Ends a hold (holdFollower): the follower is released.
  endHold() {
    const d = this.hold;
    if (!d) return;
    this.hold = null;
    d.dispose();
    this.dropFollower();
  }

  ensureFollower() {
    const pos = this.sources.findIndex((s, i) => i !== this.clockPos);
    if (pos < 0) return;
    const source = this.sources[pos];
    const uri = source.v || source.av;
    if (this.follower.uri !== uri) {
      if (source.poster) this.fvideo.poster = source.poster;
      // Where the clock is, or is about to be while it is (re)loading.
      const at = this.clock.position();
      this.followerPos = pos;
      this.follower.quality = this.quality.qualityFor(pos);
      this.follower.priority = this.quality.roleOf(pos) === 'camera' ? 'low' : 'high';
      this.follower.load(uri, at, null);
    }
    if (!this.sync) this.sync = new FollowerSync(this.video, this.fvideo);
  }

  dropFollower() {
    if (this.sync) { this.sync.dispose(); this.sync = null; }
    if (this.follower.uri) this.follower.destroy();
    this.followerPos = -1;
  }

  applyLayout() {
    try { this.applyLayoutNow(); } catch (e) { if (this.constructing) throw e; reportUnexpected(e); }
  }

  applyLayoutNow() {
    // A new arrangement starts with whole pictures.
    if (this.zoom) this.zoom.resetAll();
    const layout = this.layout;
    const st = this.stage;
    const pdf = this.pdfMode;
    for (const l of LAYOUTS) st.classList.toggle('l-' + l, l === layout);
    for (const c of CORNERS) st.classList.toggle('c-' + c, c === this.prefs.corner);
    this.endHold();
    // One video plays when it is shown alone or next to the PDF.
    if (layout === 'single' || pdf) {
      if (this.clockPos !== this.primaryPos && this.sources[this.primaryPos].av) {
        // The follower already shows that view: its picture stays until the clock has one.
        const hold = this.followerPos === this.primaryPos && this.fvideo.readyState >= 2;
        // Asked of the stream, not the element: a switch made while the previous one is
        // still loading would otherwise read 0 (and paused) and start over.
        this.loadClock(this.primaryPos, this.clock.position(), this.clock.playing());
        if (hold) this.holdFollower(); else this.dropFollower();
      } else {
        this.dropFollower();
      }
    } else {
      this.ensureFollower();
    }
    this.assignSlots();
    this.renderLayoutButton();
    if (this.reader) {
      this.reader.setActive('main', pdf);
      if (pdf) this.redrawPdf();
    }
    this.quality.apply();
  }

  // ---- the PDF in the picture area ----

  setPdfMain(on) {
    this.prefs.pdfMain = !!on;
    // Shown alone the PDF would hide the video (or the other way round): put them side by side.
    if (on && this.prefs.layout === 'single') this.prefs.layout = 'side';
    this.savePrefs();
    this.applyLayout();
    if (this.reader) this.reader.info();
  }

  swapPdf() {
    this.prefs.pdfFirst = !this.prefs.pdfFirst;
    this.savePrefs();
    this.applyLayout();
  }

  // Re-renders the main PDF view at its new size (after a layout or window change).
  redrawPdf() {
    if (!this.reader || !this.pdfMode) return;
    windowOf(this.host).requestAnimationFrame(() => {
      const tg = this.reader.targets.get('main');
      const i = this.reader.currentView();
      if (tg && tg.active && i >= 0) this.reader.drawInto(tg, i);
    });
  }

  renderPdfBar() {
    const rd = this.reader;
    const deck = rd && rd.deck;
    const i = rd ? rd.currentView() : -1;
    if (!deck || i < 0) return;
    this.$('.plabel').textContent = rd.label();
    // With several files: the file's name, a button to the next file.
    const fb = this.$('.pfile');
    const shown = rd.shownFile();
    const next = rd.nextFile();
    fb.hidden = !next;
    if (next && shown) {
      fb.textContent = shown.name.replace(/\.pdf$/i, '');
      fb.dataset.tip = tr('showFile', { name: next.name });
      fb.setAttribute('aria-label', tr('pdfFileNext', { name: shown.name, next: next.name }));
    }
    this.$('.pprev').disabled = i <= 0;
    this.$('.pnext').disabled = i >= deck.pages.length - 1;
    const box = this.$('.pfollow');
    box.textContent = '';
    box.append(rd.followElement(true));
  }

  // What the user is looking at, for "copy picture": the larger of the pictures shown (a
  // video or the PDF view), the main place when they are the same size.
  // { video } or { page: { num, file, render(width) -> Promise of a canvas } }.
  focusView() {
    const slots = [...this.root.querySelectorAll('.views [data-slot=primary]'), ...this.root.querySelectorAll('.views [data-slot=secondary]')];
    let best = slots[0];
    for (const e of slots.slice(1)) if (e.clientWidth * e.clientHeight > best.clientWidth * best.clientHeight) best = e;
    const rd = this.reader;
    const i = rd && rd.deck ? rd.currentView() : -1;
    if (best && best.classList.contains('pdfview') && this.pdfMode && i >= 0) {
      const p = rd.deck.pages[i];
      return { page: { num: p.num, file: p.file, render: (w) => rd.deck.render(i, w, true) } };
    }
    return { video: best && best.tagName === 'VIDEO' ? best : this.video };
  }

  // Layouts offered in the settings menu ([]: one picture only).
  layoutChoices() {
    return this.dual || this.pdfMode ? LAYOUTS : [];
  }

  // The layout button's cycle. With the PDF view open it switches between side by side and
  // picture in picture: alone, the PDF or the video would be hidden (single view stays in
  // the settings menu).
  layoutCycle() {
    if (this.pdfMode) return ['side', 'pip'];
    return this.dual ? LAYOUTS : [];
  }

  nextLayout() {
    const list = this.layoutCycle();
    return list[(list.indexOf(this.layout) + 1) % list.length];
  }

  // The icon shows the layout now; the tooltip says what a press switches to.
  renderLayoutButton() {
    const b = this.$('.layout');
    const hide = !this.layoutCycle().length;
    if (b.hidden !== hide) { b.hidden = hide; this.menus.fitBar(); }
    if (hide) return;
    const now = this.layout;
    const to = tr({ side: 'layoutToSide', pip: 'layoutToPip', single: 'layoutToSingle' }[this.nextLayout()]);
    b.innerHTML = svg(now === 'side' ? 'layoutSide' : now === 'pip' ? 'layoutPip' : 'layoutSingle');
    b.setAttribute('aria-label', tr('layoutNow', { layout: tr(layoutKey(now)) }) + tr('sepSentence') + to);
    b.dataset.tip = to;
    this.menus.refresh();
  }

  setTheme(theme) {
    this.prefs.theme = theme;
    this.app.dataset.theme = theme;
    this.savePrefs();
  }

  // The interface language is decided when the page loads: a change is saved (with the
  // position) and the page reloads.
  setLang(lang) {
    if (lang === this.prefs.lang) return;
    this.prefs.lang = lang;
    clearTimeout(this.prefsTimer);
    store.set('prefs', this.prefs);
    this.reloadHere();
  }

  // Reloads the page and comes back where playback is now. (Echo360's own last position,
  // which pickStart prefers, follows only what was played, not a seek.)
  reloadHere() {
    store.set('reloadAt', { id: this.lesson.id, t: this.clock.position(), at: Date.now() });
    this.savePosition();
    location.reload();
  }

  setLayout(layout) {
    if (!(this.dual || this.pdfMode) || !LAYOUTS.includes(layout)) return;
    if (this.emptyScreen) this.emptyScreen.manual();
    this.followerFailed = false;
    this.prefs.layout = layout;
    this.savePrefs();
    this.applyLayout();
  }

  // Swaps the screen and camera views. With the PDF in the picture area, this changes which
  // video is shown next to it (or, with one video, swaps the PDF and the video).
  swapViews() {
    if (!this.dual) { if (this.pdfMode) this.swapPdf(); return; }
    // The camera was shown alone for an empty screen: a swap asks for the screen back.
    if (this.emptyScreen && this.emptyScreen.manual()) return;
    const next = this.secondaryPos;
    // A source without an audio+video rendition can only be shown as the follower.
    if ((this.layout === 'single' || this.pdfMode) && !this.sources[next].av) return;
    this.primaryPos = next;
    this.prefs.primary = this.sources[next].index;
    this.savePrefs();
    this.applyLayout();
  }

  onClockFatal(f) {
    if (this.destroyed) return;
    if (f.auth) {
      this.recoverAccess(this.clock, () => this.showAuthError());
      return;
    }
    this.showError(tr('playbackFailedTitle'), tr('playbackFailedText', { detail: playbackFailReason(f, navigator.onLine !== false) }),
      [[tr('retry'), () => this.retryPlayback(), true], [tr('useOriginal'), () => this.opts.onFallback('error')]]);
    this.playbackFailed = true;
  }

  retryPlayback() {
    this.hideError();
    this.loadClock(this.clockPos, this.clock.position(), true);
  }

  // Back online: load again at once instead of waiting for the next retry, and retry a
  // playback that gave up while offline. Parts that failed to load try again too.
  onOnline() {
    this.$('.nethint').hidden = true;
    if (this.playbackFailed) { this.retryPlayback(); return; }
    const v = this.video;
    if (!v.paused && v.readyState < 3) this.clock.kick(v.currentTime);
    if (this.follower && this.fvideo.readyState < 3) this.follower.kick(this.fvideo.currentTime);
    for (const retry of this.partRetries.values()) retry();
  }

  // The video files were refused: renew the access in the background and carry on from
  // the current position with the same element. A second refusal right after a renewal,
  // or a renewal that fails, ends in `fail`.
  recoverAccess(stream, fail) {
    const now = Date.now();
    if (stream.renewedAt && now - stream.renewedAt < RENEW_REFUSAL_MS) { fail(); return; }
    // The stream may be reloaded (views swapped) while renewing: resume only the instance
    // that failed; a new one has started loading by itself.
    const engine = stream.hls;
    this.session.renew(true).then(() => {
      if (this.destroyed || stream.hls !== engine) return;
      stream.renewedAt = Date.now();
      stream.resume(stream.position());
    }, () => { if (!this.destroyed) fail(); });
  }

  showAuthError() {
    const login = this.session.failed && this.session.failed.login;
    this.showError(tr('authExpiredTitle'), tr(login ? 'authLoginExpiredText' : 'authExpiredText'),
      [[tr('reload'), () => this.reloadHere(), true], [tr('useOriginal'), () => this.opts.onFallback('auth')]]);
  }

  onFollowerFatal() {
    if (this.destroyed || this.followerFailed) return;
    // Keep watching with the clock alone; the layout preference is kept for next time.
    this.followerFailed = true;
    this.applyLayout();
    this.toast(tr('secondViewLost'), tr('retry'), () => this.setLayout(this.prefs.layout));
  }

  // ---- the parts ----

  setupParts() {
    const $ = (sel) => this.$(sel);
    const savePrefs = () => this.savePrefs();
    const toast = (...a) => this.toast(...a);
    const isDestroyed = () => this.destroyed;
    const layer = this.$('.layer');
    this.pops = new Popovers(layer, this.d.child(), (open) => { if (open) this.wake(); else this.armIdle(); });
    this.tooltips = new Tooltips(this.root, layer, this.d.child());
    this.seekBar = new SeekBar({
      $, video: this.video, clock: this.clock, duration: () => this.duration(), seek: (t) => this.seek(t),
      isIdle: () => this.stage.classList.contains('idle'), armIdle: () => this.armIdle(), markers: this.markers, ui: this.ui,
      previewAt: (t) => this.previewAt(t), skipAt: (t) => (this.silence ? this.silence.skipAt(t) : null),
    }, this.d.child());
    this.quality = new QualityController({
      prefs: this.prefs, onChange: () => { if (this.menus) this.menus.refresh(); }, savePrefs, sources: this.sources, dual: this.dual,
      screenIndex: () => (this.slides ? this.slides.screenIndex : null),
      streams: () => [{ stream: this.clock, elem: this.video, pos: this.clockPos }, { stream: this.follower, elem: this.fvideo, pos: this.followerPos }],
      shown: () => (this.layout === 'single' || this.clockPos === this.primaryPos ? this.clock : this.follower),
      layout: () => this.layout,
    }, this.d.child());
    this.layoutControls = new LayoutControls({
      $, stage: this.stage, prefs: this.prefs, savePrefs, ui: this.ui, armIdle: () => this.armIdle(), redrawPdf: () => this.redrawPdf(),
      // A click swaps the two pictures (with the PDF shown: the PDF and the video).
      onPipClick: () => { if (this.pdfMode) this.swapPdf(); else this.swapViews(); },
    }, this.d.child());
    const notesReady = () => !!(this.notes && this.notesReady);
    this.menus = new MenuBar({
      $, root: this.root, pops: this.pops, stage: this.stage, video: this.video, prefs: this.prefs, savePrefs, cc: this.cc, toast,
      cues: () => this.cues || [], focusView: () => this.focusView(), title: this.lesson.title, duration: () => this.duration(),
      diagnostics: () => diagnosticsText(this),
      layouts: () => this.layoutChoices(), layout: () => this.layout, setLayout: (l) => this.setLayout(l), swap: () => this.swapViews(),
      canEmptyCamera: () => !!this.emptyScreen && this.dual,
      setEmptyCamera: (on) => { this.emptyScreen.setEnabled(on); this.emptyScreen.tick(this.clock.position()); },
      pdfMode: () => this.pdfMode, setTheme: (t) => this.setTheme(t), setLang: (l) => this.setLang(l),
      // Optional features add their pages and actions once they have started.
      pages: this.menuPages = { quality: () => this.quality.items(), audio: null, silence: null },
      values: this.menuValues = { quality: () => this.quality.value(), audio: () => '', silence: () => '' },
      actions: this.menuActions = {
        bookmark: (e) => { if (notesReady()) this.notes.toggleBookmark(e); },
        bookmarkHere: () => !!this.bookmarkHere,
        popout: PopoutController.supported() ? () => this.popout.toggle() : null,
        loopA: () => this.loop.setA(this.video.currentTime), loopB: () => this.loop.setB(this.video.currentTime),
        loopClear: () => this.loop.clear(), loopLabel: () => (this.loop ? this.loop.label() : tr('loopNone')),
        exportNotes: null, showKeys: () => this.keys.showHelp(true), original: () => this.opts.onFallback('user'),
      },
    }, this.d.child());
    this.menus.captionsAvailable(tr('captionsLoading'));
    this.volumeCtl = new VolumeControl({ $, video: this.video }, this.d.child());
    this.speed = new SpeedControl({ $, pops: this.pops, rate: () => this.video.playbackRate || this.prefs.rate, setRate: (r) => this.setRate(r) }, this.d.child());
    this.keys = new KeyboardShortcuts({ $, isDestroyed, wake: () => this.wake(), actions: this.keyActions() }, this.d.child());
    this.popout = new PopoutController({
      $, host: this.host, video: this.video, title: this.lesson.title, onKey: this.keys.onKey, isDestroyed, toast,
      relayout: () => { this.quality.apply(); this.redrawPdf(); this.render(true); this.menus.fitBar(); this.pops.place(); },
    }, this.d.feature('floating window'));
  }

  // What the keyboard shortcuts do (see 42-keys.js); false: not available now.
  keyActions() {
    const v = this.video;
    const notesReady = () => this.notes && this.notesReady;
    return {
      togglePlay: () => this.togglePlay(),
      seekBy: (s) => this.seek(this.clock.position() + s),
      stepChapter: (dir) => this.stepChapter(dir),
      volumeBy: (dv) => this.volumeCtl.by(dv, true),
      toggleMute: () => { v.muted = !v.muted; },
      fullscreen: () => this.toggleFullscreen(),
      swap: () => this.swapViews(),
      captions: () => {
        const why = unavailableReason(this.$('.ccbtn'));
        if (why) this.toast(why); else this.menus.setCaptions(!this.cc.on);
      },
      transcript: () => (this.sidebar.has('transcript') ? this.sidebar.toggle('transcript') : false),
      bookmark: (a, e) => (notesReady() ? this.notes.toggleBookmark(e) : false),
      flag: (a, e) => (notesReady() && this.notes.canFlag ? this.notes.flagByKey(e) : false),
      tag: (a, e) => (notesReady() ? this.notes.tagHere(e) : false),
      copyFrame: () => this.menus.copyFrame(),
      copyCaptions: () => this.menus.copyCaptions(),
      escape: () => {
        if (this.menus.diagnosticsOpen) this.menus.showDiagnostics(false);
        else if (this.menus.myDataOpen) this.menus.showMyData(false);
        else if (this.keys.helpOpen) this.keys.showHelp(false);
        else if (this.pops.isOpen()) this.pops.close(true);
        else return false;
        return true;
      },
      zoom: (f) => this.zoomMain(f),
      loopA: () => this.loop.setA(v.currentTime),
      loopB: () => this.loop.setB(v.currentTime),
      loopClear: () => (this.loop.a != null ? this.loop.clear() : false),
      popout: () => (PopoutController.supported() ? this.popout.toggle() : false),
      exportNotes: () => (notesReady() ? this.notes.openExport() : false),
      speed: (dir) => this.setRate(nextSpeed(v.playbackRate, dir)),
    };
  }

  // ---- video events ----

  bindVideo() {
    const v = this.video;
    const stage = this.stage;
    // The clock video's events are core playback: an error here hands over to the original player.
    const d = this.d.core();
    const on = (type, fn) => d.listen(v, type, fn);
    on('play', () => {
      // Back after a long pause (or a sleeping laptop): renew the access before it runs out.
      this.session.wake();
      // Play is normally user-initiated; also recovers a context the browser suspended.
      if (this.audio) { this.audio.resume(); this.audio.syncTimer(); }
      this.renderPlay();
      if (this.reporter) this.reporter.onPlay();
      this.armIdle();
    });
    on('pause', () => {
      if (this.audio) this.audio.syncTimer();
      this.renderPlay();
      if (this.reporter) this.reporter.onPause();
      this.savePosition();
      this.wake();
    });
    on('waiting', () => stage.classList.add('waiting'));
    on('seeking', () => stage.classList.add('waiting'));
    const clearWaiting = () => stage.classList.remove('waiting');
    on('playing', clearWaiting);
    on('seeked', clearWaiting);
    on('canplay', clearWaiting);
    const invalidate = () => this.frame.request();
    // The optional features these events update: an error in one is not a playback error.
    // It is reported once and that feature is no longer updated here (these run several
    // times a second).
    const broken = new Set();
    const feature = (name, fn) => {
      if (broken.has(name)) return;
      try { fn(); } catch (e) { broken.add(name); reportFeatureError(name, e); }
    };
    const onTime = () => {
      const ct = v.currentTime;
      // Where playback is meant to be: while the start position loads, the element still
      // says 0, and nothing may act on that moment (skip a silence, switch the layout).
      const pos = this.clock.position();
      if (this.loop) feature('A-B loop', () => this.loop.tick(ct));
      feature('captions', () => { this.cc.update(ct); this.transcript.update(ct); });
      feature('notes', () => {
        const scene = Math.floor(ct / FLAG_SCENE_SECONDS);
        if (scene !== this.flagScene) { this.flagScene = scene; this.renderFlagButton(); }
        this.renderBookmarkButton();
      });
      if (this.silence) feature('silence detection', () => this.silence.tick(pos));
      if (this.slidesPane) feature('slide chapters', () => this.slidesPane.update(ct));
      if (this.reader) feature('slide reader', () => this.reader.update(ct));
      if (this.notes && this.notesReady) feature('notes', () => this.notes.update());
      if (this.emptyScreen) feature('camera for an empty screen', () => this.emptyScreen.tick(pos));
      if (this.discussion) feature('discussion', () => this.discussion.update());
    };
    on('timeupdate', () => { invalidate(); onTime(); });
    on('seeked', onTime);
    on('progress', invalidate);
    on('durationchange', () => {
      this.render(true);
      if (this.loop) feature('A-B loop', () => this.loop.render());
      feature('watched parts', () => this.renderWatched());
      feature('notes', () => this.updateMarkers());
      if (this.silence) feature('silence detection', () => this.silence.update());
      feature('slide chapters', () => this.renderChapterMarks());
    });
    on('ratechange', () => this.speed.render(v.playbackRate));
    on('volumechange', () => {
      this.volumeCtl.render();
      this.prefs.volume = v.volume;
      this.prefs.muted = v.muted;
      this.savePrefs();
    });
    on('ended', () => this.savePosition(0));
    d.listen(document, 'visibilitychange', () => { if (!document.hidden) this.render(true); });
    d.listen(window, 'hashchange', () => { const tm = this.linkTime(); if (tm != null) this.seek(tm); });
    d.listen(window, 'offline', () => { this.$('.nethint').hidden = false; });
    d.listen(window, 'online', () => this.onOnline());
    if (navigator.onLine === false) this.$('.nethint').hidden = false;

    // Stall watchdog (playing, not seeking, time has not moved for STALL_SEC) and, every
    // few ticks, the local resume position as a fallback for the server-side one.
    let lastT = -1;
    let still = 0;
    let tick = 0;
    d.interval(() => {
      if (v.paused || v.seeking || v.ended) { still = 0; lastT = v.currentTime; return; }
      if (v.currentTime === lastT) {
        still += STALL_CHECK_MS / 1000;
        if (still >= STALL_SEC) {
          log.warn('playback stalled, restarting loader at', v.currentTime.toFixed(1));
          this.clock.kick(v.currentTime);
          still = 0;
        }
      } else { still = 0; lastT = v.currentTime; }
      if (++tick % POSITION_SAVE_EVERY === 0) { this.savePosition(); this.watched.save(this.duration()); this.renderWatched(); }
    }, STALL_CHECK_MS);
  }

  setButton(sel, icon, label, tip) {
    const b = this.$(sel);
    b.innerHTML = svg(icon);
    b.setAttribute('aria-label', label);
    b.dataset.tip = tip;
  }

  savePrefs() {
    clearTimeout(this.prefsTimer);
    this.prefsTimer = setTimeout(() => store.set('prefs', this.prefs), 300);
  }

  savePosition(pos) {
    store.set('pos:' + this.lesson.id, { t: pos === undefined ? this.clock.position() : pos, at: Date.now() });
  }

  duration() {
    return mediaDuration(this.video, this.lesson);
  }

  // Time label, progress and buffer bars (at most once per frame, see SeekBar).
  render(force) {
    if (!this.destroyed) this.seekBar.render(force);
  }

  seek(target) {
    const dur = this.duration();
    const to = clamp(target, 0, dur ? dur - 0.1 : target);
    this.clock.intend(to, null);
    this.video.currentTime = to;
    this.render(true);
    if (this.loop) this.loop.seeked(to);
  }

  togglePlay() {
    const v = this.video;
    // While (re)loading the element says paused: go by what the stream is meant to do.
    const play = this.clock.starting ? !this.clock.playing() : v.paused || v.ended;
    this.clock.intend(null, play);
    if (play) v.play().catch(() => {}); else v.pause();
    this.renderPlay();
  }

  // The play button (and the paused look) show what playback is meant to do: while a stream
  // (re)loads the element says paused, though it is about to play (a takeover of a playing
  // original, a switch of views made while playing).
  renderPlay() {
    const play = this.clock.starting ? this.clock.playing() : !this.video.paused;
    this.stage.classList.toggle('paused', !play);
    if (play) this.setButton('.play', 'pause', tr('pause'), tr('pauseKey'));
    else this.setButton('.play', 'play', tr('play'), tr('playKey'));
  }

  setRate(r) {
    r = clamp(Math.round(r * 100) / 100, 0.25, 4);
    this.video.playbackRate = r;
    this.video.defaultPlaybackRate = r;
    this.prefs.rate = r;
    this.savePrefs();
  }

  // Where no element can be fullscreen (iPhone), the main video goes into the system's own
  // player: one view, its own controls; back inline it plays on in ours.
  toggleFullscreen() {
    if (fullscreenElement()) exitFullscreen();
    else if (!requestFullscreen(this.host) && typeof this.video.webkitEnterFullscreen === 'function') this.video.webkitEnterFullscreen();
  }

  // ---- idle (auto-hide) handling ----

  wake() {
    const wasIdle = this.stage.classList.contains('idle');
    this.stage.classList.remove('idle');
    if (wasIdle) this.render(true);
    this.armIdle();
  }

  armIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(guard(() => {
      if (!this.video.paused && !this.ui.dragging && !this.pops.isOpen()) this.stage.classList.add('idle');
    }), CONTROLS_HIDE_MS);
  }

  // The plain buttons, clicks on the pictures, zoom, the side panel chips.
  bindControls() {
    const $ = (sel) => this.$(sel);
    const v = this.video;
    const d = this.d;
    // Old analysis results are cleaned up in the background, once the page has settled.
    d.timeout(() => analysisCaches.prune().catch(() => {}), 60000);
    d.add(() => { clearTimeout(this.idleTimer); clearTimeout(this.toastTimer); clearTimeout(this.sharpTimer); clearTimeout(this.prefsTimer); store.set('prefs', this.prefs); });
    d.listen($('.play'), 'click', () => this.togglePlay());
    d.listen($('.rew'), 'click', () => this.seek(this.clock.position() - 10));
    d.listen($('.fwd'), 'click', () => this.seek(this.clock.position() + 10));
    d.listen($('.fs'), 'click', () => this.toggleFullscreen());
    // In a frame whose page does not allow it, neither the player nor a video can be
    // fullscreen: said on the button instead of a click that does nothing.
    if (!fullscreenAllowed(document) && typeof this.video.webkitEnterFullscreen !== 'function') setUnavailable($('.fs'), tr('fullscreenBlocked'), tr('fullscreenKey'));
    d.listen($('.swapdot'), 'click', (e) => { e.stopPropagation(); this.swapViews(); });
    d.listen($('.layout'), 'click', () => this.setLayout(this.nextLayout()));
    const onFullscreen = () => {
      const fs = !!fullscreenElement();
      this.setButton('.fs', fs ? 'exitFullscreen' : 'fullscreen', tr(fs ? 'exitFullscreen' : 'fullscreen'), tr(fs ? 'exitFullscreenKey' : 'fullscreenKey'));
    };
    d.listen(document, 'fullscreenchange', onFullscreen);
    d.listen(document, 'webkitfullscreenchange', onFullscreen);
    let resizeTimer = 0;
    d.add(() => clearTimeout(resizeTimer));
    d.listen(window, 'resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(guard(() => { this.quality.apply(); this.redrawPdf(); }), 500); });
    for (const chip of this.all('.top [data-open]')) d.listen(chip, 'click', () => this.sidebar.toggle(chip.dataset.open));
    d.listen($('.panelclose'), 'click', () => this.sidebar.close());
    d.listen($('.bmbtn'), 'click', (e) => { if (this.notes && this.notesReady) this.notes.toggleBookmark(e); });
    d.listen($('.pextras button'), 'click', () => this.opts.onFallback('extras'));
    this.bindPanelResize();
    this.loop = new ABLoop({
      pops: this.pops, rail: $('.seek'), video: v, duration: () => this.duration(), seek: (t) => this.seek(t), toast: (...a) => this.toast(...a),
    }, this.d.feature('A-B loop'));

    // Click on a picture: play/pause; double click: fullscreen. While the controls are
    // hidden, the first click only brings them back (it may be aimed at a hidden button).
    let clickTimer = 0;
    let wokeByPress = false;
    d.add(() => clearTimeout(clickTimer));
    d.listen(this.stage, 'pointerdown', () => {
      wokeByPress = this.stage.classList.contains('idle');
      this.wake();
    }, true);
    const views = $('.views');
    this.zoom = new Zoomer(views, this.d.feature('zoom'), {
      // The PDF is drawn again at the zoom level once zooming pauses (in steps, so that
      // small changes do not render it again).
      onChange: () => {
        clearTimeout(this.sharpTimer);
        this.sharpTimer = setTimeout(guard(() => {
          const tg = this.reader && this.reader.targets.get('main');
          if (!tg || this.destroyed) return;
          const sharp = Math.min(4, Math.max(1, Math.round(this.zoom.get(tg.pages).s * 2) / 2));
          if (sharp !== (tg.sharp || 1)) { tg.sharp = sharp; this.redrawPdf(); }
        }), 250);
      },
      // Not the small picture-in-picture window.
      canZoom: (elem) => !(this.layout === 'pip' && (elem.closest('[data-slot]') || elem).dataset.slot === 'secondary'),
    });
    d.listen(views, 'click', (e) => {
      if (e.target.tagName !== 'VIDEO') return;
      if (this.zoom.dragged) return;
      if (wokeByPress) { wokeByPress = false; return; }
      clearTimeout(clickTimer);
      clickTimer = setTimeout(guard(() => this.togglePlay()), DOUBLE_CLICK_MS);
    });
    d.listen(views, 'dblclick', (e) => {
      // Zoomed in: back to the whole picture; otherwise full screen.
      const z = this.zoom.targetOf(e.target);
      if (z && this.zoom.zoomed(z)) { clearTimeout(clickTimer); this.zoom.reset(z); return; }
      if (e.target.tagName !== 'VIDEO') return;
      clearTimeout(clickTimer);
      this.toggleFullscreen();
    });

    // Auto-hide
    d.listen(this.stage, 'pointermove', () => this.wake());
    d.listen(this.stage, 'pointerleave', (e) => {
      // Touch ends with pointerleave even when the finger was lifted inside the player.
      // Keep the controls until the idle timer expires so the next tap can pause.
      if (e.pointerType !== 'touch' && !v.paused) this.stage.classList.add('idle');
    });
  }

  // ---- captions and transcript ----

  loadCues() {
    this.cues = null;
    const none = () => { if (!this.destroyed) this.menus.captionsAvailable(tr('captionsNone')); };
    if (!this.opts.fetchCues) { none(); if (this.silence) this.silence.start([]); return; }
    // Silence detection waits until it is known whether there is a transcript (a load that
    // failed for now is retried), so that it does not settle for the audio-only analysis.
    let cues = [];
    const load = () => this.opts.fetchCues(this.lesson).then((c) => {
      if (this.destroyed) return false;
      if (this.silence) this.silence.start(c);
      if (!c.length) { none(); return false; }
      cues = c;
      return true;
    }, (e) => {
      log.warn('captions:', e && e.message ? e.message : e);
      if (this.destroyed) return false;
      if (isTransient(e) || e.login) { this.menus.captionsAvailable(tr('captionsLoadFailed')); return e; }
      none();
      if (this.silence) this.silence.start([]);
      return false;
    });
    this.loadPart('transcript', this.transcript, load, () => {
      this.cues = cues;
      if (this.slidesPane) this.slidesPane.invalidate();
      if (this.reporter) this.reporter.captionsAvailable = cues.length;
      this.cc.setCues(cues);
      this.transcript.setCues(cues);
      this.menus.captionsAvailable('');
      if (this.prefs.captions) this.menus.setCaptions(true, true);
    }, 'transcriptLoadFailed');
  }

  // ---- audio processing ----

  setupAudio() {
    const a = new AudioChain(this.video);
    this.audio = a;
    this.d.add(() => a.dispose());
    a.settings = { level: !!this.prefs.audio.level, voice: !!this.prefs.audio.voice, mono: !!this.prefs.audio.mono };
    const why = () => (a.reason === 'noWebAudio' ? tr('audioNoWebAudio') : a.reason ? tr('audioNativeHls') : '');
    // The settings page: one switch per tool (shown off, with the reason, when unsupported).
    this.menuPages.audio = () => [['level', 'audioLevel'], ['voice', 'audioVoice'], ['mono', 'audioMono']].map(([k, label]) => ({
      kind: 'toggle', label: tr(label), desc: tr(label + 'Desc'), reason: why, on: () => !!a.settings[k],
      set: (on) => {
        a.build();
        a.resume();
        a.set({ [k]: !!on });
        this.prefs.audio = Object.assign({}, a.settings, { levelChosen: this.prefs.audio.levelChosen || k === 'level' });
        this.savePrefs();
      },
    }));
    this.menuValues.audio = () => (!a.reason && a.anyOn() ? tr('on') : tr('off'));
    // Remembered settings: build the graph on the first user gesture, never before.
    if (!a.reason && a.anyOn()) {
      const onGesture = () => {
        if (a.built) return;
        a.build();
        a.resume();
        a.apply();
      };
      this.d.listen(this.host, 'pointerdown', onGesture, true);
      this.d.listen(document, 'keydown', onGesture, true);
    }
  }

  // ---- slide chapters ----

  setupSlides() {
    this.slidesPane = null;
    this.slides = new SlideAnalyzer({
      lesson: this.lesson,
      video: this.video,
      disposer: this.d.feature('slide chapters'),
      onChange: () => { if (!this.destroyed) this.onSlidesChange(); },
    });
    this.slides.start();
  }

  onSlidesChange() {
    const a = this.slides;
    let empty = false;
    if (a.uniform !== this.knownUniform) { this.knownUniform = a.uniform; empty = true; if (this.silence) this.silence.update(); }
    // The screen view is known now: the per-view quality settings may apply differently.
    if (a.screenIndex !== this.knownScreen) {
      this.knownScreen = a.screenIndex;
      empty = true;
      this.quality.apply();
      if (this.deck) this.deck.screenKnown();
    }
    if (empty && this.emptyScreen) this.emptyScreen.tick(this.clock.position());
    this.renderChapterMarks();
    if (a.chapters.length && this.usage) this.usage.mark('chapters');
    // The tab also holds the slide reader: it is there once the analysis has an answer,
    // even when no chapters were found.
    if (!this.slidesPane && !a.chapters.length && a.state !== 'done' && a.state !== 'unavailable') return;
    if (a.state === 'unavailable' && this.deck) this.deck.screenKnown();
    if (!this.slidesPane) {
      this.slidesPane = new SlidesPane(this, this.$('.pane[data-pane=slides]'), this.d.child());
      this.registerTab('slides', this.slidesPane);
    }
    const pct = Math.floor(a.progress * 100);
    const status = a.reason === 'saveData' && !a.chapters.length ? tr('slidesSaveData')
      : !a.chapters.length && (a.state === 'done' || a.state === 'unavailable') ? tr('slidesNone')
      : a.state === 'done' ? tr(a.source === 'thumbs' ? 'slidesFromPreview' : 'slidesFound', { n: a.chapters.length })
        : !HlsVideoReader.supported() ? tr('slidesPreviewFinding')
          : a.state === 'thumbnails' ? tr('slidesRough', { pct }) : tr('slidesFinding', { pct });
    this.slidesPane.setChapters(a.chapters, status);
  }

  // ---- slide files ----

  setupDeck() {
    this.reader = new SlideReader(this);
    this.reader.addTarget('main', this.$('.pstage'));
    this.d.add(this.reader.onInfo(() => { if (!this.destroyed) this.renderPdfBar(); }));
    this.deck = new SlideDeckController({
      lesson: this.lesson,
      video: this.video,
      slides: this.slides,
      disposer: this.d.feature('slide reader'),
      onChange: () => {
        if (this.destroyed) return;
        if (this.slidesPane) this.slidesPane.invalidate();
        // The PDF view appears (pages loaded) or goes (files removed) with the deck.
        if (this.pdfMode !== this.shownPdfMode) { this.shownPdfMode = this.pdfMode; this.applyLayout(); }
        if (this.reader.active) this.reader.update(this.video.currentTime, true);
        if (this.deck && this.deck.decided && this.usage) this.usage.mark('pdf');
      },
    });
    this.deck.restore().catch((e) => log.warn('slide files:', e && e.message ? e.message : e));
    const bar = (sel, fn) => this.d.listen(this.$(sel), 'click', (e) => { e.stopPropagation(); fn(); });
    bar('.pprev', () => this.reader.turn(-1));
    bar('.pnext', () => this.reader.turn(1));
    bar('.pfile', () => { const f = this.reader.nextFile(); if (f) this.reader.showFile(f.hash); });
    bar('.pswap', () => this.swapPdf());
    bar('.pdfclose', () => this.setPdfMain(false));
    // Dropping PDF files anywhere on the player adds them.
    const zone = this.$('.dropzone');
    const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    let depth = 0;
    this.d.listen(this.host, 'dragenter', (e) => { if (hasFiles(e)) { depth++; zone.hidden = false; } });
    this.d.listen(this.host, 'dragleave', () => { if (--depth <= 0) { depth = 0; zone.hidden = true; } });
    this.d.listen(this.host, 'dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
    this.d.listen(this.host, 'drop', (e) => {
      depth = 0;
      zone.hidden = true;
      if (!hasFiles(e)) return;
      e.preventDefault();
      this.deck.addFiles(e.dataTransfer.files).then((n) => {
        if (!n) { this.toast(tr('dropNotPdf')); return; }
        if (this.sidebar.has('slides')) this.sidebar.open('slides');
      }).catch((err) => this.toast(this.deck.state === 'error' && this.deck.error ? this.deck.error : tr('deckError', { msg: String((err && err.message) || err) })));
    });
  }

  renderChapterMarks() {
    this.seekBar.renderChapters(this.slides ? this.slides.chapters : []);
  }

  renderWatched() {
    if (this.watched.ready) this.seekBar.renderWatched(this.watched.ranges());
  }

  // Picture for the seek-bar preview: the slide shown at t if chapters are known,
  // otherwise Echo360's per-minute thumbnail of the main view.
  previewAt(t) {
    const chs = this.slides ? this.slides.chapters : [];
    const k = chapterIndexAt(chs, t);
    if (k >= 0 && chs[k].thumb) return chs[k].thumb;
    const src = this.sources[this.primaryPos];
    const set = (this.lesson.thumbnails || []).find((s) => s.sourceIndex === src.index);
    if (!set || !Array.isArray(set.timesInSeconds) || !set.timesInSeconds.length) return '';
    const times = set.timesInSeconds;
    let pick = times[0];
    for (const x of times) { if (x <= t) pick = x; else break; }
    return thumbUrlOf(set, pick);
  }

  // Previous / next chapter; returns false when there are none (key not handled).
  stepChapter(dir) {
    const chs = this.slides ? this.slides.chapters : [];
    if (!chs.length) return false;
    const ct = this.video.currentTime;
    let k = chapterIndexAt(chs, ct);
    // "Previous" from more than 3 s into a chapter restarts it, like a music player.
    if (dir < 0 && k >= 0 && ct - chs[k].start > 3) dir = 0;
    k = clamp(k + dir, 0, chs.length - 1);
    this.seek(chs[k].start);
    return true;
  }

  // ---- side panel, notes, discussion, markers ----

  registerTab(tab, controller) {
    this.sidebar.register(tab, controller);
    if (this.prefs.panel && this.prefs.tab === tab && !this.sidebar.isOpen) {
      this.restoringPanel = true;
      this.sidebar.open(tab);
      this.restoringPanel = false;
    }
  }

  onSidebarChange() {
    const sb = this.sidebar;
    this.app.classList.toggle('panel-open', sb.isOpen);
    for (const chip of this.all('.top [data-open]')) chip.setAttribute('aria-pressed', String(sb.visible(chip.dataset.open)));
    if (sb.visible('transcript')) this.transcript.renderMarks();
    if (!this.restoringPanel && sb.active) {
      this.prefs.panel = sb.isOpen;
      this.prefs.tab = sb.active;
      this.savePrefs();
    }
  }

  loadInteractions() {
    const l = this.lesson;
    const api = this.opts.api && l.lessonId && l.mediaId ? this.opts.api(l) : null;
    if (!api) return;
    this.writesHeld = api.dryRun;
    const canFlag = !!l.sectionId && !l.isAnonymousUser;
    this.tags = new TagStore(l, () => { if (!this.destroyed && this.notes) this.notes.changed(); });
    this.tags.load().catch((e) => log.warn('tags:', e && e.message ? e.message : e));
    this.notes = new NotesPane(this, this.$('.pane[data-pane=notes]'), api, canFlag, this.d.feature('notes'));
    this.loadPart('notes', this.notes, () => this.notes.load(), () => {
      this.notesReady = true;
      this.$('.bmbtn').hidden = false;
      this.menus.fitBar();
      this.menuActions.exportNotes = () => this.notes.openExport();
      this.renderFlagButton();
      this.renderBookmarkButton();
    }, 'notesLoadFailed');
    this.discussion = new DiscussionPane(this, this.$('.pane[data-pane=discussion]'), api, this.d.feature('discussion'));
    this.loadPart('discussion', this.discussion, () => this.discussion.load(), () => {}, 'discussionLoadFailed');
  }

  // Loads what a side-panel tab shows. `load` resolves true when loaded, false when this
  // lesson does not offer it (no tab), or to the error. An error that may pass by itself
  // (isTransient: no connection, server error) keeps the tab, which says what happened
  // with "Retry"; it is also tried again when the browser comes back online.
  loadPart(tab, controller, load, ready, failKey) {
    const pane = this.$('.pane[data-pane=' + tab + ']');
    let busy = false;
    const attempt = () => {
      if (busy || this.destroyed) return;
      busy = true;
      Promise.resolve().then(load).then((r) => r, (e) => e).then(guard((r) => {
        busy = false;
        if (this.destroyed) return;
        if (r === true) {
          this.partRetries.delete(tab);
          this.showPartError(pane, '');
          ready();
          this.registerTab(tab, controller);
        } else if (r && (r.login || (r.status === 401 && !this.lesson.isAnonymousUser))) {
          // Signed out: only signing in again helps, which a reload offers.
          this.showPartError(pane, tr('authLoginExpiredText'), () => this.reloadHere(), tr('reload'));
          this.registerTab(tab, controller);
        } else if (r && isTransient(r)) {
          log.info(tab + ' failed to load, can retry:', r.message);
          this.partRetries.set(tab, attempt);
          this.showPartError(pane, tr(failKey, { error: loadErrorText(r) }), attempt);
          this.registerTab(tab, controller);
        }
      }));
    };
    attempt();
  }

  showPartError(pane, msg, action, label) {
    let box = pane.querySelector(':scope > .loaderr');
    if (msg && !box) {
      box = el('div.loaderr', { role: 'alert' }, el('p'), el('button.pbtn'));
      pane.prepend(box);
    }
    pane.classList.toggle('loadfailed', !!msg);
    if (!box) return;
    box.hidden = !msg;
    box.querySelector('p').textContent = msg;
    const b = box.querySelector('button');
    b.textContent = label || tr('retry');
    b.onclick = action || null;
  }

  updateMarkers() {
    if (this.destroyed) return;
    const items = [];
    // Where Echo360 says playback stopped last time (any device), as it was when the page opened.
    const last = this.lesson.resumeAt;
    if (last > 1 && last < this.duration() - 1) items.push({ time: last, kind: 'laststop', label: tr('lastStopped') });
    if (this.notes) items.push(...this.notes.markers());
    if (this.discussion && this.sidebar.has('discussion')) items.push(...this.discussion.markers());
    this.markers.set(items, this.duration());
  }

  // The "Didn't understand" button in the Notes tab follows the part playing.
  // The bookmark button is on while a bookmark is near the playing moment (a press then
  // removes it). Changes the button only when that changes.
  renderBookmarkButton() {
    if (!this.notes || !this.notesReady) return;
    const here = !!this.notes.bookmarkNear(this.video.currentTime);
    if (here === this.bookmarkHere) return;
    this.bookmarkHere = here;
    const b = this.$('.bmbtn');
    setPressed(b, here);
    b.innerHTML = svg(here ? 'bookmarkOn' : 'bookmark');
    b.dataset.tip = tr(here ? 'removeBookmarkKey' : 'bookmarkKey');
    this.menus.refresh();
  }

  renderFlagButton() {
    if (this.notes && this.notesReady) this.notes.renderFlagRow();
  }

  renderExtras() {
    const x = this.lesson.extras || {};
    const what = [x.polls && tr('extraPolls'), x.slides && tr('extraSlides'), x.audioDescription && tr('extraAudioDescription')].filter(Boolean);
    const box = this.$('.pextras');
    box.hidden = !what.length;
    if (what.length) box.querySelector('.msg').textContent = tr('extrasNotice', { what: what.join(tr('sepList')) });
  }

  bindPanelResize() {
    const handle = this.$('.presize');
    const setWidth = (w) => {
      this.prefs.panelw = w;
      this.app.style.setProperty('--panelw', w + 'px');
    };
    onDrag(this.d, handle, {
      start: (e) => {
        if (e.button !== 0) return null;
        handle.setPointerCapture(e.pointerId);
        return { rect: this.app.getBoundingClientRect(), from: this.prefs.panelw };
      },
      move: (e, st) => setWidth(Math.round(clamp(st.rect.right - e.clientX, 260, Math.min(640, st.rect.width * 0.6)))),
      done: () => this.savePrefs(),
      cancel: (st) => setWidth(st.from),
    });
  }

  // Keyboard zoom on the main picture (the primary slot), around its centre; 0 resets.
  zoomMain(factor) {
    const slot = this.root.querySelector('.views [data-slot=primary]');
    const elem = slot && (slot.tagName === 'VIDEO' ? slot : slot.querySelector('.rpages'));
    if (!elem) return;
    if (!factor) { this.zoom.reset(elem); return; }
    this.zoom.zoomAt(elem, factor, 0.5, 0.5);
  }

  // One message at a time. opts.later: an automatic message (opts.from names its source)
  // waits while another source's message is shown, so that it does not take away an action
  // the user may still want (such as "Start over"); it replaces one from its own source.
  // When the shown one closes, the newest waiting one follows if opts.valid() still holds.
  toast(msg, action, fn, opts) {
    const elem = this.$('.toast');
    const o = opts || {};
    if (o.later && !elem.hidden && this.toastFrom !== o.from) { this.toastNext = [msg, action, fn, o]; return; }
    this.toastNext = null;
    this.toastFrom = o.from || null;
    elem.querySelector('.msg').textContent = msg;
    const btn = elem.querySelector('.act');
    btn.hidden = !action;
    btn.textContent = action || '';
    const close = () => {
      elem.hidden = true;
      this.toastFrom = null;
      const next = this.toastNext;
      this.toastNext = null;
      if (next && !this.destroyed && (!next[3].valid || next[3].valid())) this.toast(next[0], next[1], next[2], { from: next[3].from });
    };
    btn.onclick = guard((ev) => { close(); if (fn) fn(ev); });
    elem.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(close, 8000);
  }

  showError(title, text, actions) {
    const box = this.$('.error');
    box.querySelector('h2').textContent = title;
    box.querySelector('p').textContent = text;
    const wrap = box.querySelector('.actions');
    wrap.textContent = '';
    for (const [label, fn, primary] of actions) {
      const b = document.createElement('button');
      b.textContent = label;
      b.className = primary ? 'pbtn primary' : 'pbtn';
      b.addEventListener('click', fn);
      wrap.appendChild(b);
    }
    box.hidden = false;
    wrap.firstChild.focus({ preventScroll: true });
    this.wake();
  }

  hideError() { this.$('.error').hidden = true; this.playbackFailed = false; }

  destroy() {
    if (this.destroyed) return;
    this.savePosition();
    this.destroyed = true;
    this.d.dispose();
  }
}
