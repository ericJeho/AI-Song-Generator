// Lyrics helper: drafts song lyrics from the composer's description with the Claude API.
// Set ANTHROPIC_API_KEY to enable it. ANTHROPIC_BASE_URL is only for testing.

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.LYRICS_MODEL || 'claude-opus-5-5';

const SYSTEM = `You write original song lyrics for an AI music generator.
Write lyrics only: no title, no commentary, no notes about the music.
Mark each section with a tag on its own line, such as [Verse 1], [Pre-Chorus], [Chorus], [Bridge], [Outro].
Match the requested length: about 1 verse and 1 chorus per minute of song, up to 3,000 characters in total.
Keep lines singable: short, concrete images, a chorus that repeats.
Never quote or closely imitate existing songs, and never name real artists.`;

let client;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

function describe(req) {
  const lines = [`Song description: ${req.prompt}`];
  if (req.genres.length) lines.push(`Genre: ${req.genres.join(', ')}`);
  if (req.mood) lines.push(`Mood: ${req.mood}`);
  lines.push(`Tempo: ${req.tempo} BPM`);
  lines.push(`Length: about ${Math.round(req.length / 60)} minute(s)`);
  lines.push(`Sung by: ${req.voice === 'Duet' ? 'a male and female duet (label who sings each section)' : `a ${req.voice.toLowerCase()} vocalist`}`);
  return lines.join('\n');
}

async function draftLyrics(req) {
  let response;
  try {
    response = await getClient().beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: 'medium' },
      // If a request is declined, the API retries it on a suitable fallback model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM,
      messages: [{ role: 'user', content: describe(req) }]
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) err.publicMessage = 'The server’s lyrics API key was rejected.';
    else if (err instanceof Anthropic.RateLimitError) err.publicMessage = 'The lyrics helper is busy. Try again in a minute.';
    throw err;
  }

  if (response.stop_reason === 'refusal') {
    throw Object.assign(new Error('Lyrics request refused'), { status: 400, publicMessage: 'The lyrics helper declined this description. Try rewording it.' });
  }
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  if (!text) throw new Error('Lyrics helper returned no text');
  return text.slice(0, 3000);
}

module.exports = { draftLyrics, describe };
