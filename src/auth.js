const crypto = require('crypto');
const DEFAULT_SESSION_SECRET = 'dev-only-secret-change-me';
const DEFAULT_APP_PASSWORD = 'changeme';
function resolveSecrets(env = process.env) {
  const prod = env.NODE_ENV === 'production';
  const secret = env.SESSION_SECRET == null ? '' : String(env.SESSION_SECRET);
  const password = env.APP_PASSWORD == null ? '' : String(env.APP_PASSWORD);
  if (prod) {
    if (!secret.trim() || secret.trim() === DEFAULT_SESSION_SECRET) {
      throw new Error('SESSION_SECRET must be set to a non-default value in production');
    }
    if (!password.trim() || password.trim() === DEFAULT_APP_PASSWORD) {
      throw new Error('APP_PASSWORD must be set to a non-default value in production');
    }
    return { secret, password };
  }
  return { secret: secret || DEFAULT_SESSION_SECRET, password: password || DEFAULT_APP_PASSWORD };
}
const { secret: SECRET, password: PASSWORD } = resolveSecrets();
const COOKIE = 'crm_session'; const DAYS = 30;
const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
const h = (s) => crypto.createHash('sha256').update(String(s)).digest();
function checkPassword(p) { return crypto.timingSafeEqual(h(p), h(PASSWORD)); }
function makeToken() { const exp = String(Date.now() + DAYS * 864e5); return exp + '.' + sign(exp); }
function valid(tok) {
  if (!tok) return false; const [exp, sig] = tok.split('.');
  if (!exp || !sig || sig.length !== sign(exp).length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(sign(exp))) && Number(exp) > Date.now();
}
function cookies(req) { return Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=').map(decodeURIComponent)).filter((x) => x[0])); }
const attempts = new Map();
function rateLimited(ip) {
  const now = Date.now(); const a = (attempts.get(ip) || []).filter((t) => now - t < 15 * 60e3); attempts.set(ip, a);
  return a.length >= 10;
}
function noteFail(ip) { attempts.set(ip, [...(attempts.get(ip) || []), Date.now()]); }
function setSession(res, secure) {
  res.setHeader('Set-Cookie', `${COOKIE}=${makeToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DAYS * 86400}${secure ? '; Secure' : ''}`);
}
function clearSession(res) { res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`); }
function requireAuth(req, res, next) {
  if (valid(cookies(req)[COOKIE])) {
    // basic CSRF guard: state-changing requests must come from this site
    if (req.method !== 'GET' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return res.status(403).send('Bad origin');
    return next();
  }
  if (req.method === 'GET') return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  res.status(401).send('Login required');
}
module.exports = { checkPassword, setSession, clearSession, requireAuth, rateLimited, noteFail, resolveSecrets };
