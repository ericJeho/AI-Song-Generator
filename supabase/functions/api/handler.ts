// The `api` Edge Function's routes. Everything that talks to Supabase goes through
// `Store`, so the routes can be tested with an in-memory store.
//
//   GET  /api/health    what this deployment supports
//   GET  /api/me        the signed-in user and today's allowance
//   POST /api/redeem    { code }  approve the account with an invite code
//   POST /api/generate  song request -> pending songs; audio is made in the background
//   POST /api/lyrics    song request -> { lyrics }

import { HttpError, PublicError, type MusicProvider, type SongRequest, tagsFor, titleFrom, validate } from './music.ts';
import type { LyricsHelper } from './lyrics.ts';

export type User = { id: string; email: string; inviteCode?: string };

export type SongRow = {
  id: string;
  user_id: string;
  title: string;
  tags: string;
  duration: number;
  status: 'pending' | 'ready' | 'failed';
  audio_path: string | null;
  error: string | null;
  request: SongRequest;
  created_at?: string;
};

export type Store = {
  userFromToken(token: string): Promise<User | null>;
  isApproved(userId: string): Promise<boolean>;
  approve(userId: string): Promise<void>;
  // Takes up to `want` units of today's allowance (negative gives units back); returns the change.
  consumeQuota(userId: string, kind: 'songs' | 'lyrics', want: number, limit: number): Promise<number>;
  usageToday(userId: string): Promise<{ songs: number; lyrics: number }>;
  insertSongs(rows: Omit<SongRow, 'id'>[]): Promise<SongRow[]>;
  updateSong(id: string, patch: Partial<SongRow>): Promise<void>;
  uploadAudio(path: string, bytes: Uint8Array): Promise<void>;
};

export type Config = {
  provider: MusicProvider;
  lyrics: LyricsHelper | null;
  signupCode: string | null;
  songsPerDay: number;
  lyricsPerDay: number;
  versions: number;
  allowedOrigin: string;
  // Keeps work running after the response is sent (EdgeRuntime.waitUntil on Supabase).
  background: (work: Promise<unknown>) => void;
};

