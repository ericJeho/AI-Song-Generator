// Supabase Edge Function entry point: wires the routes to the real database, storage and APIs.
//
// Secrets (set in the Supabase dashboard under Edge Functions > Secrets):
//   ELEVENLABS_API_KEY or MINIMAX_API_KEY   music (MUSIC_PROVIDER picks when both are set)
//   ANTHROPIC_API_KEY                       lyrics helper (optional)
//   SIGNUP_CODE                             invite code new accounts need (recommended)
//   DAILY_SONGS_PER_USER, DAILY_LYRICS_PER_USER, VERSIONS_PER_REQUEST, ALLOWED_ORIGIN (optional)
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.

import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { createHandler, type SongRow, type Store } from './handler.ts';
import { pickProvider } from './music.ts';
import { claudeLyrics } from './lyrics.ts';

const env = (name: string) => Deno.env.get(name) || undefined;
const int = (name: string, fallback: number) => {
  const n = parseInt(env(name) ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

const db = createClient(env('SUPABASE_URL')!, env('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function check<T>(result: { data: T; error: unknown }): T {
  if (result.error) throw result.error;
  return result.data;
}

const store: Store = {
  async userFromToken(token) {
    const { data, error } = await db.auth.getUser(token);
    if (error || !data.user) return null;
    return { id: data.user.id, email: data.user.email ?? '', inviteCode: data.user.user_metadata?.invite_code };
  },
  async isApproved(userId) {
    const row = check(await db.from('profiles').select('approved').eq('id', userId).maybeSingle());
    return Boolean(row?.approved);
  },
  async approve(userId) {
    check(await db.from('profiles').upsert({ id: userId, approved: true }));
  },
  async consumeQuota(userId, kind, want, limit) {
    return check(await db.rpc('consume_quota', { p_user: userId, p_kind: kind, p_want: want, p_limit: limit })) as number;
  },
  async usageToday(userId) {
    const today = new Date().toISOString().slice(0, 10);
    const row = check(await db.from('daily_usage').select('songs, lyrics').eq('user_id', userId).eq('day', today).maybeSingle());
    return { songs: row?.songs ?? 0, lyrics: row?.lyrics ?? 0 };
  },
  async insertSongs(rows) {
    return check(await db.from('songs').insert(rows).select()) as SongRow[];
  },
  async updateSong(id, patch) {
    check(await db.from('songs').update(patch).eq('id', id));
  },
  async uploadAudio(path, bytes) {
    check(await db.storage.from('songs').upload(path, bytes, { contentType: 'audio/mpeg', upsert: false }));
  },
};

const anthropicKey = env('ANTHROPIC_API_KEY');

const handle = createHandler(store, {
  provider: pickProvider(env),
  lyrics: anthropicKey ? claudeLyrics(anthropicKey, env('ANTHROPIC_BASE_URL'), env('LYRICS_MODEL')) : null,
  signupCode: env('SIGNUP_CODE')?.trim() || null,
  songsPerDay: int('DAILY_SONGS_PER_USER', 10),
  lyricsPerDay: int('DAILY_LYRICS_PER_USER', 20),
  versions: Math.min(4, Math.max(1, int('VERSIONS_PER_REQUEST', 2))),
  allowedOrigin: env('ALLOWED_ORIGIN') ?? '*',
  // deno-lint-ignore no-explicit-any
  background: (work) => (globalThis as any).EdgeRuntime?.waitUntil(work) ?? work,
});

Deno.serve(handle);
