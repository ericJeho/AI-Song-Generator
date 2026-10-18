// Talks to this site's own server (server.js), which holds the API keys.
//
// SongProvider.generate(request) resolves to { songs: [...], user } where each song is
//   { title, tags, duration (seconds), audioUrl (or null) }.
// SongProvider.draftLyrics(request) resolves to { lyrics, user }.
// Failed calls reject with an Error carrying `status` (401 means "sign in first").
//
// When the page is opened without the server (GitHub Pages, or straight from disk),
// generate() falls back to a demo that returns silent placeholder songs.

(function () {
  const STOP = ['the', 'and', 'for', 'with', 'after', 'about', 'from', 'into', 'that', 'this', 'last', 'by', 'through', 'late'];

  function titleFrom(prompt) {
    const words = prompt.replace(/[^A-Za-z\s'-]/g, ' ').split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.includes(w.toLowerCase())).slice(0, 3);
    if (!words.length) return 'Untitled';
    return words.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ');
  }

  async function demoGenerate(req) {
    await new Promise((r) => setTimeout(r, 2400));
    const tags = [];
    if (req.genres.length) tags.push(req.genres.join(' · '));
    if (req.mood) tags.push(req.mood);
    tags.push(req.tempo + ' BPM');
    if (req.lyricMode === 'none') tags.push('Instrumental');
    const base = titleFrom(req.prompt);
    return {
      user: null,
      songs: [0, 1].map((k) => ({
        title: k === 0 ? base : base + ' (Alt Take)',
        tags: tags.join(' · '),
        duration: Math.max(40, req.length - 6 + k * 9),
        audioUrl: null
      }))
    };
  }

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      throw Object.assign(new Error((data && data.error) || 'Request failed (' + res.status + ').'), { status: res.status, noServer: !data });
    }
    return data;
  }

  async function generate(req) {
    try {
      return await postJson('api/generate', req);
    } catch (err) {
      // No server behind this page (offline, file://, or static hosting): use the demo.
      if (err instanceof TypeError || err.noServer) return demoGenerate(req);
      throw err;
    }
  }

  window.SongProvider = {
    generate,
    draftLyrics: (req) => postJson('api/lyrics', req),
    signIn: (body) => postJson('api/login', body),
    signUp: (body) => postJson('api/signup', body),
    signOut: () => postJson('api/logout', {})
  };
})();
