// Tests for the api function, run with: deno test --allow-net --allow-env supabase/functions/api
// Uses an in-memory store and local stand-ins for the music and Claude APIs.

import { assert, assertEquals, assertMatch } from 'jsr:@std/assert@1';
import { createHandler, type SongRow, type Store } from './handler.ts';
import { elevenLabs, miniMax, demo, type MusicProvider, validate } from './music.ts';
import { claudeLyrics } from './lyrics.ts';

const FAKE_MP3 = new TextEncoder().encode('ID3-fake-mp3-bytes');
const SONG = { prompt: 'A late-night drive through Nairobi', genres: ['Afrobeats', 'R&B'], mood: 'Bittersweet', instruments: ['808s'], lyricMode: 'auto', voice: 'Female', tempo: 104, length: 120 };

// ---------- In-memory store ----------

function memoryStore() {
  const users: Record<string, { id: string; email: string; inviteCode?: string }> = {
    'token-ana': { id: 'u-ana', email: 'ana@example.com', inviteCode: 'letmein' },
    'token-bo': { id: 'u-bo', email: 'bo@example.com' },
  };
  const approved = new Set<string>();
  const usage: Record<string, { songs: number; lyrics: number }> = {};
  const songs: Record<string, SongRow> = {};
  const files: Record<string, Uint8Array> = {};
  let n = 0;
  const store: Store = {
    userFromToken: async (t) => users[t] ?? null,
    isApproved: async (id) => approved.has(id),
    approve: async (id) => void approved.add(id),
    consumeQuota: async (id, kind, want, limit) => {
      const u = (usage[id] ??= { songs: 0, lyrics: 0 });
      const granted = want < 0 ? -Math.min(-want, u[kind]) : Math.max(0, Math.min(want, limit - u[kind]));
      u[kind] += granted;
      return granted;
    },
    usageToday: async (id) => usage[id] ?? { songs: 0, lyrics: 0 },
    insertSongs: async (rows) => rows.map((r) => ({ ...(songs[`s${++n}`] = { ...r, id: `s${n}` }) })),
    updateSong: async (id, patch) => void Object.assign(songs[id], patch),
    uploadAudio: async (path, bytes) => void (files[path] = bytes),
  };
  return { store, songs, files, usage, approved };
}

