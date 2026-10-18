// The app's backend. With a Supabase project configured in config.js it uses
// Supabase Auth, the `songs` table, the `songs` storage bucket and the `api` Edge Function.
// Without one it runs as a demo: silent placeholder songs kept in this browser.
//
// Songs are returned as { id, title, tags, duration, status, error, audioUrl, request, createdAt }
// where status is 'pending', 'ready' or 'failed'.
// Failed calls reject with an Error carrying `status` (401 = sign in, 403 = invite code needed).

(function () {
  const config = window.CADENCE_CONFIG || {};

  // ---------- Demo (no backend) ----------

  const DEMO_KEY = 'cadence.library.v1';
  const STOP = ['the', 'and', 'for', 'with', 'after', 'about', 'from', 'into', 'that', 'this', 'last', 'by', 'through', 'late'];

  function titleFrom(prompt) {
    const words = prompt.replace(/[^A-Za-z\s'-]/g, ' ').split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.includes(w.toLowerCase())).slice(0, 3);
    if (!words.length) return 'Untitled';
    return words.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ');
  }

  function loadLocal() {
    try {
      const saved = JSON.parse(localStorage.getItem(DEMO_KEY) || '[]');
      return Array.isArray(saved) ? saved.filter((t) => t && t.id && t.title) : [];
    } catch {
      return [];
    }
  }

  function saveLocal(songs) {
    try {
      localStorage.setItem(DEMO_KEY, JSON.stringify(songs));
    } catch {
      // Storage full or blocked: the list still works until the page is closed.
    }
  }

  const demo = {
    mode: 'demo',
    async init() {
      return { health: null, me: null };
    },
    async listSongs() {
      return loadLocal();
    },
    async generate(req) {
      await new Promise((r) => setTimeout(r, 1800));
      const tags = [];
      if (req.genres.length) tags.push(req.genres.join(' · '));
      if (req.mood) tags.push(req.mood);
      tags.push(req.tempo + ' BPM');
      if (req.lyricMode === 'none') tags.push('Instrumental');
      tags.push('Demo (silent)');
      const base = titleFrom(req.prompt);
      const now = Date.now();
      const songs = [0, 1].map((k) => ({
        id: 'demo-' + now + '-' + k,
        title: k === 0 ? base : base + ' (Alt Take)',
        tags: tags.join(' · '),
        duration: req.length,
        status: 'ready',
        error: null,
        audioUrl: null,
        request: req,
        createdAt: new Date(now).toISOString()
      }));
      saveLocal(songs.concat(loadLocal()));
      return { songs, user: null };
    },
    async deleteSong(song) {
      saveLocal(loadLocal().filter((s) => s.id !== song.id));
    }
  };

  if (!config.supabaseUrl || !window.supabase) {
    window.SongProvider = demo;
    return;
  }

  // ---------- Supabase ----------

  const client = window.supabase.createClient(config.supabaseUrl, config.supabaseKey);
  const apiBase = config.supabaseUrl.replace(/\/$/, '') + '/functions/v1/api/';

  async function api(route, body) {
    const { data } = await client.auth.getSession();
    const token = data.session && data.session.access_token;
    const headers = { apikey: config.supabaseKey };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch(apiBase + route, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw Object.assign(new Error('Could not reach the server. Check your connection and try again.'), { status: 0 });
    }
    const json = await res.json().catch(() => null);
    if (!res.ok) throw Object.assign(new Error((json && json.error) || 'Request failed (' + res.status + ').'), { status: res.status });
    return json;
  }

  function toSong(row) {
    return {
      id: row.id,
      title: row.title,
      tags: row.tags,
      duration: row.duration,
      status: row.status,
      error: row.error,
      audioUrl: row.audio_path ? client.storage.from('songs').getPublicUrl(row.audio_path).data.publicUrl : null,
      audioPath: row.audio_path,
      request: row.request,
      createdAt: row.created_at
    };
  }

  function authError(error) {
    return Object.assign(new Error(error.message || 'Sign-in failed.'), { status: error.status || 400 });
  }

  window.SongProvider = {
    mode: 'supabase',

    async init() {
      const [health, me] = await Promise.all([api('health'), api('me')]);
      return { health, me: me.user };
    },

    async listSongs() {
      const { data: session } = await client.auth.getSession();
      if (!session.session) return [];
      const { data, error } = await client.from('songs').select('*').order('created_at', { ascending: false }).limit(200);
      if (error) throw new Error(error.message);
      return data.map(toSong);
    },

    async generate(req) {
      const result = await api('generate', req);
      return { songs: result.songs.map(toSong), user: result.user };
    },

    draftLyrics: (req) => api('lyrics', req),
    redeem: (code) => api('redeem', { code }),

    async deleteSong(song) {
      if (song.audioPath) await client.storage.from('songs').remove([song.audioPath]);
      const { error } = await client.from('songs').delete().eq('id', song.id);
      if (error) throw new Error(error.message);
    },

    async signIn({ email, password }) {
      const { error } = await client.auth.signInWithPassword({ email, password });
      if (error) throw authError(error);
      return { user: (await api('me')).user };
    },

    async signUp({ email, password, inviteCode }) {
      const { data, error } = await client.auth.signUp({
        email,
        password,
        options: { data: { invite_code: inviteCode || '' }, emailRedirectTo: location.origin + location.pathname }
      });
      if (error) throw authError(error);
      if (!data.session) {
        throw Object.assign(new Error('Check your email and click the link to confirm your account, then sign in.'), { info: true });
      }
      return { user: (await api('me')).user };
    },

    async signOut() {
      await client.auth.signOut();
    }
  };
})();
