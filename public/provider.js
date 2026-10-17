// Song generation provider.
//
// The UI calls `window.SongProvider.generate(request)` and expects a Promise
// that resolves to an array of songs:
//   { title, tags, duration (seconds), audioUrl (or null) }
//
// It posts the request to this site's own server (server.js), which holds the
// music API key and calls the music service. When the page is opened without
// that server (for example from GitHub Pages or straight from disk), it falls
// back to a demo that returns silent placeholder songs.

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
    return [0, 1].map((k) => ({
      title: k === 0 ? base : base + ' (Alt Take)',
      tags: tags.join(' · '),
      duration: Math.max(40, req.length - 6 + k * 9),
      audioUrl: null
    }));
  }

  async function serverGenerate(req) {
    let res;
    try {
      res = await fetch('api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req)
      });
    } catch {
      return demoGenerate(req); // no server reachable (file:// or offline)
    }
    if (res.status === 404 || res.status === 405) return demoGenerate(req); // static hosting, no API
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && data.error) || 'Generation failed (' + res.status + ').');
    return data;
  }

  window.SongProvider = { generate: serverGenerate };
})();
