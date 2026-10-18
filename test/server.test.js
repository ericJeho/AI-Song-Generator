// End-to-end tests for server.js against local stand-ins for the ElevenLabs,
// MiniMax and Claude APIs. Run with: npm test

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FAKE_MP3 = Buffer.from('ID3-fake-mp3-bytes');
const calls = { elevenlabs: [], minimax: [], claude: [] };
const children = [];
let upstream, tmpRoot;

const UPSTREAM = 'http://127.0.0.1:18100';
const SECURE = 18101; // ElevenLabs, sign-in required, invite code, 3 songs a day, lyrics helper
const BADKEY = 18102; // ElevenLabs with a rejected key, sign-in off
const DEMO = 18103; // no keys, sign-in off, 5 requests an hour
const MINIMAX = 18104; // MiniMax, sign-in off

function fakeUpstream(req, res) {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    if (req.url.startsWith('/v1/music_generation')) {
      calls.minimax.push({ auth: req.headers.authorization, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: { audio: FAKE_MP3.toString('hex'), status: 2 }, base_resp: { status_code: 0, status_msg: 'success' } }));
    }
    if (req.url.startsWith('/v1/music')) {
      calls.elevenlabs.push({ url: req.url, key: req.headers['xi-api-key'], body });
      if (req.headers['xi-api-key'] === 'bad-key') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end('{"detail":"invalid api key"}');
      }
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      return res.end(FAKE_MP3);
    }
    if (req.url.startsWith('/v1/messages')) {
      calls.claude.push({ key: req.headers['x-api-key'], beta: req.headers['anthropic-beta'], body });
      const refuse = JSON.stringify(body).includes('REFUSE');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        id: 'msg_test', type: 'message', role: 'assistant', model: body.model,
        content: refuse ? [] : [{ type: 'text', text: '[Verse 1]\nStreetlights hum\n\n[Chorus]\nHold on' }],
        stop_reason: refuse ? 'refusal' : 'end_turn', stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 10 }
      }));
    }
    res.writeHead(404);
    res.end();
  });
}

function startServer(port, env) {
  const dataDir = fs.mkdtempSync(path.join(tmpRoot, 'data-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, PORT: String(port), DATA_DIR: dataDir, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  children.push(child);
  return new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { if (String(d).includes('running at')) resolve(); });
    child.on('exit', (code) => reject(new Error('server exited with ' + code)));
  });
}

async function call(port, method, urlPath, body, cookie) {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const setCookie = res.headers.get('set-cookie');
  return { status: res.status, body: await res.json().catch(() => null), cookie: setCookie && setCookie.split(';')[0] };
}

const SONG = { prompt: 'A late-night drive through Nairobi', genres: ['Afrobeats', 'R&B'], mood: 'Bittersweet', instruments: ['808s'], lyricMode: 'auto', voice: 'Female', tempo: 104, length: 120 };

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-test-'));
  upstream = http.createServer(fakeUpstream);
  await new Promise((r) => upstream.listen(18100, r));
  await Promise.all([
    startServer(SECURE, {
      ELEVENLABS_API_KEY: 'good-key', ELEVENLABS_BASE_URL: UPSTREAM,
      ANTHROPIC_API_KEY: 'claude-key', ANTHROPIC_BASE_URL: UPSTREAM,
      SIGNUP_CODE: 'letmein', DAILY_SONGS_PER_USER: '3', RATE_LIMIT_PER_HOUR: '50'
    }),
    startServer(BADKEY, { ELEVENLABS_API_KEY: 'bad-key', ELEVENLABS_BASE_URL: UPSTREAM, REQUIRE_LOGIN: 'false' }),
    startServer(DEMO, { REQUIRE_LOGIN: 'false', RATE_LIMIT_PER_HOUR: '5' }),
    startServer(MINIMAX, { MINIMAX_API_KEY: 'mm-key', MINIMAX_BASE_URL: UPSTREAM, REQUIRE_LOGIN: 'false' })
  ]);
});

