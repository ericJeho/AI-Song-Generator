// End-to-end tests for server.js against a local stand-in for the ElevenLabs API.
// Run with: npm test

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FAKE_MP3 = Buffer.from('ID3-fake-mp3-bytes');
const upstreamCalls = [];
const children = [];
let upstream, audioDir;

function startServer(port, env) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, PORT: String(port), AUDIO_DIR: audioDir, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  children.push(child);
  return new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { if (String(d).includes('running at')) resolve(); });
    child.on('exit', (code) => reject(new Error('server exited with ' + code)));
  });
}

async function post(port, body) {
  const res = await fetch(`http://127.0.0.1:${port}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

before(async () => {
  audioDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-test-'));
  upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      upstreamCalls.push({ url: req.url, key: req.headers['xi-api-key'], body: JSON.parse(raw) });
      if (req.headers['xi-api-key'] === 'bad-key') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end('{"detail":"invalid api key"}');
      }
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      res.end(FAKE_MP3);
    });
  });
  await new Promise((r) => upstream.listen(18100, r));
  const upstreamEnv = { ELEVENLABS_BASE_URL: 'http://127.0.0.1:18100' };
  await Promise.all([
    startServer(18101, { ...upstreamEnv, ELEVENLABS_API_KEY: 'good-key', RATE_LIMIT_PER_HOUR: '5' }),
    startServer(18102, { ...upstreamEnv, ELEVENLABS_API_KEY: 'bad-key' }),
    startServer(18103, {})
  ]);
});

after(() => {
  children.forEach((c) => c.kill());
  upstream.close();
  fs.rmSync(audioDir, { recursive: true, force: true });
});

test('health reports the provider', async () => {
  const h = await (await fetch('http://127.0.0.1:18101/api/health')).json();
  assert.deepEqual(h, { ok: true, provider: 'elevenlabs', versionsPerRequest: 2 });
});

test('generates two songs and serves their audio', async () => {
  upstreamCalls.length = 0;
  const { status, body } = await post(18101, {
    prompt: 'A late-night drive through Nairobi',
    genres: ['Afrobeats', 'R&B'],
    mood: 'Bittersweet',
    instruments: ['808s'],
    lyricMode: 'auto',
    voice: 'Female',
    tempo: 104,
    length: 120
  });
  assert.equal(status, 200);
  assert.equal(body.length, 2);
  assert.equal(body[0].title, 'Late-night Drive Nairobi');
  assert.equal(body[1].title, 'Late-night Drive Nairobi (Alt Take)');

  assert.equal(upstreamCalls.length, 2);
  const call = upstreamCalls[0];
  assert.equal(call.key, 'good-key');
  assert.equal(call.url, '/v1/music?output_format=mp3_44100_128');
  assert.equal(call.body.model_id, 'music_v1');
  assert.equal(call.body.music_length_ms, 120000);
  assert.equal(call.body.force_instrumental, undefined);
  assert.match(call.body.prompt, /bittersweet afrobeats r&b song at 104 BPM/);
  assert.match(call.body.prompt, /female lead vocalist/);

  const audio = await fetch('http://127.0.0.1:18101' + body[0].audioUrl);
  assert.equal(audio.status, 200);
  assert.equal(audio.headers.get('content-type'), 'audio/mpeg');
  assert.deepEqual(Buffer.from(await audio.arrayBuffer()), FAKE_MP3);
});

test('instrumental and custom lyrics reach the prompt; unknown options are dropped', async () => {
  upstreamCalls.length = 0;
  await post(18101, { prompt: 'ocean at night', lyricMode: 'none', genres: ['Jazz', 'Not-a-genre'], tempo: 999 });
  assert.equal(upstreamCalls[0].body.force_instrumental, true);
  assert.match(upstreamCalls[0].body.prompt, /^A jazz song at 180 BPM\./);
  assert.match(upstreamCalls[0].body.prompt, /Instrumental only/);

  upstreamCalls.length = 0;
  await post(18101, { prompt: 'duet', lyricMode: 'custom', lyrics: '[Chorus]\nHold on', voice: 'Duet' });
  assert.match(upstreamCalls[0].body.prompt, /male and female vocal duet/);
  assert.match(upstreamCalls[0].body.prompt, /\[Chorus\]\nHold on/);
});

test('rejects bad requests before calling the API', async () => {
  upstreamCalls.length = 0;
  assert.equal((await post(18103, {})).status, 400);
  assert.equal((await post(18103, { prompt: 'x', lyricMode: 'custom', lyrics: ' ' })).status, 400);
  const notJson = await fetch('http://127.0.0.1:18103/api/generate', { method: 'POST', body: '{nope' });
  assert.equal(notJson.status, 400);
  assert.equal(upstreamCalls.length, 0);
});

test('does not serve files outside public/ and the audio folder', async () => {
  for (const p of ['/../server.js', '/audio/..%2F..%2Fserver.js', '/%2e%2e/package.json']) {
    const res = await fetch('http://127.0.0.1:18101' + p);
    assert.equal(res.status, 404, p);
  }
});

test('a rejected API key gives a clear error', async () => {
  const { status, body } = await post(18102, { prompt: 'anything' });
  assert.equal(status, 502);
  assert.match(body.error, /key was rejected/);
});

test('without a key, demo mode returns silent songs', async () => {
  const { status, body } = await post(18103, { prompt: 'rainy day' });
  assert.equal(status, 200);
  assert.equal(body[0].audioUrl, null);
});

test('rate limit stops a visitor after the hourly allowance', async () => {
  let last;
  for (let i = 0; i < 6; i++) last = await post(18101, { prompt: 'limit test' });
  assert.equal(last.status, 429);
});