function setup(provider: MusicProvider, extra: Record<string, unknown> = {}) {
  const mem = memoryStore();
  const pending: Promise<unknown>[] = [];
  const handle = createHandler(mem.store, {
    provider,
    lyrics: async () => '[Verse 1]\nStreetlights hum\n\n[Chorus]\nHold on',
    signupCode: 'letmein',
    songsPerDay: 3,
    lyricsPerDay: 2,
    versions: 2,
    allowedOrigin: '*',
    background: (w) => void pending.push(w),
    ...extra,
  });
  const call = async (method: string, path: string, body?: unknown, token?: string, contentType = 'application/json') => {
    const res = await handle(new Request(`https://x.supabase.co/functions/v1/api${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': contentType } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    }));
    return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
  };
  return { ...mem, call, settle: () => Promise.all(pending.splice(0)) };
}

const okProvider = (calls: unknown[] = []): MusicProvider => ({
  name: 'test',
  generate: async (req) => (calls.push(req), FAKE_MP3),
});

// ---------- Routes ----------

Deno.test('health reports what this deployment supports', async () => {
  const { call } = setup(okProvider());
  const res = await call('GET', '/health');
  assertEquals(res.body, { ok: true, provider: 'test', versionsPerRequest: 2, requireLogin: true, signupCodeRequired: true, lyricsHelper: true });
  assertEquals(res.headers.get('access-control-allow-origin'), '*');
});

Deno.test('CORS preflight is answered', async () => {
  const { call } = setup(okProvider());
  assertEquals((await call('OPTIONS', '/generate')).status, 204);
});

Deno.test('generating needs sign-in, an invite code, and JSON', async () => {
  const { call, approved } = setup(okProvider());
  assertEquals((await call('POST', '/generate', SONG)).status, 401);
  assertEquals((await call('POST', '/generate', SONG, 'token-bo')).status, 403);
  assertEquals((await call('POST', '/redeem', { code: 'wrong' }, 'token-bo')).status, 403);
  assertEquals((await call('POST', '/redeem', { code: 'letmein' }, 'token-bo')).status, 200);
  assert(approved.has('u-bo'));
  assertEquals((await call('POST', '/generate', '{}', 'token-bo', 'text/plain')).status, 415);
});

Deno.test('the invite code given at sign-up approves the account', async () => {
  const { call, approved } = setup(okProvider());
  const me = await call('GET', '/me', undefined, 'token-ana');
  assertEquals(me.body.user.approved, true);
  assertEquals((await call('POST', '/generate', SONG, 'token-ana')).status, 202);
  assert(approved.has('u-ana'));
});

Deno.test('generate creates pending songs, makes audio in the background, and counts the limit', async () => {
  const calls: unknown[] = [];
  const { call, settle, songs, files } = setup(okProvider(calls));
  const first = await call('POST', '/generate', SONG, 'token-ana');
  assertEquals(first.status, 202);
  assertEquals(first.body.songs.map((s: SongRow) => [s.title, s.status]), [['Late-night Drive Nairobi', 'pending'], ['Late-night Drive Nairobi (Alt Take)', 'pending']]);
  assertEquals(first.body.user.songsLeftToday, 1);

  await settle();
  assertEquals(calls.length, 2);
  assertEquals(songs.s1.status, 'ready');
  assertEquals(songs.s1.audio_path, 'u-ana/s1.mp3');
  assertEquals(files['u-ana/s1.mp3'], FAKE_MP3);

  const second = await call('POST', '/generate', SONG, 'token-ana');
  assertEquals(second.body.songs.length, 1);
  assertEquals((await call('POST', '/generate', SONG, 'token-ana')).status, 429);
});

Deno.test('a failed song is marked failed and its allowance is given back', async () => {
  const failing: MusicProvider = { name: 'test', generate: () => new Promise((_, reject) => setTimeout(() => reject(new Error('boom')), 10)) };
  const { call, settle, songs, usage } = setup(failing);
  await call('POST', '/generate', SONG, 'token-ana');
  assertEquals(usage['u-ana'].songs, 2);
  await settle();
  assertEquals(songs.s1.status, 'failed');
  assertMatch(songs.s1.error!, /failed to create/);
  assertEquals(usage['u-ana'].songs, 0);
});

Deno.test('demo mode makes silent songs without using the allowance', async () => {
  const { call, settle, songs, usage } = setup(demo);
  const res = await call('POST', '/generate', SONG, 'token-ana');
  assertMatch(res.body.songs[0].tags, /Demo \(silent\)/);
  await settle();
  assertEquals(songs.s1.status, 'ready');
  assertEquals(songs.s1.audio_path, null);
  assertEquals(usage['u-ana'], undefined);
});

Deno.test('lyrics: returns the draft and enforces its own daily limit', async () => {
  const { call } = setup(okProvider());
  const res = await call('POST', '/lyrics', { ...SONG, lyricMode: 'custom' }, 'token-ana');
  assertEquals(res.status, 200);
  assertMatch(res.body.lyrics, /\[Chorus\]/);
  await call('POST', '/lyrics', SONG, 'token-ana');
  assertEquals((await call('POST', '/lyrics', SONG, 'token-ana')).status, 429);
});

Deno.test('lyrics: off when no Claude key is set', async () => {
  const { call } = setup(okProvider(), { lyrics: null });
  assertEquals((await call('POST', '/lyrics', SONG, 'token-ana')).status, 404);
});

Deno.test('validation keeps any typed genre, cleans it, and clamps numbers', () => {
  const v = validate({ prompt: ' x ', genres: ['jazz', 'Bongo  Flava', 'JAZZ', 'sea shanty'], tempo: 999, length: 5, lyricMode: 'weird' });
  assertEquals([v.genres, v.tempo, v.length, v.lyricMode], [['Jazz', 'Bongo Flava', 'sea shanty'], 180, 30, 'auto']);
  const dirty = validate({ prompt: 'x', genres: ['<b>drill</b>', 'x'.repeat(80), 42, '   ', null] });
  assertEquals(dirty.genres, ['bdrill/b', 'x'.repeat(40)]);
});

// ---------- Providers against local stand-ins ----------

async function withServer(handler: (req: Request) => Response | Promise<Response>, fn: (url: string) => Promise<void>) {
  const server = Deno.serve({ port: 0, onListen() {} }, handler);
  try {
    await fn(`http://127.0.0.1:${server.addr.port}`);
  } finally {
    await server.shutdown();
  }
}

Deno.test('ElevenLabs: sends the right request and returns the audio', async () => {
  let seen: { url: string; key: string | null; body: Record<string, unknown> } | null = null;
  await withServer(async (req) => {
    seen = { url: new URL(req.url).pathname + new URL(req.url).search, key: req.headers.get('xi-api-key'), body: await req.json() };
    return new Response(FAKE_MP3, { headers: { 'Content-Type': 'audio/mpeg' } });
  }, async (url) => {
    const bytes = await elevenLabs('el-key', url).generate(validate({ ...SONG, lyricMode: 'none' }));
    assertEquals(bytes, FAKE_MP3);
  });
  assertEquals(seen!.url, '/v1/music?output_format=mp3_44100_128');
  assertEquals(seen!.key, 'el-key');
  assertEquals(seen!.body.force_instrumental, true);
  assertEquals(seen!.body.music_length_ms, 120000);
  assertMatch(String(seen!.body.prompt), /bittersweet afrobeats r&b song at 104 BPM/);
});

Deno.test('ElevenLabs: a rejected key becomes a clear message', async () => {
  await withServer(() => new Response('{"detail":"bad"}', { status: 401 }), async (url) => {
    const err = await elevenLabs('bad', url).generate(validate(SONG)).catch((e) => e);
    assertEquals(err.publicMessage, 'The music API key was rejected.');
  });
});

Deno.test('MiniMax: sends style and lyrics separately and decodes hex audio', async () => {
  let body: Record<string, unknown> = {};
  await withServer(async (req) => {
    body = await req.json();
    const hex = Array.from(FAKE_MP3, (b) => b.toString(16).padStart(2, '0')).join('');
    return Response.json({ data: { audio: hex, status: 2 }, base_resp: { status_code: 0, status_msg: 'success' } });
  }, async (url) => {
    assertEquals(await miniMax('mm-key', url).generate(validate(SONG)), FAKE_MP3);
  });
  assertEquals(body.model, 'music-2.6');
  assertEquals(body.lyrics_optimizer, true);
  assertMatch(String(body.prompt), /bittersweet, afrobeats, r&b, 104 BPM/);
});

Deno.test('Claude lyrics: uses claude-opus-5-5 with refusal fallback, and reports refusals', async () => {
  const seen: { beta: string | null; body: Record<string, unknown> }[] = [];
  await withServer(async (req) => {
    const body = await req.json();
    seen.push({ beta: req.headers.get('anthropic-beta'), body });
    const refuse = JSON.stringify(body).includes('REFUSE');
    return Response.json({
      id: 'msg', type: 'message', role: 'assistant', model: body.model,
      content: refuse ? [] : [{ type: 'text', text: '[Verse 1]\nLine\n\n[Chorus]\nHook' }],
      stop_reason: refuse ? 'refusal' : 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
    });
  }, async (url) => {
    const draft = claudeLyrics('claude-key', url);
    assertMatch(await draft(validate(SONG)), /\[Chorus\]/);
    const err = await draft(validate({ ...SONG, prompt: 'REFUSE this' })).catch((e) => e);
    assertMatch(err.publicMessage, /declined/);
  });
  assertEquals(seen[0].body.model, 'claude-opus-5-5');
  assertEquals(seen[0].body.fallbacks, 'default');
  assertMatch(seen[0].beta!, /server-side-fallback-2026-07-01/);
  assertMatch(String((seen[0].body.messages as { content: string }[])[0].content), /Song description: A late-night drive/);
});
