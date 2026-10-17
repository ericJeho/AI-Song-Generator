// ElevenLabs Music API provider.
// Docs: https://elevenlabs.io/docs/api-reference/music/compose
//
// Sends one compose request and returns the MP3 bytes. Set ELEVENLABS_API_KEY
// in the environment; ELEVENLABS_BASE_URL is only for testing against a stand-in.

const BASE_URL = (process.env.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io').replace(/\/$/, '');
const MODEL_ID = process.env.ELEVENLABS_MUSIC_MODEL || 'music_v1';
const OUTPUT_FORMAT = process.env.ELEVENLABS_OUTPUT_FORMAT || 'mp3_44100_128';
const TIMEOUT_MS = 5 * 60 * 1000;

// Turn the composer's choices into one natural-language music prompt.
function buildPrompt(req) {
  const lines = [];
  const style = [req.mood, ...req.genres].filter(Boolean).join(' ').toLowerCase();
  lines.push(`A ${style || 'modern'} song at ${req.tempo} BPM.`);
  lines.push(`Theme: ${req.prompt}`);
  if (req.instruments.length) lines.push(`Instrumentation: ${req.instruments.join(', ').toLowerCase()}.`);

  if (req.lyricMode === 'none') {
    lines.push('Instrumental only, no vocals.');
  } else {
    const voice = req.voice === 'Duet' ? 'a male and female vocal duet' : `a ${req.voice.toLowerCase()} lead vocalist`;
    if (req.lyricMode === 'custom') {
      lines.push(`Sung by ${voice}, using exactly these lyrics:`);
      lines.push(req.lyrics);
    } else {
      lines.push(`Sung by ${voice}, with original lyrics about the theme.`);
    }
  }
  return lines.join('\n');
}

async function generate(req) {
  const body = {
    prompt: buildPrompt(req),
    music_length_ms: Math.min(300000, Math.max(10000, req.length * 1000)),
    model_id: MODEL_ID
  };
  if (req.lyricMode === 'none') body.force_instrumental = true;

  const res = await fetch(`${BASE_URL}/v1/music?output_format=${encodeURIComponent(OUTPUT_FORMAT)}`, {
    method: 'POST',
    headers: {
      'xi-api-key': process.env.ELEVENLABS_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg'
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const err = new Error(`ElevenLabs ${res.status}: ${detail.slice(0, 500)}`);
    if (res.status === 401) err.publicMessage = 'The server’s music API key was rejected.';
    else if (res.status === 402) err.publicMessage = 'The music API account is out of credits, or its plan does not include music.';
    else if (res.status === 422 || res.status === 400) err.publicMessage = 'The music service declined this prompt. Try rewording it (avoid naming real artists or copyrighted lyrics).';
    else if (res.status === 429) err.publicMessage = 'The music service is busy. Try again in a minute.';
    throw err;
  }

  return { audio: Buffer.from(await res.arrayBuffer()), extension: '.mp3' };
}

module.exports = { name: 'elevenlabs', generate, buildPrompt };
