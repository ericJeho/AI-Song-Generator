// Cadence server: serves the web app from public/ and generates songs through
// a music-generation provider, keeping the API key on the server.
//
// No dependencies. Requires Node 18+ (uses the built-in fetch).

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

loadDotEnv(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT) || 8000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const AUDIO_DIR = path.resolve(process.env.AUDIO_DIR || path.join(__dirname, 'generated'));
const VERSIONS = clampInt(process.env.VERSIONS_PER_REQUEST, 1, 4, 2);
const RATE_LIMIT_PER_HOUR = clampInt(process.env.RATE_LIMIT_PER_HOUR, 1, 10000, 20);

const provider = process.env.ELEVENLABS_API_KEY
  ? require('./providers/elevenlabs')
  : require('./providers/mock');

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

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJsonBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

// Simple in-memory limit per client IP, to protect the API key's budget.
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 3600e3);
  if (recent.length >= RATE_LIMIT_PER_HOUR) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  return false;
}

// ---------- Request validation ----------

function pickList(value, allowed, max) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((v) => allowed.includes(v)))].slice(0, max);
}

function validate(body) {
  const prompt = String(body.prompt || '').trim().slice(0, 300);
  if (!prompt) throw Object.assign(new Error('Describe your song first.'), { status: 400 });
  const lyricMode = LYRIC_MODES.includes(body.lyricMode) ? body.lyricMode : 'auto';
  const lyrics = lyricMode === 'custom' ? String(body.lyrics || '').trim().slice(0, 3000) : '';
  if (lyricMode === 'custom' && !lyrics) throw Object.assign(new Error('Add your lyrics, or pick another lyrics option.'), { status: 400 });
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

async function handleGenerate(req, res) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  if (rateLimited(ip)) return sendJson(res, 429, { error: 'Too many songs this hour. Try again later.' });

  const request = validate(await readJsonBody(req, 16 * 1024));
  const base = titleFrom(request.prompt);
  const labels = ['', ' (Alt Take)', ' (Take 3)', ' (Take 4)'];

  const results = await Promise.allSettled(Array.from({ length: VERSIONS }, async (_, k) => {
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
    return sendJson(res, err.status === 400 ? 400 : 502, { error: err.publicMessage || 'The music service failed to create a song. Try again.' });
  }
  sendJson(res, 200, songs);
}

function serveFile(res, filePath, extraHeaders) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return sendJson(res, 404, { error: 'Not found' });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Content-Length': stat.size,
      ...extraHeaders
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

// Resolve a URL path inside a root directory, refusing anything that escapes it.
function safeJoin(root, urlPath) {
  const resolved = path.resolve(root, '.' + path.posix.normalize('/' + decodeURIComponent(urlPath)));
  return resolved.startsWith(root + path.sep) || resolved === root ? resolved : null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/health' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, provider: provider.name, versionsPerRequest: VERSIONS });
    }
    if (url.pathname === '/api/generate') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST' });
      return await handleGenerate(req, res);
    }
    if (url.pathname.startsWith('/audio/') && req.method === 'GET') {
      const file = safeJoin(AUDIO_DIR, url.pathname.slice('/audio/'.length));
      return file ? serveFile(res, file, { 'Cache-Control': 'public, max-age=31536000, immutable' }) : sendJson(res, 404, { error: 'Not found' });
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
  console.log(`Cadence running at http://localhost:${PORT} (provider: ${provider.name}, ${VERSIONS} version(s) per request)`);
  if (provider.name === 'mock') console.log('No ELEVENLABS_API_KEY set: songs will be silent placeholders.');
});
