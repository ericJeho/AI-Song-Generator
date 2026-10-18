// Cadence server: serves the web app from public/, handles accounts, and generates
// songs (and optional lyric drafts) while keeping every API key on the server.
//
// Requires Node 18+.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

loadDotEnv(path.join(__dirname, '.env'));

const { createAuth } = require('./lib/auth');

const PORT = Number(process.env.PORT) || 8000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const AUDIO_DIR = path.resolve(process.env.AUDIO_DIR || path.join(DATA_DIR, 'generated'));
const VERSIONS = clampInt(process.env.VERSIONS_PER_REQUEST, 1, 4, 2);
const RATE_LIMIT_PER_HOUR = clampInt(process.env.RATE_LIMIT_PER_HOUR, 1, 10000, 20);
const REQUIRE_LOGIN = process.env.REQUIRE_LOGIN !== 'false';

const provider = pickProvider();
const lyricsHelper = process.env.ANTHROPIC_API_KEY ? require('./providers/lyrics') : null;

const auth = createAuth({
  dataDir: DATA_DIR,
  sessionSecret: process.env.SESSION_SECRET,
  limits: {
    signupCode: (process.env.SIGNUP_CODE || '').trim() || null,
    songsPerDay: clampInt(process.env.DAILY_SONGS_PER_USER, 0, 100000, 10),
    lyricsPerDay: clampInt(process.env.DAILY_LYRICS_PER_USER, 0, 100000, 20)
  }
});

fs.mkdirSync(AUDIO_DIR, { recursive: true });

const GENRES = ['Pop', 'Hip-Hop', 'Afrobeats', 'Amapiano', 'R&B', 'Lo-fi', 'House', 'Rock', 'Jazz', 'Synthwave', 'Folk', 'Cinematic'];
const MOODS = ['Euphoric', 'Bittersweet', 'Chill', 'Melancholic', 'Dark', 'Romantic', 'Energetic', 'Dreamy'];
const INSTRUMENTS = ['Piano', 'Acoustic guitar', 'Electric guitar', '808s', 'Synth pads', 'Strings', 'Saxophone', 'Talking drum', 'Bass', 'Brass'];
const VOICES = ['Female', 'Male', 'Duet'];
const LYRIC_MODES = ['auto', 'custom', 'none'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

// ---------- Helpers ----------

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

// MUSIC_PROVIDER picks one explicitly; otherwise the first service with a key is used.
function pickProvider() {
  const choice = (process.env.MUSIC_PROVIDER || '').toLowerCase();
  if (choice === 'mock') return require('./providers/mock');
  if (choice === 'minimax' || (!choice && !process.env.ELEVENLABS_API_KEY && process.env.MINIMAX_API_KEY)) {
    if (!process.env.MINIMAX_API_KEY) throw new Error('MUSIC_PROVIDER=minimax needs MINIMAX_API_KEY');
    return require('./providers/minimax');
  }
  if (choice === 'elevenlabs' || process.env.ELEVENLABS_API_KEY) {
    if (!process.env.ELEVENLABS_API_KEY) throw new Error('MUSIC_PROVIDER=elevenlabs needs ELEVENLABS_API_KEY');
    return require('./providers/elevenlabs');
  }
  return require('./providers/mock');
}

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

function sendJson(res, status, body, headers) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

// POST bodies must be JSON. Browsers cannot send that cross-site without a CORS
// preflight this server never approves, which blocks forged requests (CSRF).
function readJsonBody(req, limitBytes) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
    return Promise.reject(fail(415, 'Send JSON with Content-Type: application/json'));
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(fail(413, 'Request body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(fail(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function clientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
}

// Simple in-memory sliding-window limits per key (client IP plus a bucket name).
const hits = new Map();
function rateLimited(key, max, windowMs) {
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
  const limited = recent.length >= max;
  if (!limited) recent.push(now);
  hits.set(key, recent);
  return limited;
}

function isHttps(req) {
  return req.headers['x-forwarded-proto'] === 'https' || Boolean(req.socket.encrypted);
}

// ---------- Request validation ----------

function pickList(value, allowed, max) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((v) => allowed.includes(v)))].slice(0, max);
}

