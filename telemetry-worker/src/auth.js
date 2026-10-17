// Registration and signed batches (telemetry-worker/README.md, "Abuse").
//
// The player makes a random secret; its uid is SHA-256(secret). Once, it registers: it sends
// the secret with a proof of work, and the Worker keeps kv = HMAC-SHA-256(secret,
// "lp-ingest-v1") (never the secret). Each batch of events is then signed with kv:
//   sig = hex HMAC-SHA-256(kv, ts + "." + batch + "." + hex SHA-256(body))
// The proof of work makes each new identity cost the sender some seconds of computing:
//   SHA-256("lp-mint-v1|" + uid + "|" + day + "|" + nonce) starts with MINT_BITS zero bits.
// The player computes the same things synchronously (src/84-sha256.js).

export const INGEST_INFO = 'lp-ingest-v1';
export const MINT_PREFIX = 'lp-mint-v1|';
export const CLOCK_SKEW_MS = 600000;   // a batch's ts may differ this much from the Worker's clock
const enc = new TextEncoder();

// Days since 1970-01-01 (UTC).
export const epochDay = (ms) => Math.floor(ms / 86400000);

export function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(s) {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

function hmacKey(raw, use) {
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, [use]);
}

// The signing key of a secret (the secret's UTF-8 text is the HMAC key).
export async function deriveKv(secret) {
  return new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(enc.encode(secret), 'sign'), enc.encode(INGEST_INFO)));
}

// Leading zero bits of the mint hash for this uid, day and nonce (a decimal string).
export async function mintBits(uid, day, nonce) {
  const h = await sha256(enc.encode(MINT_PREFIX + uid + '|' + day + '|' + nonce));
  let bits = 0;
  for (const b of h) {
    if (b) return bits + Math.clz32(b) - 24;
    bits += 8;
  }
  return bits;
}

// kv: the stored key (D1 returns a BLOB as an array of numbers); sig: 64 hex digits.
export async function signatureOk(kv, ts, batch, body, sig) {
  const key = await hmacKey(new Uint8Array(kv), 'verify');
  const msg = ts + '.' + batch + '.' + hex(await sha256(enc.encode(body)));
  // Checked by WebCrypto in constant time.
  return crypto.subtle.verify('HMAC', key, fromHex(sig), enc.encode(msg));
}
