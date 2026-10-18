(function () {
  const GENRES = ['Pop', 'Hip-Hop', 'Afrobeats', 'Amapiano', 'R&B', 'Lo-fi', 'House', 'Rock', 'Jazz', 'Synthwave', 'Folk', 'Cinematic'];
  const MOODS = [
    ['Euphoric', 'big, bright, lifted'], ['Bittersweet', 'happy-sad'], ['Chill', 'laid-back, warm'], ['Melancholic', 'slow ache'],
    ['Dark', 'tense, brooding'], ['Romantic', 'tender, close'], ['Energetic', 'driving, loud'], ['Dreamy', 'hazy, floating']
  ];
  const INSTRUMENTS = ['Piano', 'Acoustic guitar', 'Electric guitar', '808s', 'Synth pads', 'Strings', 'Saxophone', 'Talking drum', 'Bass', 'Brass'];
  const LYRIC_MODES = [['auto', 'Write for me'], ['custom', 'My lyrics'], ['none', 'Instrumental']];
  const VOICES = ['Female', 'Male', 'Duet'];
  const LENGTHS = [60, 120, 180, 240];
  const SUGGESTIONS = [
    'Rainy Lagos morning, slow and soulful',
    'Stadium anthem about never giving up',
    'Lullaby for a robot learning to dream'
  ];
  const COVERS = ['#FF9A62', '#5EC8B8', '#B69CFF', '#F2C14E', '#7DA2FF', '#F27BA6'];
  const STORAGE_KEY = 'cadence.library.v1';
  const SETTINGS = ['prompt', 'genres', 'mood', 'instruments', 'lyricMode', 'voice', 'lyrics', 'tempo', 'length'];

  // The song list is kept in this browser only, so visitors never see each other's songs.
  function loadLibrary() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      return Array.isArray(saved) ? saved.filter((t) => t && t.id && t.title) : [];
    } catch {
      return [];
    }
  }

  function saveLibrary() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.tracks));
    } catch {
      // Storage full or blocked: the list still works until the page is closed.
    }
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
    generating: false,
    drafting: false,
    health: null, // what the server supports, from /api/health (null without a server)
    me: null, // the signed-in user
    versions: 2,
    newIds: [],
    currentId: null,
    playing: false,
    pos: 0,
    tracks: loadLibrary()
  };

  const $ = (id) => document.getElementById(id);
  const audio = new Audio();

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

  function renderComposer() {
    renderToggleGroup($('genres'), GENRES, (g) => state.genres.includes(g), (g) => {
      if (state.genres.includes(g)) state.genres = state.genres.filter((x) => x !== g);
      else if (state.genres.length < 3) state.genres = state.genres.concat(g);
      renderComposer();
    }, 'chip');

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

    const btn = $('generate');
    const outOfSongs = state.me && state.me.songsLeftToday < 1;
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

  function removeTrack(t) {
    if (!confirm('Remove “' + t.title + '” from your songs?')) return;
    if (state.currentId === t.id) {
      audio.pause();
      state.currentId = null;
      state.playing = false;
    }
    state.tracks = state.tracks.filter((x) => x.id !== t.id);
    saveLibrary();
    renderLibrary();
  }

  function initials(title) {
    return title.split(' ').filter((w) => /[A-Za-z]/.test(w[0])).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  }

  function togglePlay(t) {
    if (state.currentId === t.id) {
      state.playing = !state.playing;
    } else {
      audio.pause();
      state.currentId = t.id;
      state.pos = 0;
      state.playing = true;
      if (t.audioUrl) audio.src = t.audioUrl;
      else audio.removeAttribute('src');
    }
    if (t.audioUrl) {
      if (state.playing) audio.play().catch(() => { state.playing = false; renderLibrary(); });
      else audio.pause();
    }
    renderLibrary();
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
    if (t.audioUrl) audio.currentTime = state.pos;
    renderLibrary();
  }

  function trackCard(t) {
    const isCur = state.currentId === t.id;
    const isPlaying = isCur && state.playing;
    const frac = isCur ? state.pos / t.duration : 0;

    const cover = el('div', { class: 'cover', style: 'background:' + t.cover, html: COVER_SVG }, [el('span', { text: initials(t.title) })]);

    const titleRow = el('div', { class: 'title-row' }, [el('h3', { text: t.title })]);
    if (state.newIds.includes(t.id)) titleRow.append(el('span', { class: 'badge', text: 'New' }));

    const hs = bars(t.seed);
    const wave = el('div', { class: 'wave', 'aria-hidden': 'true', onclick: (e) => seek(t, e) },
      hs.map((h, i) => el('span', { style: 'height:' + h + '%', class: isCur && i / hs.length < frac ? 'played' : '' })));

    const player = el('div', { class: 'player' }, [
      el('button', { type: 'button', class: 'play', 'aria-label': (isPlaying ? 'Pause ' : 'Play ') + t.title, html: isPlaying ? PAUSE_SVG : PLAY_SVG, onclick: () => togglePlay(t) }),
      wave,
      el('span', { class: 'time', text: (isCur ? fmt(state.pos) + ' / ' : '') + fmt(t.duration) })
    ]);

    const actions = el('div', { class: 'actions' });
    if (t.request) {
      actions.append(el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Remix: load these settings', title: 'Remix', html: REMIX_ICON, onclick: () => remix(t) }));
    }
    if (t.audioUrl) {
      actions.append(el('a', { class: 'icon-btn', href: t.audioUrl, download: t.title + '.mp3', 'aria-label': 'Download ' + t.title, title: 'Download', html: DOWNLOAD_ICON }));
    }
    actions.append(el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Remove ' + t.title, title: 'Remove', html: DELETE_ICON, onclick: () => removeTrack(t) }));

    return el('article', { class: 'card' + (isCur ? ' current' : '') }, [
      cover,
      el('div', { class: 'meta' }, [titleRow, el('span', { class: 'tags', text: t.tags }), player]),
      actions
    ]);
  }

  function pendingCard(label) {
    return el('div', { class: 'card pending' }, [
      el('div', { class: 'skel', style: 'width:84px;height:84px;border-radius:14px;flex:none' }),
      el('div', { class: 'meta', style: 'gap:10px' }, [
        el('span', { style: 'font-weight:600', text: 'Composing ' + label + '… this can take a minute or two' }),
        el('div', { class: 'skel', style: 'height:10px;width:70%' }),
        el('div', { class: 'skel', style: 'height:28px;width:100%;background:#22252C' })
      ])
    ]);
  }

  function renderLibrary() {
    const count = state.me ? Math.min(state.versions, Math.max(1, state.me.songsLeftToday)) : state.versions;
    const pending = state.generating ? 'ABCD'.slice(0, count).split('').map((l) => pendingCard('version ' + l)) : [];
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
    try {
      const result = await window.SongProvider.generate(request);
      if (result.user) state.me = result.user;
      const now = Date.now();
      const made = result.songs.map((s, k) => ({
        id: 'g' + now + k,
        title: s.title,
        tags: s.audioUrl ? s.tags : s.tags + ' · Demo (silent)',
        duration: s.duration,
        audioUrl: s.audioUrl || null,
        cover: COVERS[(state.tracks.length + k) % COVERS.length],
        seed: (now % 1000) + k * 13,
        createdAt: new Date(now).toISOString(),
        request: request
      }));
      state.tracks = made.concat(state.tracks);
      state.newIds = made.map((m) => m.id);
      saveLibrary();
    } catch (err) {
      if (err.status === 401) {
        state.me = null;
        openAuth('signin');
      } else {
        alert(err.message || 'Something went wrong while generating.');
      }
    } finally {
      state.generating = false;
      renderComposer();
      renderLibrary();
    }
  }

  async function draftLyrics() {
    if (needsSignIn()) return openAuth('signin');
    state.drafting = true;
    $('lyrics-error').hidden = true;
    renderComposer();
    try {
      const result = await window.SongProvider.draftLyrics(currentRequest());
      if (result.user) state.me = result.user;
      state.lyrics = result.lyrics;
    } catch (err) {
      if (err.status === 401) {
        state.me = null;
        openAuth('signin');
      } else {
        $('lyrics-error').textContent = err.message;
        $('lyrics-error').hidden = false;
      }
    } finally {
      state.drafting = false;
      renderComposer();
    }
  }

  // ---------- Account ----------

  function needsSignIn() {
    return Boolean(state.health && state.health.requireLogin && !state.me);
  }

  function renderAccount() {
    const usesAccounts = Boolean(state.health && state.health.requireLogin);
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
      const result = authMode === 'signup' ? await window.SongProvider.signUp(body) : await window.SongProvider.signIn(body);
      state.me = result.user;
      $('auth-password').value = '';
      $('auth-dialog').close();
      renderComposer();
    } catch (err) {
      $('auth-error').textContent = err.message;
      $('auth-error').hidden = false;
    } finally {
      $('auth-submit').disabled = false;
    }
  }

  async function signOut() {
    try {
      await window.SongProvider.signOut();
    } catch {
      // Signed out locally either way.
    }
    state.me = null;
    renderComposer();
  }

  // ---------- Playback clock ----------

  setInterval(() => {
    if (!state.playing) return;
    const t = state.tracks.find((x) => x.id === state.currentId);
    if (!t) return;
    state.pos = t.audioUrl ? audio.currentTime : state.pos + 0.25;
    if (!t.audioUrl && state.pos >= t.duration) {
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
  $('draft-lyrics').addEventListener('click', draftLyrics);
  $('sign-in-btn').addEventListener('click', () => openAuth('signin'));
  $('sign-out-btn').addEventListener('click', signOut);
  $('mode-signin').addEventListener('click', () => setAuthMode('signin'));
  $('mode-signup').addEventListener('click', () => setAuthMode('signup'));
  $('auth-close').addEventListener('click', () => $('auth-dialog').close());
  $('auth-form').addEventListener('submit', submitAuth);

  // Ask the server what it supports and who is signed in. Without a server, the demo runs.
  Promise.all([
    fetch('api/health').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch('api/me').then((r) => (r.ok ? r.json() : null)).catch(() => null)
  ]).then(([health, me]) => {
    if (!health || !health.ok) return;
    state.health = health;
    state.me = me && me.user;
    state.versions = health.versionsPerRequest || state.versions;
    $('versions-note').textContent = 'Creates ' + state.versions + (state.versions === 1 ? ' version' : ' versions') +
      (health.provider === 'mock' ? ' · demo mode, songs are silent' : '');
    renderComposer();
  });

  renderComposer();
  renderLibrary();
})();