export function createHandler(store: Store, config: Config) {
  const cors = {
    'Access-Control-Allow-Origin': config.allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    Vary: 'Origin',
  };

  function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  async function currentUser(req: Request): Promise<User | null> {
    const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    return token ? await store.userFromToken(token) : null;
  }

  async function requireUser(req: Request): Promise<User> {
    const user = await currentUser(req);
    if (!user) throw new HttpError(401, 'Sign in to continue.');
    return user;
  }

  // Approved once the invite code given at sign-up (or later via /redeem) matches.
  async function requireApproved(user: User): Promise<void> {
    if (!config.signupCode || (await store.isApproved(user.id))) return;
    if (user.inviteCode && user.inviteCode.trim() === config.signupCode) {
      await store.approve(user.id);
      return;
    }
    throw new HttpError(403, 'Your account needs a valid invite code.');
  }

  async function publicUser(user: User) {
    const used = await store.usageToday(user.id);
    return {
      email: user.email,
      songsLeftToday: Math.max(0, config.songsPerDay - used.songs),
      songsPerDay: config.songsPerDay,
      lyricsLeftToday: Math.max(0, config.lyricsPerDay - used.lyrics),
      approved: !config.signupCode || (await store.isApproved(user.id)) ||
        (user.inviteCode?.trim() === config.signupCode),
    };
  }

  async function readJson(req: Request) {
    if (!/^application\/json\b/i.test(req.headers.get('content-type') ?? '')) throw new HttpError(415, 'Send JSON.');
    const text = await req.text();
    if (text.length > 16 * 1024) throw new HttpError(413, 'Request body too large.');
    try {
      return JSON.parse(text || '{}');
    } catch {
      throw new HttpError(400, 'Invalid JSON.');
    }
  }

  async function makeSong(row: SongRow, request: SongRequest) {
    try {
      const bytes = await config.provider.generate(request);
      let audioPath: string | null = null;
      if (bytes) {
        audioPath = `${row.user_id}/${row.id}.mp3`;
        await store.uploadAudio(audioPath, bytes);
      }
      await store.updateSong(row.id, { status: 'ready', audio_path: audioPath });
    } catch (err) {
      console.error('Generation failed:', err);
      const message = err instanceof PublicError ? err.publicMessage : 'The music service failed to create this song. Try again.';
      await store.updateSong(row.id, { status: 'failed', error: message });
      if (config.provider.name !== 'mock') await store.consumeQuota(row.user_id, 'songs', -1, config.songsPerDay);
    }
  }

  const routes: Record<string, (req: Request) => Promise<Response>> = {
    'GET /health': async () =>
      json(200, {
        ok: true,
        provider: config.provider.name,
        versionsPerRequest: config.versions,
        requireLogin: true,
        signupCodeRequired: Boolean(config.signupCode),
        lyricsHelper: Boolean(config.lyrics),
      }),

    'GET /me': async (req) => {
      const user = await currentUser(req);
      return json(200, { user: user ? await publicUser(user) : null });
    },

    'POST /redeem': async (req) => {
      const user = await requireUser(req);
      const { code } = await readJson(req);
      if (config.signupCode && String(code ?? '').trim() !== config.signupCode) throw new HttpError(403, 'That invite code is not right.');
      await store.approve(user.id);
      return json(200, { user: await publicUser(user) });
    },

    'POST /generate': async (req) => {
      const user = await requireUser(req);
      await requireApproved(user);
      const request = validate(await readJson(req));
      const granted = config.provider.name === 'mock'
        ? config.versions
        : await store.consumeQuota(user.id, 'songs', config.versions, config.songsPerDay);
      if (granted < 1) throw new HttpError(429, 'You have used today’s songs. Come back tomorrow.');

      const base = titleFrom(request.prompt);
      const labels = ['', ' (Alt Take)', ' (Take 3)', ' (Take 4)'];
      const rows = await store.insertSongs(Array.from({ length: granted }, (_, k) => ({
        user_id: user.id,
        title: base + labels[k],
        tags: tagsFor(request) + (config.provider.name === 'mock' ? ' · Demo (silent)' : ''),
        duration: request.length,
        status: 'pending' as const,
        audio_path: null,
        error: null,
        request,
      })));
      config.background(Promise.all(rows.map((row) => makeSong(row, request))));
      return json(202, { songs: rows, user: await publicUser(user) });
    },

    'POST /lyrics': async (req) => {
      if (!config.lyrics) throw new HttpError(404, 'The lyrics helper is not set up.');
      const user = await requireUser(req);
      await requireApproved(user);
      const request = validate(await readJson(req), { needLyrics: false });
      if (request.lyricMode === 'none') request.voice = 'Female';
      if ((await store.consumeQuota(user.id, 'lyrics', 1, config.lyricsPerDay)) < 1) {
        throw new HttpError(429, 'You have used today’s lyric drafts. Come back tomorrow.');
      }
      try {
        const lyrics = await config.lyrics(request);
        return json(200, { lyrics, user: await publicUser(user) });
      } catch (err) {
        await store.consumeQuota(user.id, 'lyrics', -1, config.lyricsPerDay);
        throw err;
      }
    },
  };

  return async function handle(req: Request): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    // The function is served at /functions/v1/api/<route>; keep the last segment.
    const route = '/' + (new URL(req.url).pathname.split('/').filter(Boolean).pop() ?? '');
    const handler = routes[`${req.method} ${route}`];
    if (!handler) return json(404, { error: 'Not found' });
    try {
      return await handler(req);
    } catch (err) {
      if (err instanceof HttpError) return json(err.status, { error: err.message });
      if (err instanceof PublicError) return json(err.status, { error: err.publicMessage });
      console.error(err);
      return json(500, { error: 'Something went wrong. Try again.' });
    }
  };
}
