// ===================================================================================
// The camera alone while the screen view shows nothing: the slide analysis' empty-screen
// stretches (a black screen, "no signal") are planned ahead, and only long ones switch
// (EMPTY_SCREEN_MIN_SEC), so the layout does not flip back and forth. Until the analysis
// has found them nothing switches. A layout chosen by hand in a recording turns this off
// for that recording (remembered); each switch says so, with Undo. On by default; the
// switch is on the layout page of the settings menu.
//
// deps: { lesson, prefs (prefs.emptyCamera), savePrefs(), uniform() (empty-screen
//         stretches, [] until known), duration(), sources, primaryPos(), screenIndex()
//         (null until known), layout() (the chosen one), canSwitch() (two views, no PDF
//         in the picture area), showOnly(pos | null), toast(msg, action, fn, valid())
//         (valid: whether a message that had to wait is still true) }
// ===================================================================================

// The stretches to show the camera in: empty-screen stretches of at least minSec. One
// that ends before the recording does ends a sampling step early: the screen came back
// somewhere in that step, and a moment of black is better than missing the start.
function emptyScreenPlan(uniform, duration, minSec, step) {
  const out = [];
  for (const u of uniform || []) {
    if (u.end - u.start < minSec) continue;
    const end = u.end >= duration - 0.5 ? duration : u.end - step;
    if (end > u.start) out.push({ start: u.start, end });
  }
  return out;
}

const EMPTY_LAYOUT_KEY = 'layoutChosen';   // recordings whose layout was chosen by hand
const EMPTY_LAYOUT_KEEP = 300;             // newest kept (a small list in the settings store)

class EmptyScreenLayout {
  constructor(deps, disposer) {
    this.x = deps;
    this.d = disposer;
    this.on = false;          // showing the camera alone now
    this.known = null;        // the uniform list the plan was made from
    this.plan = [];
    this.cameraPos = -1;
    this.undos = 0;           // automatic switches undone by the user (usage data)
    this.chosen = (store.get(EMPTY_LAYOUT_KEY, []) || []).includes(deps.lesson.id);
    disposer.add(() => { if (this.on) this.x.showOnly(null); });
  }

  // The camera's position, or -1: the view that is not the analysed screen and can play
  // alone (it has sound).
  camera() {
    const x = this.x;
    const screen = x.screenIndex();
    if (screen == null) return -1;
    const screenPos = x.sources.findIndex((s) => s.index === screen);
    if (screenPos < 0) return -1;
    return x.sources.findIndex((s, i) => i !== screenPos && s.av);
  }

  // Whether the chosen layout shows the screen at all (not the camera alone already).
  screenShown(cameraPos) {
    return this.x.layout() !== 'single' || this.x.primaryPos() !== cameraPos;
  }

  // Called as playback moves (timeupdate, seeked) and when the stretches become known.
  tick(t) {
    const x = this.x;
    // Turned off, or the PDF took the picture area: back to the chosen layout.
    if (this.on && (!x.prefs.emptyCamera || !x.canSwitch())) { this.leave(false); return; }
    if (this.chosen) return;
    const u = x.uniform();
    if (u !== this.known) {
      this.known = u;
      this.plan = emptyScreenPlan(u, x.duration(), EMPTY_SCREEN_MIN_SEC, CHAPTER_STEP_SEC);
    }
    if (!x.prefs.emptyCamera || !x.canSwitch()) return;
    let inside = false;
    for (const s of this.plan) if (t >= s.start && t < s.end) { inside = true; break; }
    if (inside && !this.on) {
      const cam = this.camera();
      if (cam < 0 || !this.screenShown(cam)) return;
      this.enter(cam, true);
    } else if (!inside && this.on) {
      this.leave(true);
    }
  }

  enter(cam, say) {
    this.on = true;
    this.cameraPos = cam;
    this.x.showOnly(cam);
    if (say) this.x.toast(tr('emptyScreenCamera'), tr('undo'), () => { this.undos++; this.leave(false); this.choose(); }, () => this.on);
  }

  leave(say) {
    this.on = false;
    this.x.showOnly(null);
    // Undo keeps the camera alone, as if chosen by hand.
    if (say) this.x.toast(tr('emptyScreenBack'), tr('undo'), () => { this.undos++; this.choose(); this.enter(this.cameraPos, false); }, () => !this.on);
  }

  // The user arranged the views: the chosen arrangement takes over and this recording is
  // not switched again. Returns whether the camera was shown alone (it is not any more).
  manual() {
    const was = this.on;
    if (was) this.leave(false);
    this.choose();
    return was;
  }

  choose() {
    if (this.chosen) return;
    this.chosen = true;
    const id = this.x.lesson.id;
    const list = (store.get(EMPTY_LAYOUT_KEY, []) || []).filter((v) => v !== id);
    list.push(id);
    store.set(EMPTY_LAYOUT_KEY, list.slice(-EMPTY_LAYOUT_KEEP));
  }

  setEnabled(on) {
    this.x.prefs.emptyCamera = !!on;
    this.x.savePrefs();
  }
}
