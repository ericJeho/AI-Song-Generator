// The app's backends.
//
// Built-in synth (always available, no sign-in): songs are composed and rendered in this
// browser by public/synth.js and saved in this browser's storage. Only the settings and a
// seed are stored; the audio is re-rendered on demand and comes out the same every time.
//
// AI music (optional): when the Supabase project in config.js has a music API key, signed-in
// visitors can also make AI songs with vocals through the `api` Edge Function. Those songs
// live in the `songs` table and storage bucket.
//
// Songs are { id, engine: 'synth'|'ai', title, tags, duration, status, error, audioUrl, audioPath,
// request, seed, createdAt }, status being 'pending', 'ready' or 'failed'.
// Failed calls reject with an Error carrying `status` (401 = sign in, 403 = invite code needed).

(function () {
  const config = window.CADENCE_CONFIG || {};
  const LOCAL_KEY = 'cadence.library.v1';
  const STOP = ['the', 'and', 'for', 'with', 'after', 'about', 'from', 'into', 'that', 'this', 'last', 'by', 'through', 'late'];

  function titleFrom(prompt) {
    const words = prompt.replace(/[^A-Za-z\s'-]/g, ' ').split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.includes(w.toLowerCase())).slice(0, 3);
    if (!words.length) return 'Untitled';
    return words.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ');
  }

  function hash(text) {
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
    return h;
  }

  // ---------- Songs made in this browser ----------

  function loadLocal() {
    try {
      const saved = JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]');
      if (!Array.isArray(saved)) return [];
      return saved.filter((s) => s && s.id && s.title && s.request).map((s) => Object.assign({}, s, {
        // Songs saved by earlier versions were silent placeholders; give them a seed so they play.
        engine: 'synth',
        status: 'ready',
        seed: typeof s.seed === 'number' ? s.seed : hash(s.id),
        audioUrl: null,
        tags: String(s.tags || '').replace(/ · Demo \(silent\)/, '')
      }));
    } catch {
      return [];
    }
  }

  function saveLocal(songs) {
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(songs.map((s) => ({
        id: s.id, title: s.title, tags: s.tags, duration: s.duration, request: s.request, seed: s.seed, createdAt: s.createdAt
      }))));
    } catch {
      // Storage full or blocked: the list still works until the page is closed.
    }
  }

  function synthTags(req, seed) {
    const tags = [];
    if (req.genres.length) tags.push(req.genres.join(' · '));
    if (req.mood) tags.push(req.mood);
    tags.push(req.tempo + ' BPM');
    if (window.CadenceSynth) tags.push(window.CadenceSynth.describe(req, seed).key);
    tags.push(req.lyricMode === 'none' ? 'Instrumental' : 'Hummed melody');
    return tags.join(' · ');
  }

  function makeSynthSongs(req) {
    const base = titleFrom(req.prompt);
    const now = Date.now();
    const songs = [0, 1].map((k) => {
      const seed = ((now % 1000000007) + k * 7919 + hash(req.prompt)) >>> 0;
      return {
        id: 'local-' + now + '-' + k,
        engine: 'synth',
        title: k === 0 ? base : base + ' (Alt Take)',
        tags: synthTags(req, seed),
        duration: req.length,
        status: 'ready',
        error: null,
        audioUrl: null,
        request: req,
        seed,
        createdAt: new Date(now).toISOString()
      };
    });
    saveLocal(songs.concat(loadLocal()));
    return songs;
  }

  const local = {
    list: async () => loadLocal(),
    remove: async (song) => saveLocal(loadLocal().filter((s) => s.id !== song.id))
  };

  // ---------- Supabase (AI songs, accounts) ----------

  const client = config.supabaseUrl && window.supabase ? window.supabase.createClient(config.supabaseUrl, config.supabaseKey) : null;
  const apiBase = client ? config.supabaseUrl.replace(/\/$/, '') + '/functions/v1/api/' : '';

  async function api(route, body) {
    if (!client) throw Object.assign(new Error('AI songs are not set up on this site.'), { status: 404 });
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

  function fromRow(row) {
    return {
      id: row.id,
      engine: 'ai',
      title: row.title,
      tags: row.tags,
      duration: row.duration,
      status: row.status,
      error: row.error,
      audioUrl: row.audio_path ? client.storage.from('songs').getPublicUrl(row.audio_path).data.publicUrl : null,
      audioPath: row.audio_path,
      request: row.request,
      seed: null,
      createdAt: row.created_at
    };
  }

  async function listRemote() {
    if (!client) return [];
    const { data: session } = await client.auth.getSession();
    if (!session.session) return [];
    const { data, error } = await client.from('songs').select('*').order('created_at', { ascending: false }).limit(200);
    if (error) throw new Error(error.message);
    return data.map(fromRow);
  }

  function authError(error) {
    return Object.assign(new Error(error.message || 'Sign-in failed.'), { status: error.status || 400 });
  }

  window.SongProvider = {
    // What the server offers: null when there is no backend or it can't be reached.
    async init() {
      if (!client) return { health: null, me: null };
      try {
        const [health, me] = await Promise.all([api('health'), api('me')]);
        return { health, me: me.user };
      } catch (err) {
        console.warn('Backend unavailable; using the built-in synth only.', err);
        return { health: null, me: null };
      }
    },

    // This browser's songs plus, when signed in, the account's AI songs; newest first.
    async listSongs() {
      const [mine, remote] = await Promise.all([local.list(), listRemote().catch((err) => {
        console.error('Could not load AI songs:', err);
        return [];
      })]);
      return mine.concat(remote).sort((a, b) => (b.createdAt > a.createdAt ? 1 : b.createdAt < a.createdAt ? -1 : 0));
    },

    async generateSynth(req) {
      return { songs: makeSynthSongs(req), user: null };
    },

    async generateAI(req) {
      const result = await api('generate', req);
      return { songs: result.songs.map(fromRow), user: result.user };
    },

    async deleteSong(song) {
      if (song.engine === 'synth') return local.remove(song);
      if (song.audioPath) await client.storage.from('songs').remove([song.audioPath]);
      const { error } = await client.from('songs').delete().eq('id', song.id);
      if (error) throw new Error(error.message);
    },

    draftLyrics: (req) => api('lyrics', req),
    redeem: (code) => api('redeem', { code }),

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
      if (client) await client.auth.signOut();
    }
  };
})();
