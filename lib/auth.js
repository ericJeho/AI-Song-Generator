// Accounts, sessions and per-user daily limits.
//
// Users live in <DATA_DIR>/users.json. Passwords are hashed with scrypt.
// Sessions are signed cookies (HMAC-SHA256), so the server keeps no session table;
// the signing secret is SESSION_SECRET, or a random one saved in <DATA_DIR>/session-secret.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SESSION_DAYS = 30;
const COOKIE = 'cadence_session';

function createAuth({ dataDir, sessionSecret, limits }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const usersFile = path.join(dataDir, 'users.json');
  const secret = sessionSecret || loadOrCreateSecret(path.join(dataDir, 'session-secret'));

  let users = {};
  if (fs.existsSync(usersFile)) users = JSON.parse(fs.readFileSync(usersFile, 'utf8'));

  // Write to a temp file then rename, so a crash never leaves a half-written file.
  function save() {
    const tmp = usersFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(users, null, 2));
    fs.renameSync(tmp, usersFile);
  }

  // ---------- Passwords ----------

  function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(password, salt, 64);
    return salt.toString('hex') + ':' + hash.toString('hex');
  }

  function checkPassword(password, stored) {
    const [saltHex, hashHex] = stored.split(':');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
    return crypto.timingSafeEqual(expected, actual);
  }

  // ---------- Sessions ----------

  function sign(data) {
    return crypto.createHmac('sha256', secret).update(data).digest('base64url');
  }

  function sessionCookie(userId, secure) {
    const payload = Buffer.from(JSON.stringify({ uid: userId, exp: Date.now() + SESSION_DAYS * 864e5 })).toString('base64url');
    return `${COOKIE}=${payload}.${sign(payload)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`;
  }

  function clearCookie() {
    return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  }

  function userFromRequest(req) {
    const match = (req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)'));
    if (!match) return null;
    const [payload, signature] = match[1].split('.');
    if (!payload || !signature) return null;
    const expected = Buffer.from(sign(payload));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
    try {
      const { uid, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (Date.now() > exp) return null;
      return Object.values(users).find((u) => u.id === uid) || null;
    } catch {
      return null;
    }
  }

  // ---------- Accounts ----------

  function fail(status, message) {
    return Object.assign(new Error(message), { status });
  }

  function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
  }

  function signup({ email, password, inviteCode }) {
    email = normalizeEmail(email);
    password = String(password || '');
    if (limits.signupCode && String(inviteCode || '').trim() !== limits.signupCode) throw fail(403, 'That invite code is not right.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) throw fail(400, 'Enter a valid email address.');
    if (password.length < 8 || password.length > 200) throw fail(400, 'Use a password of at least 8 characters.');
    if (users[email]) throw fail(409, 'An account with that email already exists. Sign in instead.');
    users[email] = { id: crypto.randomUUID(), email, passwordHash: hashPassword(password), createdAt: new Date().toISOString(), usage: {} };
    save();
    return users[email];
  }

  function login({ email, password }) {
    const user = users[normalizeEmail(email)];
    // Hash anyway when the user is unknown, so response time does not reveal which emails exist.
    const ok = user ? checkPassword(String(password || ''), user.passwordHash) : (hashPassword('x'), false);
    if (!ok) throw fail(401, 'Wrong email or password.');
    return user;
  }

  // ---------- Daily limits ----------

  function today() {
    return new Date().toISOString().slice(0, 10);
  }

  function usageToday(user) {
    if (!user.usage || user.usage.day !== today()) user.usage = { day: today(), songs: 0, lyrics: 0 };
    return user.usage;
  }

  function remaining(user, kind) {
    const limit = kind === 'songs' ? limits.songsPerDay : limits.lyricsPerDay;
    return Math.max(0, limit - usageToday(user)[kind]);
  }

  function charge(user, kind, count) {
    usageToday(user)[kind] += count;
    save();
  }

  function publicUser(user) {
    return {
      email: user.email,
      songsLeftToday: remaining(user, 'songs'),
      songsPerDay: limits.songsPerDay,
      lyricsLeftToday: remaining(user, 'lyrics')
    };
  }

  return { signup, login, userFromRequest, sessionCookie, clearCookie, remaining, charge, publicUser };
}

function loadOrCreateSecret(file) {
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

module.exports = { createAuth };
