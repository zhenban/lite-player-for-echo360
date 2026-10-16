// Who may see the dashboard. Cloudflare Access sits in front of this Worker and signs in
// only the owner; this file checks again on every request, so a missing or mistaken Access
// setup leaves the dashboard closed, not open:
//   - the configuration must be complete and well formed, otherwise nothing is served (503);
//   - the request must carry an Access token (the Cf-Access-Jwt-Assertion header, or the
//     CF_Authorization cookie) signed by the team's Access keys (RS256), issued by the team
//     domain, for this application (aud), and not expired;
//   - the token's email must be one of ALLOWED_EMAILS;
//   - when the runtime itself reports Access (ctx.access), it must be for the same app.
// Anything else is refused (403) without saying which check failed.
import { createRemoteJWKSet, jwtVerify } from 'jose';

const TEAM = /^https:\/\/[a-z0-9][a-z0-9-]{0,62}\.cloudflareaccess\.com$/;
const AUD = /^[0-9a-f]{64}$/;
const EMAIL = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;
const UID = /^[0-9a-f]{64}$/;

// The configuration from the Worker's secrets, or null when anything is missing or malformed.
export function readConfig(env) {
  const team = typeof env.TEAM_DOMAIN === 'string' ? env.TEAM_DOMAIN.trim().replace(/\/+$/, '') : '';
  const aud = typeof env.POLICY_AUD === 'string' ? env.POLICY_AUD.trim().toLowerCase() : '';
  const emails = typeof env.ALLOWED_EMAILS === 'string'
    ? env.ALLOWED_EMAILS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    : [];
  if (!TEAM.test(team) || !AUD.test(aud) || !emails.length || !emails.every((e) => EMAIL.test(e))) return null;
  // The owner's own devices, for "exclude my devices" (optional; malformed entries ignored).
  const owners = typeof env.OWNER_UIDS === 'string'
    ? env.OWNER_UIDS.split(',').map((s) => s.trim().toLowerCase()).filter((s) => UID.test(s))
    : [];
  return { team, aud, emails, owners };
}

// One key set per team domain, kept while the isolate lives (jose caches and refreshes it).
const keySets = new Map();
function remoteKeys(team) {
  let set = keySets.get(team);
  if (!set) {
    set = createRemoteJWKSet(new URL(team + '/cdn-cgi/access/certs'));
    keySets.set(team, set);
  }
  return set;
}

function tokenOf(request) {
  const header = request.headers.get('cf-access-jwt-assertion');
  if (header) return header.trim();
  const cookie = request.headers.get('cookie') || '';
  const m = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(cookie);
  return m ? m[1].trim() : null;
}

// The signed-in owner's email, or null. `keys` replaces the remote key set in tests.
export async function authorize(request, config, ctx, keys) {
  if (!config) return null;
  if (ctx && ctx.access && ctx.access.aud !== undefined && String(ctx.access.aud).toLowerCase() !== config.aud) return null;
  const token = tokenOf(request);
  if (!token || token.length > 8192) return null;
  try {
    const { payload } = await jwtVerify(token, keys || remoteKeys(config.team), {
      issuer: config.team,
      audience: config.aud,
      algorithms: ['RS256'],
      requiredClaims: ['exp', 'iat'],
    });
    const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : '';
    return email && config.emails.includes(email) ? email : null;
  } catch {
    return null;
  }
}
