// The synchronous SHA-256, HMAC and proof-of-work search (src/84-sha256.js) against node:crypto.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ctx = {};
vm.createContext(ctx);
vm.runInContext(readFileSync(new URL('../src/84-sha256.js', import.meta.url), 'utf8')
  + '\n;globalThis.m = { sha256Sync, hmacSha256Sync, bytesHex, mintSearch };', ctx);
const { sha256Sync, hmacSha256Sync, bytesHex, mintSearch } = ctx.m;
const u8 = (s) => new Uint8Array(Buffer.from(s));
const nodeHex = (s) => createHash('sha256').update(s).digest('hex');
const zeroBits = (hex) => { let n = 0; for (const c of hex) { const v = parseInt(c, 16); if (v) return n + Math.clz32(v) - 28; n += 4; } return n; };

test('SHA-256 matches node:crypto across block boundaries', () => {
  assert.equal(bytesHex(sha256Sync(u8('abc'))), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  for (let len = 0; len <= 200; len++) {
    const s = Buffer.alloc(len, 0).map((_, i) => (i * 131 + len) & 0xff);
    assert.equal(bytesHex(sha256Sync(new Uint8Array(s))), nodeHex(s), 'length ' + len);
  }
});

test('HMAC-SHA-256 matches node:crypto (short, block-sized and long keys)', () => {
  for (const key of ['', 'k', 'x'.repeat(64), 'y'.repeat(65), 'z'.repeat(200)]) {
    for (const msg of ['', 'lp-ingest-v1', 'm'.repeat(300)]) {
      assert.equal(bytesHex(hmacSha256Sync(u8(key), u8(msg))), createHmac('sha256', key).update(msg).digest('hex'), key.length + '/' + msg.length);
    }
  }
});

test('mintSearch finds the first nonce with enough zero bits, for any prefix length', () => {
  const uid = 'a'.repeat(64);
  for (const prefix of ['lp-mint-v1|' + uid + '|20378|', 'p|', 'q'.repeat(60), 'r'.repeat(128)]) {
    const bits = 10;
    const found = mintSearch(prefix, bits, 0, 1 << 16);
    assert.ok(found >= 0, prefix.length + ': found');
    assert.ok(zeroBits(nodeHex(prefix + found)) >= bits, prefix.length + ': proof holds');
    for (let n = 0; n < found; n++) assert.ok(zeroBits(nodeHex(prefix + n)) < bits, prefix.length + ': first');
    // Searching on from the found nonce finds it again; a range before it finds nothing.
    assert.equal(mintSearch(prefix, bits, found, 1), found);
    assert.equal(mintSearch(prefix, bits, 0, found), -1);
  }
  // Large nonces (many digits) hash as their decimal text.
  const big = 123456789012;
  const at = mintSearch('p|', 1, big, 64);
  assert.ok(at >= big && zeroBits(nodeHex('p|' + at)) >= 1);
});
