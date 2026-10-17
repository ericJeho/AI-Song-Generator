// Used when no API key is configured: returns a silent placeholder after a short wait,
// so the app can be tried without spending credits.

async function generate() {
  await new Promise((r) => setTimeout(r, 2000));
  return { audio: null };
}

module.exports = { name: 'mock', generate };
