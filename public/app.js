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
  const COST = 10;

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
    credits: 50,
    generating: false,
    newIds: [],
    currentId: null,
    playing: false,
    pos: 0,
    tracks: [
      { id: 't3', title: 'Neon Over Westlands', tags: 'Afrobeats · R&B · Bittersweet · 104 BPM', duration: 178, cover: COVERS[0], seed: 7 },
      { id: 't2', title: 'Saltwater Letters', tags: 'Folk · Melancholic · 82 BPM', duration: 154, cover: COVERS[1], seed: 19 },
      { id: 't1', title: 'Rooftop Static', tags: 'Lo-fi · House · Chill · 120 BPM · Instrumental', duration: 203, cover: COVERS[2], seed: 31 }
    ]
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
    $('credits').textContent = state.credits;

    const btn = $('generate');
    btn.disabled = state.generating || !state.prompt.trim() || state.credits < COST;
    btn.classList.toggle('busy', state.generating);
    $('generate-label').textContent = state.generating ? 'Composing…' : state.credits < COST ? 'Out of credits' : 'Generate song';
  }

  // ---------- Library ----------

  const PLAY_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9.5-5.5z" fill="currentColor"/></svg>';
  const PAUSE_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="2" width="3.5" height="12" rx="1" fill="currentColor"/><rect x="9.5" y="2" width="3.5" height="12" rx="1" fill="currentColor"/></svg>';
  const COVER_SVG = '<svg width="84" height="84" viewBox="0 0 84 84" fill="none" aria-hidden="true"><circle cx="62" cy="22" r="30" stroke="#0E0F12" stroke-opacity=".22" stroke-width="2"/><circle cx="62" cy="22" r="18" stroke="#0E0F12" stroke-opacity=".22" stroke-width="2"/><circle cx="62" cy="22" r="6" fill="#0E0F12" fill-opacity=".3"/></svg>';
  const ACTIONS = [
    ['Extend this song', '<path d="M4 12h12M12 6l6 6-6 6M20 5v14"/>'],
    ['Remix with new style', '<path d="M4 7h11l-3-3M20 17H9l3 3M18 7a4 4 0 0 1 2 3.5M6 17a4 4 0 0 1-2-3.5"/>'],
    ['Download', '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>']
  ];

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

    const actions = el('div', { class: 'actions' }, ACTIONS.map(([label, path]) => {
      const icon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + path + '</svg>';
      if (label === 'Download' && t.audioUrl) {
        return el('a', { class: 'icon-btn', href: t.audioUrl, download: t.title + '.mp3', 'aria-label': 'Download ' + t.title, title: label, html: icon });
      }
      return el('button', { type: 'button', class: 'icon-btn', 'aria-label': label, title: label, html: icon });
    }));

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
    $('pending').replaceChildren(...(state.generating ? [pendingCard('version A'), pendingCard('version B')] : []));
    $('tracks').replaceChildren(...state.tracks.map(trackCard));
    $('track-count').textContent = state.tracks.length;
  }

  // ---------- Generate ----------

  async function generate() {
    if (state.generating || !state.prompt.trim() || state.credits < COST) return;
    state.generating = true;
    renderComposer();
    renderLibrary();
    try {
      const songs = await window.SongProvider.generate({
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
      });
      const now = Date.now();
      const made = songs.map((s, k) => ({
        id: 'g' + now + k,
        title: s.title,
        tags: s.tags,
        duration: s.duration,
        audioUrl: s.audioUrl || null,
        cover: COVERS[(state.tracks.length + k) % COVERS.length],
        seed: (now % 1000) + k * 13
      }));
      state.tracks = made.concat(state.tracks);
      state.newIds = made.map((m) => m.id);
      state.credits -= COST;
    } catch (err) {
      alert(err.message || 'Something went wrong while generating.');
    } finally {
      state.generating = false;
      renderComposer();
      renderLibrary();
    }
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
  $('lyrics').addEventListener('input', (e) => { state.lyrics = e.target.value; });
  $('tempo').value = state.tempo;
  $('tempo').addEventListener('input', (e) => { state.tempo = Number(e.target.value); renderComposer(); });
  $('generate').addEventListener('click', generate);

  renderComposer();
  renderLibrary();
})();
