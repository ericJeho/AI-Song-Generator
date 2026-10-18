// MiniMax Music provider.
// Docs: https://platform.minimax.io/docs (Music Generation)
//
// Set MINIMAX_API_KEY. MINIMAX_MUSIC_MODEL picks the model; MINIMAX_BASE_URL is
// only for testing against a stand-in.

const BASE_URL = (process.env.MINIMAX_BASE_URL || 'https://api.minimax.io').replace(/\/$/, '');
const MODEL = process.env.MINIMAX_MUSIC_MODEL || 'music-2.6';
const TIMEOUT_MS = 5 * 60 * 1000;

// MiniMax takes the style as `prompt` and the words as `lyrics`.
function buildRequest(req) {
  const style = [req.mood, ...req.genres].filter(Boolean).join(', ').toLowerCase() || 'modern';
  const parts = [`${style}, ${req.tempo} BPM`];
  if (req.instruments.length) parts.push(req.instruments.join(', ').toLowerCase());
  if (req.lyricMode === 'none') parts.push('instrumental, no vocals');
  else parts.push(req.voice === 'Duet' ? 'male and female duet vocals' : `${req.voice.toLowerCase()} vocals`);
  parts.push(`about: ${req.prompt}`);

  const body = {
    model: MODEL,
    prompt: parts.join('; ').slice(0, 2000),
    audio_setting: { sample_rate: 44100, bitrate: 256000, format: 'mp3' },
    output_format: 'hex'
  };
  if (req.lyricMode === 'custom') body.lyrics = req.lyrics;
  else if (req.lyricMode === 'none') body.lyrics = '[Instrumental]';
  else body.lyrics_optimizer = true; // MiniMax writes lyrics from the prompt
  return body;
}

async function generate(req) {
  const res = await fetch(`${BASE_URL}/v1/music_generation`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.MINIMAX_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildRequest(req)),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });

  const data = await res.json().catch(() => null);
  const code = data && data.base_resp ? data.base_resp.status_code : null;
  if (!res.ok || code !== 0) {
    const detail = data && data.base_resp ? `${code} ${data.base_resp.status_msg}` : `HTTP ${res.status}`;
    const err = new Error('MiniMax ' + detail);
    if (res.status === 401 || code === 1004) err.publicMessage = 'The server’s music API key was rejected.';
    else if (code === 1008) err.publicMessage = 'The music API account is out of balance.';
    else if (res.status === 429 || code === 1002) err.publicMessage = 'The music service is busy. Try again in a minute.';
    else if (code === 1026 || code === 2013) err.publicMessage = 'The music service declined this prompt. Try rewording it.';
    throw err;
  }

  const audio = data.data && data.data.audio;
  if (!audio) throw new Error('MiniMax returned no audio');
  // `audio` is hex-encoded MP3 data, or a download link if the account returns URLs.
  if (/^https?:\/\//.test(audio)) {
    const file = await fetch(audio, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!file.ok) throw new Error('MiniMax audio download failed: ' + file.status);
    return { audio: Buffer.from(await file.arrayBuffer()), extension: '.mp3' };
  }
  return { audio: Buffer.from(audio, 'hex'), extension: '.mp3' };
}

module.exports = { name: 'minimax', generate, buildRequest };