after(() => {
  children.forEach((c) => c.kill());
  upstream.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------- Accounts ----------

test('health reports what the server supports', async () => {
  const { body } = await call(SECURE, 'GET', '/api/health');
  assert.deepEqual(body, { ok: true, provider: 'elevenlabs', versionsPerRequest: 2, requireLogin: true, signupCodeRequired: true, lyricsHelper: true });
});

test('generating requires sign-in when it is turned on', async () => {
  const res = await call(SECURE, 'POST', '/api/generate', SONG);
  assert.equal(res.status, 401);
});

test('sign-up checks the invite code, email and password', async () => {
  assert.equal((await call(SECURE, 'POST', '/api/signup', { email: 'a@b.co', password: 'longenough', inviteCode: 'wrong' })).status, 403);
  assert.equal((await call(SECURE, 'POST', '/api/signup', { email: 'not-an-email', password: 'longenough', inviteCode: 'letmein' })).status, 400);
  assert.equal((await call(SECURE, 'POST', '/api/signup', { email: 'a@b.co', password: 'short', inviteCode: 'letmein' })).status, 400);
});

test('sign-up, sign-in, session and sign-out work', async () => {
  const up = await call(SECURE, 'POST', '/api/signup', { email: 'Ana@Example.com', password: 'correct horse', inviteCode: 'letmein' });
  assert.equal(up.status, 200);
  assert.equal(up.body.user.email, 'ana@example.com');
  assert.match(up.cookie, /^cadence_session=/);

  assert.equal((await call(SECURE, 'POST', '/api/signup', { email: 'ana@example.com', password: 'correct horse', inviteCode: 'letmein' })).status, 409);
  assert.equal((await call(SECURE, 'POST', '/api/login', { email: 'ana@example.com', password: 'wrong password' })).status, 401);

  const login = await call(SECURE, 'POST', '/api/login', { email: 'ANA@example.com', password: 'correct horse' });
  assert.equal(login.status, 200);
  const me = await call(SECURE, 'GET', '/api/me', null, login.cookie);
  assert.equal(me.body.user.email, 'ana@example.com');
  assert.equal(me.body.user.songsLeftToday, 3);

  // A tampered cookie is not accepted.
  const forged = login.cookie.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
  assert.equal((await call(SECURE, 'GET', '/api/me', null, forged)).body.user, null);

  const out = await call(SECURE, 'POST', '/api/logout', {}, login.cookie);
  assert.match(out.cookie, /^cadence_session=$/);
});

test('POST endpoints only accept JSON (blocks cross-site form posts)', async () => {
  const res = await fetch(`http://127.0.0.1:${SECURE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(res.status, 415);
});

// ---------- Songs ----------

test('ElevenLabs: generates songs, serves audio, and counts the daily limit', async () => {
  const { cookie } = await call(SECURE, 'POST', '/api/signup', { email: 'limit@example.com', password: 'password123', inviteCode: 'letmein' });
  calls.elevenlabs.length = 0;

  const first = await call(SECURE, 'POST', '/api/generate', SONG, cookie);
  assert.equal(first.status, 200);
  assert.equal(first.body.songs.length, 2);
  assert.equal(first.body.songs[0].title, 'Late-night Drive Nairobi');
  assert.equal(first.body.user.songsLeftToday, 1);

  const sent = calls.elevenlabs[0];
  assert.equal(sent.key, 'good-key');
  assert.equal(sent.url, '/v1/music?output_format=mp3_44100_128');
  assert.equal(sent.body.music_length_ms, 120000);
  assert.match(sent.body.prompt, /bittersweet afrobeats r&b song at 104 BPM/);

  const audio = await fetch(`http://127.0.0.1:${SECURE}${first.body.songs[0].audioUrl}`);
  assert.equal(audio.headers.get('content-type'), 'audio/mpeg');
  assert.deepEqual(Buffer.from(await audio.arrayBuffer()), FAKE_MP3);

  // Only 1 song left today, so the next request makes 1, then the limit is reached.
  const second = await call(SECURE, 'POST', '/api/generate', SONG, cookie);
  assert.equal(second.body.songs.length, 1);
  assert.equal(second.body.user.songsLeftToday, 0);
  assert.equal((await call(SECURE, 'POST', '/api/generate', SONG, cookie)).status, 429);
});

test('ElevenLabs: instrumental and custom lyrics reach the prompt; unknown options are dropped', async () => {
  calls.elevenlabs.length = 0;
  await call(BADKEY, 'POST', '/api/generate', { prompt: 'ocean at night', lyricMode: 'none', genres: ['Jazz', 'Not-a-genre'], tempo: 999 });
  const body = calls.elevenlabs[0].body;
  assert.equal(body.force_instrumental, true);
  assert.match(body.prompt, /^A jazz song at 180 BPM\./);

  calls.elevenlabs.length = 0;
  await call(BADKEY, 'POST', '/api/generate', { prompt: 'duet', lyricMode: 'custom', lyrics: '[Chorus]\nHold on', voice: 'Duet' });
  assert.match(calls.elevenlabs[0].body.prompt, /male and female vocal duet/);
  assert.match(calls.elevenlabs[0].body.prompt, /\[Chorus\]\nHold on/);
});

test('a rejected API key gives a clear error', async () => {
  const { status, body } = await call(BADKEY, 'POST', '/api/generate', { prompt: 'anything' });
  assert.equal(status, 502);
  assert.match(body.error, /key was rejected/);
});

test('MiniMax: sends style and lyrics separately and decodes the audio', async () => {
  calls.minimax.length = 0;
  const auto = await call(MINIMAX, 'POST', '/api/generate', SONG);
  assert.equal(auto.status, 200);
  const sent = calls.minimax[0];
  assert.equal(sent.auth, 'Bearer mm-key');
  assert.equal(sent.body.model, 'music-2.6');
  assert.equal(sent.body.lyrics_optimizer, true);
  assert.match(sent.body.prompt, /bittersweet, afrobeats, r&b, 104 BPM/);
  const audio = await fetch(`http://127.0.0.1:${MINIMAX}${auto.body.songs[0].audioUrl}`);
  assert.deepEqual(Buffer.from(await audio.arrayBuffer()), FAKE_MP3);

  calls.minimax.length = 0;
  await call(MINIMAX, 'POST', '/api/generate', { prompt: 'x song', lyricMode: 'custom', lyrics: '[Verse]\nMine' });
  assert.equal(calls.minimax[0].body.lyrics, '[Verse]\nMine');
  assert.equal(calls.minimax[0].body.lyrics_optimizer, undefined);
});

test('without a key, demo mode returns silent songs', async () => {
  const { status, body } = await call(DEMO, 'POST', '/api/generate', { prompt: 'rainy day' });
  assert.equal(status, 200);
  assert.equal(body.songs[0].audioUrl, null);
});

test('rejects bad requests before calling any API', async () => {
  assert.equal((await call(DEMO, 'POST', '/api/generate', {})).status, 400);
  assert.equal((await call(DEMO, 'POST', '/api/generate', { prompt: 'x', lyricMode: 'custom', lyrics: ' ' })).status, 400);
  const notJson = await fetch(`http://127.0.0.1:${DEMO}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope' });
  assert.equal(notJson.status, 400);
});

test('rate limit stops a visitor after the hourly allowance', async () => {
  let last;
  for (let i = 0; i < 6; i++) last = await call(DEMO, 'POST', '/api/generate', { prompt: 'limit test' });
  assert.equal(last.status, 429);
});

// ---------- Lyrics helper ----------

let writerCookie;
test('lyrics helper calls Claude and returns the draft', async () => {
  const { cookie } = await call(SECURE, 'POST', '/api/signup', { email: 'writer@example.com', password: 'password123', inviteCode: 'letmein' });
  calls.claude.length = 0;
  const res = await call(SECURE, 'POST', '/api/lyrics', { ...SONG, lyricMode: 'custom', lyrics: '' }, cookie);
  assert.equal(res.status, 200);
  assert.match(res.body.lyrics, /\[Chorus\]/);
  writerCookie = cookie;

  const sent = calls.claude[0];
  assert.equal(sent.key, 'claude-key');
  assert.equal(sent.body.model, 'claude-opus-5-5');
  assert.equal(sent.body.fallbacks, 'default');
  assert.match(sent.beta, /server-side-fallback-2026-07-01/);
  assert.match(sent.body.messages[0].content, /Song description: A late-night drive through Nairobi/);
});

test('lyrics helper reports a declined request clearly', async () => {
  const res = await call(SECURE, 'POST', '/api/lyrics', { prompt: 'REFUSE this', lyricMode: 'custom' }, writerCookie);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /declined/);
});

test('lyrics helper is off when no Claude key is set', async () => {
  assert.equal((await call(DEMO, 'POST', '/api/lyrics', { prompt: 'x' })).status, 404);
});

// ---------- Files ----------

test('does not serve files outside public/ and the audio folder', async () => {
  for (const p of ['/../server.js', '/audio/..%2F..%2Fserver.js', '/%2e%2e/package.json', '/audio/..%2Fusers.json', '/audio/%E0%A4%A']) {
    const res = await fetch(`http://127.0.0.1:${SECURE}${p}`);
    assert.equal(res.status, 404, p);
  }
});
