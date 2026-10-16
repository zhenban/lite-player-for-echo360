// Every happy-dom window a test makes, closed after each test however the test ended, and
// every change to a shared prototype undone. Imported by each test file that makes windows.
//
// Why: happy-dom's windows share their classes (a.Element === b.Element), so a patched
// prototype carries into every later window of the file; and a window left open (a test
// that failed before its own close) keeps the player's timers running and the test process
// alive. Together they once made a failing test grow to 22 GB (2026-10-16).
//
//   newWindow(options)          a happy-dom Window, closed after the test
//   patchProto(obj, name, val)  obj[name] = val until the test ends
//   same(a, b, message)         a === b. Use it, not assert.equal, for DOM objects: on a
//                               failure node:test serialises actual and expected, and a
//                               happy-dom node drags its whole window along (gigabytes).
import { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';

const open = new Set();
const undo = [];

export function newWindow(options) {
  const w = new Window(options);
  open.add(w);
  return w;
}

export function patchProto(obj, name, value) {
  const before = Object.getOwnPropertyDescriptor(obj, name);
  undo.push(() => { if (before) Object.defineProperty(obj, name, before); else delete obj[name]; });
  obj[name] = value;
}

export function same(a, b, message) {
  assert.ok(a === b, message || 'not the same object');
}

// happy-dom's abort() can wait on its own task queue for good: bounded.
export async function closeWindow(w) {
  if (!open.delete(w)) return;
  try { await Promise.race([w.happyDOM.abort(), new Promise((r) => setTimeout(r, 500))]); } catch (e) { /* closing anyway */ }
  try { w.close(); } catch (e) { /* already closed */ }
}

afterEach(async () => {
  while (undo.length) undo.pop()();
  for (const w of [...open]) await closeWindow(w);
});