function validate(body, { needLyrics = true } = {}) {
  const prompt = String(body.prompt || '').trim().slice(0, 300);
  if (!prompt) throw fail(400, 'Describe your song first.');
  const lyricMode = LYRIC_MODES.includes(body.lyricMode) ? body.lyricMode : 'auto';
  const lyrics = lyricMode === 'custom' ? String(body.lyrics || '').trim().slice(0, 3000) : '';
  if (needLyrics && lyricMode === 'custom' && !lyrics) throw fail(400, 'Add your lyrics, or pick another lyrics option.');
  return {
    prompt,
    genres: pickList(body.genres, GENRES, 3),
    mood: MOODS.includes(body.mood) ? body.mood : null,
    instruments: pickList(body.instruments, INSTRUMENTS, INSTRUMENTS.length),
    lyricMode,
    lyrics,
    voice: lyricMode === 'none' ? null : VOICES.includes(body.voice) ? body.voice : 'Female',
    tempo: clampInt(body.tempo, 60, 180, 104),
    length: clampInt(body.length, 30, 300, 180)
  };
}

const STOP = ['the', 'and', 'for', 'with', 'after', 'about', 'from', 'into', 'that', 'this', 'last', 'by', 'through', 'late'];
function titleFrom(prompt) {
  const words = prompt.replace(/[^A-Za-z\s'-]/g, ' ').split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.includes(w.toLowerCase())).slice(0, 3);
  if (!words.length) return 'Untitled';
  return words.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

function tagsFor(req) {
  const tags = [];
  if (req.genres.length) tags.push(req.genres.join(' · '));
  if (req.mood) tags.push(req.mood);
  tags.push(req.tempo + ' BPM');
  if (req.lyricMode === 'none') tags.push('Instrumental');
  return tags.join(' · ');
}

// ---------- Handlers ----------

// Returns the signed-in user, or null when sign-in is turned off. Throws 401 otherwise.
function requireUser(req) {
  const user = auth.userFromRequest(req);
  if (!user && REQUIRE_LOGIN) throw fail(401, 'Sign in to continue.');
  return user;
}

async function handleSignup(req, res) {
  if (rateLimited('auth:' + clientIp(req), 10, 15 * 60e3)) throw fail(429, 'Too many attempts. Wait a few minutes.');
  const user = auth.signup(await readJsonBody(req, 4 * 1024));
  sendJson(res, 200, { user: auth.publicUser(user) }, { 'Set-Cookie': auth.sessionCookie(user.id, isHttps(req)) });
}

async function handleLogin(req, res) {
  if (rateLimited('auth:' + clientIp(req), 10, 15 * 60e3)) throw fail(429, 'Too many attempts. Wait a few minutes.');
  const user = auth.login(await readJsonBody(req, 4 * 1024));
  sendJson(res, 200, { user: auth.publicUser(user) }, { 'Set-Cookie': auth.sessionCookie(user.id, isHttps(req)) });
}

async function handleGenerate(req, res) {
  const user = requireUser(req);
  if (rateLimited('gen:' + clientIp(req), RATE_LIMIT_PER_HOUR, 3600e3)) throw fail(429, 'Too many songs this hour. Try again later.');
  const request = validate(await readJsonBody(req, 16 * 1024));

  const allowed = user ? Math.min(VERSIONS, auth.remaining(user, 'songs')) : VERSIONS;
  if (allowed < 1) throw fail(429, 'You have used today’s songs. Come back tomorrow.');

  const base = titleFrom(request.prompt);
  const labels = ['', ' (Alt Take)', ' (Take 3)', ' (Take 4)'];
  const results = await Promise.allSettled(Array.from({ length: allowed }, async (_, k) => {
    const { audio, extension } = await provider.generate(request);
    let audioUrl = null;
    if (audio) {
      const file = crypto.randomUUID() + (extension || '.mp3');
      await fs.promises.writeFile(path.join(AUDIO_DIR, file), audio);
      audioUrl = '/audio/' + file;
    }
    return { title: base + labels[k], tags: tagsFor(request), duration: request.length, audioUrl };
  }));

  const songs = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  if (!songs.length) {
    const err = results[0].reason;
    console.error('Generation failed:', err);
    return sendJson(res, 502, { error: err.publicMessage || 'The music service failed to create a song. Try again.' });
  }
  // Only songs that were actually made count toward the daily limit.
  if (user && provider.name !== 'mock') auth.charge(user, 'songs', songs.length);
  sendJson(res, 200, { songs, user: user ? auth.publicUser(user) : null });
}

async function handleLyrics(req, res) {
  if (!lyricsHelper) throw fail(404, 'The lyrics helper is not set up on this server.');
  const user = requireUser(req);
  if (rateLimited('lyrics:' + clientIp(req), RATE_LIMIT_PER_HOUR * 2, 3600e3)) throw fail(429, 'Too many drafts this hour. Try again later.');
  if (user && auth.remaining(user, 'lyrics') < 1) throw fail(429, 'You have used today’s lyric drafts. Come back tomorrow.');
  const request = validate(await readJsonBody(req, 16 * 1024), { needLyrics: false });
  if (request.lyricMode === 'none') request.voice = 'Female';
  try {
    const lyrics = await lyricsHelper.draftLyrics(request);
    if (user) auth.charge(user, 'lyrics', 1);
    sendJson(res, 200, { lyrics, user: user ? auth.publicUser(user) : null });
  } catch (err) {
    console.error('Lyrics failed:', err);
    sendJson(res, err.status === 400 ? 400 : 502, { error: err.publicMessage || 'The lyrics helper failed. Try again.' });
  }
}

function serveFile(res, filePath, extraHeaders) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return sendJson(res, 404, { error: 'Not found' });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Content-Length': stat.size,
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

// Resolve a URL path inside a root directory, refusing anything that escapes it.
function safeJoin(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const resolved = path.resolve(root, '.' + path.posix.normalize('/' + decoded));
  return resolved.startsWith(root + path.sep) || resolved === root ? resolved : null;
}

const routes = {
  'GET /api/health': (req, res) => sendJson(res, 200, {
    ok: true,
    provider: provider.name,
    versionsPerRequest: VERSIONS,
    requireLogin: REQUIRE_LOGIN,
    signupCodeRequired: Boolean((process.env.SIGNUP_CODE || '').trim()),
    lyricsHelper: Boolean(lyricsHelper)
  }),
  'GET /api/me': (req, res) => {
    const user = auth.userFromRequest(req);
    sendJson(res, 200, { user: user ? auth.publicUser(user) : null });
  },
  'POST /api/signup': handleSignup,
  'POST /api/login': handleLogin,
  'POST /api/logout': (req, res) => sendJson(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie() }),
  'POST /api/generate': handleGenerate,
  'POST /api/lyrics': handleLyrics
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    const route = routes[req.method + ' ' + url.pathname];
    if (route) return await route(req, res);
    if (url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found' });
    if (url.pathname.startsWith('/audio/') && req.method === 'GET') {
      const file = safeJoin(AUDIO_DIR, url.pathname.slice('/audio/'.length));
      return file ? serveFile(res, file, { 'Cache-Control': 'private, max-age=31536000, immutable' }) : sendJson(res, 404, { error: 'Not found' });
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      const file = safeJoin(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
      return file ? serveFile(res, file, { 'Cache-Control': 'no-cache' }) : sendJson(res, 404, { error: 'Not found' });
    }
    sendJson(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    if (!res.headersSent) sendJson(res, err.status || 500, { error: err.status ? err.message : 'Server error' });
    if (!err.status) console.error(err);
  }
});

server.listen(PORT, () => {
  console.log(`Cadence running at http://localhost:${PORT} (music: ${provider.name}, lyrics helper: ${lyricsHelper ? 'on' : 'off'}, sign-in: ${REQUIRE_LOGIN ? 'required' : 'off'})`);
  if (provider.name === 'mock') console.log('No music API key set: songs will be silent placeholders.');
  if (REQUIRE_LOGIN && !process.env.SIGNUP_CODE) console.log('Warning: anyone can create an account. Set SIGNUP_CODE to limit sign-ups.');
});
