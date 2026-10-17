// Song generation provider.
//
// The UI calls `window.SongProvider.generate(request)` and expects a Promise
// that resolves to an array of songs:
//   { title, tags, duration (seconds), audioUrl (optional) }
//
// `request` looks like:
//   { prompt, style, genres[], mood, instruments[], lyricMode: 'auto'|'custom'|'none',
//     lyrics, voice, tempo, length }
//
// The default implementation below is a mock: it waits briefly and returns two
// silent placeholder songs. To produce real music, replace `generate` with a
// call to your own backend, which in turn calls a music-generation API. Never
// put API keys in this file: it is served to every visitor.

(function () {
  const STOP = ['the', 'and', 'for', 'with', 'after', 'about', 'from', 'into', 'that', 'this', 'last', 'by', 'through', 'late'];

  function titleFrom(prompt) {
    const words = prompt.replace(/[^A-Za-z\s'-]/g, ' ').split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.includes(w.toLowerCase())).slice(0, 3);
    if (!words.length) return 'Untitled';
    return words.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ');
  }

  async function mockGenerate(req) {
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

  // Example of a real provider, calling your own server endpoint:
  //
  // async function serverGenerate(req) {
  //   const res = await fetch('/api/generate', {
  //     method: 'POST',
  //     headers: { 'Content-Type': 'application/json' },
  //     body: JSON.stringify(req)
  //   });
  //   if (!res.ok) throw new Error('Generation failed: ' + res.status);
  //   return res.json();
  // }

  window.SongProvider = { generate: mockGenerate };
})();
