(function () {
  const GENRES = ['Pop', 'Hip-Hop', 'Afrobeats', 'Amapiano', 'R&B', 'Lo-fi', 'House', 'Rock', 'Jazz', 'Synthwave', 'Folk', 'Cinematic'];
  const MOODS = [
    ['Euphoric', 'big, bright, lifted'], ['Bittersweet', 'happy-sad'], ['Chill', 'laid-back, warm'], ['Melancholic', 'slow ache'],
    ['Dark', 'tense, brooding'], ['Romantic', 'tender, close'], ['Energetic', 'driving, loud'], ['Dreamy', 'hazy, floating']
  ];
  const INSTRUMENTS = ['Piano', 'Acoustic guitar', 'Electric guitar', '808s', 'Synth pads', 'Strings', 'Saxophone', 'Talking drum', 'Bass', 'Brass'];
  const LYRIC_MODES = [['auto', 'Write for me'], ['custom', 'My lyrics'], ['none', 'Instrumental']];
  const ENGINES = [['synth', 'Built-in synth · free'], ['ai', 'AI vocals · sign in']];
  const VOICES = ['Female', 'Male', 'Duet'];
  const LENGTHS = [60, 120, 180, 240];
  const SUGGESTIONS = [
    'Rainy Lagos morning, slow and soulful',
    'Stadium anthem about never giving up',
    'Lullaby for a robot learning to dream'
  ];
  const COVERS = ['#FF9A62', '#5EC8B8', '#B69CFF', '#F2C14E', '#7DA2FF', '#F27BA6'];
  const SETTINGS = ['prompt', 'genres', 'mood', 'instruments', 'lyricMode', 'voice', 'lyrics', 'tempo', 'length'];
  const POLL_MS = 4000;
  const provider = window.SongProvider;

  // Cover colour and waveform shape come from the song's id, so they stay the same on every visit.
  function hash(text) {
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
    return h;
  }

  // A song still pending after this long was cut off on the server (Edge Function time limit).
  const STALE_MS = 10 * 60 * 1000;

  function toTrack(song) {
    const h = hash(song.id);
    const track = Object.assign({}, song, { cover: COVERS[h % COVERS.length], waveSeed: h % 1000 });
    if (track.status === 'pending' && track.createdAt && Date.now() - Date.parse(track.createdAt) > STALE_MS) {
      track.status = 'failed';
      track.error = 'This song took too long and was stopped. Remove it and try again, perhaps with a shorter length.';
    }
    return track;
  }

  const state = {
    prompt: 'A late-night drive through Nairobi after a breakup, hopeful by the last chorus',
    genres: ['Afrobeats', 'R&B'],
    mood: 'Bittersweet',
    instruments: ['Synth pads', '808s', 'Electric guitar'],
    lyricMode: 'auto',
    voice: 'Female',
    lyrics: '',
    tempo: 104,
    length: 180,
    engine: 'synth', // 'synth': built-in, free, no sign-in; 'ai': AI vocals through the server (sign-in)
    generating: false,
    drafting: false,
    preparingId: null, // a built-in synth song being rendered before it plays
    health: null, // what the server supports, from /api/health (null without a server)
    me: null, // the signed-in user
    versions: 2,
    newIds: [],
    currentId: null,
    playing: false,
    pos: 0,
    tracks: []
  };

  const $ = (id) => document.getElementById(id);
  const audio = new Audio();

  // Built-in synth songs are rendered in the browser the first time they're played.
  // The last few renders are kept as in-memory WAV files.
  const RENDER_CACHE = 4;
  const rendered = new Map(); // song id -> { url, peaks, duration }
  const rendering = new Map(); // song id -> Promise of the above

  function audioFor(t) {
    if (t.audioUrl) return t.audioUrl;
    const r = rendered.get(t.id);
    return r ? r.url : null;
  }

  function renderSynth(t) {
    if (rendered.has(t.id)) {
      const r = rendered.get(t.id);
      rendered.delete(t.id);
      rendered.set(t.id, r); // most recently used last
      return Promise.resolve(r);
    }
    if (rendering.has(t.id)) return rendering.get(t.id);
    if (!window.CadenceSynth) return Promise.reject(new Error('This browser cannot make audio.'));
    const job = window.CadenceSynth.render(t.request, t.seed).then((out) => {
      const r = { url: URL.createObjectURL(window.CadenceSynth.toWav(out.buffer)), peaks: out.peaks, duration: out.duration };
      rendered.set(t.id, r);
      for (const [id, old] of rendered) {
        if (rendered.size <= RENDER_CACHE) break;
        if (id === state.currentId) continue;
        URL.revokeObjectURL(old.url);
        rendered.delete(id);
      }
      return r;
    }).finally(() => rendering.delete(t.id));
    rendering.set(t.id, job);
    return job;
  }

  function aiAvailable() {
    return Boolean(state.health && state.health.provider && state.health.provider !== 'mock');
  }

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'onclick') node.addEventListener('click', v);
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v; // only used with static SVG strings
      else node.setAttribute(k, v);
    }
    (children || []).forEach((c) => node.append(c));
    return node;
  }

  function fmt(sec) {
    const s = Math.floor(sec);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  function bars(seed) {
    let x = seed * 9973 + 17;
    const out = [];
    for (let i = 0; i < 56; i++) {
      x = (x * 9301 + 49297) % 233280;
      const env = 0.45 + 0.55 * Math.sin((i / 55) * Math.PI);
      out.push(Math.round(14 + (x / 233280) * 86 * env));
    }
    return out;
  }

  function styleString() {
    const parts = [];
    if (state.genres.length) parts.push(state.genres.join(', '));
    if (state.mood) parts.push(state.mood.toLowerCase());
    parts.push(state.tempo + ' bpm');
    if (state.instruments.length) parts.push(state.instruments.join(', ').toLowerCase());
    parts.push(state.lyricMode === 'none' ? 'instrumental' : state.voice.toLowerCase() + ' vocals');
    return parts.join(' · ');
  }

  // ---------- Composer ----------

  function renderToggleGroup(container, items, isOn, onToggle, className, content) {
    container.replaceChildren(...items.map((item) => {
      const b = el('button', { type: 'button', class: className, 'aria-pressed': String(isOn(item)), onclick: () => onToggle(item) });
      content ? content(b, item) : (b.textContent = item);
      return b;
    }));
  }

  // Add a genre typed by the visitor. Matching is case-insensitive, so 'afrobeats' selects the Afrobeats chip.
  function addGenre() {
    const input = $('genre-input');
    const text = input.value.replace(/[<>\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
    const hint = $('genre-hint');
    hint.hidden = true;
    if (!text) return;
    if (state.genres.length >= 3) {
      hint.textContent = 'You can mix up to 3 genres.';
      hint.hidden = false;
      return;
    }
    const known = GENRES.concat((window.CadenceSynth && window.CadenceSynth.genres) || []);
    const name = known.find((g) => g.toLowerCase() === text.toLowerCase()) || text;
    if (!state.genres.some((g) => g.toLowerCase() === name.toLowerCase())) state.genres = state.genres.concat(name);
    input.value = '';
    renderComposer();
    input.focus();
  }

  function renderComposer() {
    renderToggleGroup($('genres'), GENRES, (g) => state.genres.includes(g), (g) => {
      if (state.genres.includes(g)) state.genres = state.genres.filter((x) => x !== g);
      else if (state.genres.length < 3) state.genres = state.genres.concat(g);
      renderComposer();
    }, 'chip');
    // Genres typed by the visitor show as removable chips after the quick picks.
    state.genres.filter((g) => !GENRES.includes(g)).forEach((g) => {
      $('genres').append(el('button', {
        type: 'button', class: 'chip custom', 'aria-pressed': 'true', 'aria-label': 'Remove genre ' + g,
        onclick: () => { state.genres = state.genres.filter((x) => x !== g); renderComposer(); }
      }, [el('span', { text: g }), el('span', { class: 'x', 'aria-hidden': 'true', text: '×' })]));
    });
    const full = state.genres.length >= 3;
    $('genre-input').disabled = full;
    $('genre-add').disabled = full;
    $('genre-input').placeholder = full ? 'Up to 3 genres: remove one to add another' : 'Any genre: drill, bossa nova, Bongo Flava, sea shanty…';

    renderToggleGroup($('moods'), MOODS, (m) => state.mood === m[0], (m) => {
      state.mood = state.mood === m[0] ? null : m[0];
      renderComposer();
    }, 'mood', (b, m) => b.append(el('strong', { text: m[0] }), el('small', { text: m[1] })));

    renderToggleGroup($('instruments'), INSTRUMENTS, (i) => state.instruments.includes(i), (i) => {
      state.instruments = state.instruments.includes(i) ? state.instruments.filter((x) => x !== i) : state.instruments.concat(i);
      renderComposer();
    }, 'chip');

    renderToggleGroup($('lyric-modes'), LYRIC_MODES, (l) => state.lyricMode === l[0], (l) => {
      state.lyricMode = l[0];
      renderComposer();
    }, '', (b, l) => (b.textContent = l[1]));

    renderToggleGroup($('voices'), VOICES, (v) => state.voice === v, (v) => {
      state.voice = v;
      renderComposer();
    }, '');

    renderToggleGroup($('lengths'), LENGTHS, (d) => state.length === d, (d) => {
      state.length = d;
      renderComposer();
    }, '', (b, d) => (b.textContent = fmt(d)));

    $('voice-field').hidden = state.lyricMode === 'none';
    $('lyrics-field').hidden = state.lyricMode !== 'custom';

    const word = state.tempo < 80 ? 'slow' : state.tempo < 110 ? 'mid-tempo' : state.tempo < 140 ? 'upbeat' : 'fast';
    $('tempo-label').textContent = state.tempo + ' BPM · ' + word;
    $('prompt-len').textContent = state.prompt.length;
    $('style-string').textContent = styleString();
    $('lyrics').value = state.lyrics;

    if (!aiAvailable()) state.engine = 'synth';
    $('engine-field').hidden = !aiAvailable();
    renderToggleGroup($('engines'), ENGINES, (e) => state.engine === e[0], (e) => {
      state.engine = e[0];
      renderComposer();
    }, '', (b, e) => (b.textContent = e[1]));
    $('engine-note').textContent = state.engine === 'synth'
      ? 'Composed in your browser: instrumental, with the melody hummed by a voice-like lead. No sign-in.'
      : 'Sung by an AI music service. Needs an account; counts toward your daily songs.';
    $('synth-lyrics-note').hidden = !(state.engine === 'synth' && state.lyricMode === 'custom');
    const versions = state.engine === 'synth' ? 2 : state.versions;
    $('versions-note').textContent = 'Creates ' + versions + (versions === 1 ? ' version' : ' versions') +
      (state.engine === 'synth' ? ' · free, made in your browser' : '');

    const btn = $('generate');
    const outOfSongs = state.engine === 'ai' && state.me && state.me.songsLeftToday < 1;
    if (needsSignIn()) {
      btn.disabled = false;
      $('generate-label').textContent = 'Sign in to generate';
    } else {
      btn.disabled = state.generating || outOfSongs || !state.prompt.trim() || (state.lyricMode === 'custom' && !state.lyrics.trim());
      $('generate-label').textContent = state.generating ? 'Composing…' : outOfSongs ? 'No songs left today' : 'Generate song';
    }
    btn.classList.toggle('busy', state.generating);

    const draft = $('draft-lyrics');
    draft.hidden = !(state.health && state.health.lyricsHelper);
    draft.disabled = state.drafting || !state.prompt.trim();
    draft.textContent = state.drafting ? 'Drafting…' : 'Draft from my description';
    renderAccount();
  }

  // ---------- Library ----------

  const PLAY_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9.5-5.5z" fill="currentColor"/></svg>';
  const PAUSE_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="2" width="3.5" height="12" rx="1" fill="currentColor"/><rect x="9.5" y="2" width="3.5" height="12" rx="1" fill="currentColor"/></svg>';
  const COVER_SVG = '<svg width="84" height="84" viewBox="0 0 84 84" fill="none" aria-hidden="true"><circle cx="62" cy="22" r="30" stroke="#0E0F12" stroke-opacity=".22" stroke-width="2"/><circle cx="62" cy="22" r="18" stroke="#0E0F12" stroke-opacity=".22" stroke-width="2"/><circle cx="62" cy="22" r="6" fill="#0E0F12" fill-opacity=".3"/></svg>';
  function icon(path) {
    return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + path + '</svg>';
  }
  const REMIX_ICON = icon('<path d="M4 7h11l-3-3M20 17H9l3 3M18 7a4 4 0 0 1 2 3.5M6 17a4 4 0 0 1-2-3.5"/>');
  const DOWNLOAD_ICON = icon('<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>');
  const SPINNER_SVG = '<svg class="spin" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-opacity=".25" stroke-width="2"/><path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  const DELETE_ICON = icon('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>');

  // Load a song's settings back into the composer so it can be tweaked and regenerated.
  function remix(t) {
    if (!t.request) return;
    SETTINGS.forEach((k) => { if (t.request[k] !== undefined) state[k] = Array.isArray(t.request[k]) ? t.request[k].slice() : t.request[k]; });
    $('prompt').value = state.prompt;
    $('tempo').value = state.tempo;
    renderComposer();
    $('create').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('prompt').focus({ preventScroll: true });
  }

  async function removeTrack(t) {
    if (!confirm('Remove “' + t.title + '” from your songs?')) return;
    try {
      await provider.deleteSong(t);
    } catch (err) {
      alert('Could not remove the song: ' + err.message);
      return;
    }
    if (state.currentId === t.id) {
      audio.pause();
      state.currentId = null;
      state.playing = false;
    }
    state.tracks = state.tracks.filter((x) => x.id !== t.id);
    renderLibrary();
  }

  // Load the song list, and keep refreshing it while any song is still being made.
  let pollTimer = null;
  async function refreshSongs() {
    clearTimeout(pollTimer);
    try {
      const songs = await provider.listSongs();
      state.tracks = songs.map(toTrack);
      renderLibrary();
    } catch (err) {
      console.error('Could not load songs:', err);
    }
    if (state.tracks.some((t) => t.status === 'pending')) pollTimer = setTimeout(refreshSongs, POLL_MS);
  }

  function initials(title) {
    return title.split(' ').filter((w) => /[A-Za-z]/.test(w[0])).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  }

  async function togglePlay(t) {
    if (t.engine === 'synth' && !audioFor(t)) {
      if (state.preparingId === t.id) return;
      audio.pause();
      state.playing = false;
      state.currentId = t.id;
      state.preparingId = t.id;
      state.pos = 0;
      renderLibrary();
      try {
        await renderSynth(t);
      } catch (err) {
        console.error(err);
        if (state.preparingId === t.id) state.preparingId = null;
        renderLibrary();
        alert('Could not play this song: ' + err.message);
        return;
      }
      if (state.preparingId !== t.id) return; // another song was picked meanwhile
      state.preparingId = null;
      state.currentId = null; // start it fresh below
    }
    const src = audioFor(t);
    if (state.currentId === t.id) {
      state.playing = !state.playing;
    } else {
      audio.pause();
      state.preparingId = null;
      state.currentId = t.id;
      state.pos = 0;
      state.playing = true;
      if (src) audio.src = src;
      else audio.removeAttribute('src');
    }
    if (src) {
      if (state.playing) audio.play().catch(() => { state.playing = false; renderLibrary(); });
      else audio.pause();
    }
    renderLibrary();
  }

  async function downloadSynth(t) {
    try {
      const r = await renderSynth(t);
      const a = el('a', { href: r.url, download: t.title + '.wav' });
      document.body.append(a);
      a.click();
      a.remove();
      renderLibrary();
    } catch (err) {
      alert('Could not prepare the download: ' + err.message);
    }
  }

  // Real audio: use the file's true length, and stop at the end.
  audio.addEventListener('loadedmetadata', () => {
    const t = state.tracks.find((x) => x.id === state.currentId);
    if (t && Number.isFinite(audio.duration)) t.duration = audio.duration;
  });
  audio.addEventListener('ended', () => {
    state.playing = false;
    state.pos = 0;
    renderLibrary();
  });

  function seek(t, e) {
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    if (state.currentId !== t.id) togglePlay(t);
    state.pos = frac * t.duration;
    if (audioFor(t)) audio.currentTime = state.pos;
    renderLibrary();
  }

  function trackCard(t) {
    if (t.status === 'pending') return pendingCard('“' + t.title + '”');
    if (t.status === 'failed') {
      return el('article', { class: 'card failed' }, [
        el('div', { class: 'meta' }, [
          el('div', { class: 'title-row' }, [el('h3', { text: t.title })]),
          el('span', { class: 'form-error', text: t.error || 'This song could not be made.' })
        ]),
        el('div', { class: 'actions' }, [
          t.request ? el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Try again with these settings', title: 'Try again', html: REMIX_ICON, onclick: () => remix(t) }) : '',
          el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Remove ' + t.title, title: 'Remove', html: DELETE_ICON, onclick: () => removeTrack(t) })
        ])
      ]);
    }
    const isCur = state.currentId === t.id;
    const isPlaying = isCur && state.playing;
    const isPreparing = state.preparingId === t.id;
    const r = rendered.get(t.id);
    const duration = (r && r.duration) || t.duration;
    const frac = isCur ? state.pos / duration : 0;

    const cover = el('div', { class: 'cover', style: 'background:' + t.cover, html: COVER_SVG }, [el('span', { text: initials(t.title) })]);

    const titleRow = el('div', { class: 'title-row' }, [el('h3', { text: t.title })]);
    if (state.newIds.includes(t.id)) titleRow.append(el('span', { class: 'badge', text: 'New' }));

    const hs = r ? r.peaks.map((p) => Math.round(10 + p * 90)) : bars(t.waveSeed);
    const wave = el('div', { class: 'wave', 'aria-hidden': 'true', onclick: (e) => seek(t, e) },
      hs.map((h, i) => el('span', { style: 'height:' + h + '%', class: isCur && i / hs.length < frac ? 'played' : '' })));

    const player = el('div', { class: 'player' }, [
      el('button', {
        type: 'button', class: 'play' + (isPreparing ? ' preparing' : ''),
        'aria-label': (isPreparing ? 'Preparing ' : isPlaying ? 'Pause ' : 'Play ') + t.title,
        html: isPreparing ? SPINNER_SVG : isPlaying ? PAUSE_SVG : PLAY_SVG,
        onclick: () => togglePlay(t)
      }),
      wave,
      el('span', { class: 'time', text: isPreparing ? 'Preparing…' : (isCur ? fmt(state.pos) + ' / ' : '') + fmt(duration) })
    ]);

    const actions = el('div', { class: 'actions' });
    if (t.request) {
      actions.append(el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Remix: load these settings', title: 'Remix', html: REMIX_ICON, onclick: () => remix(t) }));
    }
    if (t.audioUrl) {
      actions.append(el('a', { class: 'icon-btn', href: t.audioUrl, download: t.title + '.mp3', 'aria-label': 'Download ' + t.title, title: 'Download', html: DOWNLOAD_ICON }));
    } else if (t.engine === 'synth') {
      actions.append(el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Download ' + t.title + ' as WAV', title: 'Download', html: DOWNLOAD_ICON, onclick: () => downloadSynth(t) }));
    }
    actions.append(el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Remove ' + t.title, title: 'Remove', html: DELETE_ICON, onclick: () => removeTrack(t) }));

    return el('article', { class: 'card' + (isCur ? ' current' : '') }, [
      cover,
      el('div', { class: 'meta' }, [titleRow, el('span', { class: 'tags', text: t.tags }), player]),
      actions
    ]);
  }

  function pendingCard(label, quick) {
    return el('div', { class: 'card pending' }, [
      el('div', { class: 'skel', style: 'width:84px;height:84px;border-radius:14px;flex:none' }),
      el('div', { class: 'meta', style: 'gap:10px' }, [
        el('span', { style: 'font-weight:600', text: 'Composing ' + label + (quick ? '…' : '… this can take a minute or two') }),
        el('div', { class: 'skel', style: 'height:10px;width:70%' }),
        el('div', { class: 'skel', style: 'height:28px;width:100%;background:#22252C' })
      ])
    ]);
  }

  function renderLibrary() {
    const synth = state.engine === 'synth';
    const count = !synth && state.me ? Math.min(state.versions, Math.max(1, state.me.songsLeftToday)) : synth ? 2 : state.versions;
    const pending = state.generating ? 'ABCD'.slice(0, count).split('').map((l) => pendingCard('version ' + l, synth)) : [];
    $('pending').replaceChildren(...pending);
    $('tracks').replaceChildren(...state.tracks.map(trackCard));
    $('track-count').textContent = state.tracks.length;
    $('empty').hidden = state.generating || state.tracks.length > 0;
  }

  // ---------- Generate ----------

  function currentRequest() {
    return {
      prompt: state.prompt.trim(),
      style: styleString(),
      genres: state.genres.slice(),
      mood: state.mood,
      instruments: state.instruments.slice(),
      lyricMode: state.lyricMode,
      lyrics: state.lyricMode === 'custom' ? state.lyrics : '',
      voice: state.lyricMode === 'none' ? null : state.voice,
      tempo: state.tempo,
      length: state.length
    };
  }

  async function generate() {
    if (needsSignIn()) return openAuth('signin');
    if ($('generate').disabled) return;
    state.generating = true;
    renderComposer();
    renderLibrary();
    const request = currentRequest();
    let retry = false;
    try {
      const result = state.engine === 'ai' ? await provider.generateAI(request) : await provider.generateSynth(request);
      if (result.user) state.me = result.user;
      const made = result.songs.map(toTrack);
      // Render the first built-in version right away so it plays instantly and shows its real waveform.
      if (made[0] && made[0].engine === 'synth') await renderSynth(made[0]).catch((err) => console.error(err));
      state.tracks = made.concat(state.tracks.filter((t) => !made.some((m) => m.id === t.id)));
      state.newIds = made.map((m) => m.id);
      if (made.some((t) => t.status === 'pending')) pollTimer = setTimeout(refreshSongs, POLL_MS);
    } catch (err) {
      if (err.status === 401) {
        state.me = null;
        openAuth('signin');
      } else if (err.status === 403) {
        retry = await askForInviteCode();
      } else {
        alert(err.message || 'Something went wrong while generating.');
      }
    } finally {
      state.generating = false;
      renderComposer();
      renderLibrary();
    }
    if (retry) generate();
  }

  async function draftLyrics() {
    if (needsSignIn()) return openAuth('signin');
    state.drafting = true;
    $('lyrics-error').hidden = true;
    renderComposer();
    let retry = false;
    try {
      const result = await provider.draftLyrics(currentRequest());
      if (result.user) state.me = result.user;
      state.lyrics = result.lyrics;
    } catch (err) {
      if (err.status === 401) {
        state.me = null;
        openAuth('signin');
      } else if (err.status === 403) {
        retry = await askForInviteCode();
      } else {
        $('lyrics-error').textContent = err.message;
        $('lyrics-error').hidden = false;
      }
    } finally {
      state.drafting = false;
      renderComposer();
    }
    if (retry) draftLyrics();
  }

  // ---------- Account ----------

  // Accounts created without the right invite code can add it later. Returns true once approved.
  async function askForInviteCode() {
    const code = prompt('This site needs an invite code before you can create songs. Enter it here:');
    if (!code) return false;
    try {
      const result = await provider.redeem(code);
      state.me = result.user;
      renderComposer();
      return true;
    } catch (err) {
      alert(err.message);
      return false;
    }
  }

  function needsSignIn() {
    return state.engine === 'ai' && !state.me;
  }

  function renderAccount() {
    const usesAccounts = aiAvailable();
    $('account').hidden = !usesAccounts;
    if (!usesAccounts) return;
    $('sign-in-btn').hidden = Boolean(state.me);
    $('sign-out-btn').hidden = !state.me;
    $('account-status').textContent = state.me
      ? state.me.email + ' · ' + state.me.songsLeftToday + ' of ' + state.me.songsPerDay + ' songs left today'
      : '';
  }

  let authMode = 'signin';
  function setAuthMode(mode) {
    authMode = mode;
    const signup = mode === 'signup';
    $('auth-title').textContent = signup ? 'Create your account' : 'Sign in';
    $('auth-submit').textContent = signup ? 'Create account' : 'Sign in';
    $('mode-signin').setAttribute('aria-pressed', String(!signup));
    $('mode-signup').setAttribute('aria-pressed', String(signup));
    $('auth-password').autocomplete = signup ? 'new-password' : 'current-password';
    $('password-hint').hidden = !signup;
    $('invite-field').hidden = !(signup && state.health && state.health.signupCodeRequired);
    $('auth-error').hidden = true;
  }

  function openAuth(mode) {
    setAuthMode(mode);
    const dialog = $('auth-dialog');
    if (!dialog.open) dialog.showModal();
    $('auth-email').focus();
  }

  async function submitAuth(e) {
    e.preventDefault();
    const body = { email: $('auth-email').value, password: $('auth-password').value, inviteCode: $('auth-invite').value };
    $('auth-submit').disabled = true;
    try {
      const result = authMode === 'signup' ? await provider.signUp(body) : await provider.signIn(body);
      state.me = result.user;
      $('auth-password').value = '';
      $('auth-dialog').close();
      renderComposer();
      refreshSongs();
    } catch (err) {
      if (err.info) setAuthMode('signin');
      $('auth-error').textContent = err.message;
      $('auth-error').classList.toggle('info', Boolean(err.info));
      $('auth-error').hidden = false;
    } finally {
      $('auth-submit').disabled = false;
    }
  }

  async function signOut() {
    try {
      await provider.signOut();
    } catch {
      // Signed out locally either way.
    }
    clearTimeout(pollTimer);
    audio.pause();
    state.me = null;
    state.engine = 'synth';
    state.currentId = null;
    state.playing = false;
    renderComposer();
    refreshSongs();
  }

  // ---------- Playback clock ----------

  setInterval(() => {
    if (!state.playing) return;
    const t = state.tracks.find((x) => x.id === state.currentId);
    if (!t) return;
    state.pos = audioFor(t) ? audio.currentTime : state.pos + 0.25;
    if (!audioFor(t) && state.pos >= t.duration) {
      state.playing = false;
      state.pos = 0;
    }
    renderLibrary();
  }, 250);

  // ---------- Wire up ----------

  $('suggestions').replaceChildren(...SUGGESTIONS.map((s) => el('button', {
    type: 'button', class: 'suggestion', text: s,
    onclick: () => { state.prompt = s; $('prompt').value = s; renderComposer(); }
  })));

  $('prompt').value = state.prompt;
  $('prompt').addEventListener('input', (e) => { state.prompt = e.target.value.slice(0, 300); renderComposer(); });
  $('lyrics').addEventListener('input', (e) => { state.lyrics = e.target.value.slice(0, 3000); renderComposer(); });
  $('tempo').value = state.tempo;
  $('tempo').addEventListener('input', (e) => { state.tempo = Number(e.target.value); renderComposer(); });
  $('generate').addEventListener('click', generate);
  $('genre-add').addEventListener('click', addGenre);
  $('genre-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addGenre();
    }
  });
  const suggestions = ((window.CadenceSynth && window.CadenceSynth.genres) || GENRES).filter((g) => !GENRES.includes(g));
  $('genre-suggestions').replaceChildren(...suggestions.map((g) => el('option', { value: g })));
  $('draft-lyrics').addEventListener('click', draftLyrics);
  $('sign-in-btn').addEventListener('click', () => openAuth('signin'));
  $('sign-out-btn').addEventListener('click', signOut);
  $('mode-signin').addEventListener('click', () => setAuthMode('signin'));
  $('mode-signup').addEventListener('click', () => setAuthMode('signup'));
  $('auth-close').addEventListener('click', () => $('auth-dialog').close());
  $('auth-form').addEventListener('submit', submitAuth);

  // Ask the backend what it supports and who is signed in, then load their songs.
  provider.init().then(({ health, me }) => {
    state.health = health;
    state.me = me;
    if (health) state.versions = health.versionsPerRequest || state.versions;
    renderComposer();
  }).catch((err) => {
    console.error('Could not reach the backend:', err);
  }).finally(refreshSongs);

  renderComposer();
  renderLibrary();
})();
