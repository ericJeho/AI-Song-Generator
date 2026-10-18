// Lyrics helper: drafts song lyrics from the composer's description with the Claude API.

import Anthropic from 'npm:@anthropic-ai/sdk@0.135.0';
import { PublicError, type SongRequest } from './music.ts';

const SYSTEM = `You write original song lyrics for an AI music generator.
Write lyrics only: no title, no commentary, no notes about the music.
Mark each section with a tag on its own line, such as [Verse 1], [Pre-Chorus], [Chorus], [Bridge], [Outro].
Match the requested length: about 1 verse and 1 chorus per minute of song, up to 3,000 characters in total.
Keep lines singable: short, concrete images, a chorus that repeats.
Never quote or closely imitate existing songs, and never name real artists.`;

export function describe(req: SongRequest): string {
  const lines = [`Song description: ${req.prompt}`];
  if (req.genres.length) lines.push(`Genre: ${req.genres.join(', ')}`);
  if (req.mood) lines.push(`Mood: ${req.mood}`);
  lines.push(`Tempo: ${req.tempo} BPM`);
  lines.push(`Length: about ${Math.round(req.length / 60)} minute(s)`);
  const voice = req.voice ?? 'Female';
  lines.push(`Sung by: ${voice === 'Duet' ? 'a male and female duet (label who sings each section)' : `a ${voice.toLowerCase()} vocalist`}`);
  return lines.join('\n');
}

export type LyricsHelper = (req: SongRequest) => Promise<string>;

export function claudeLyrics(apiKey: string, baseURL?: string, model = 'claude-opus-5-5'): LyricsHelper {
  const client = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
  return async (req) => {
    let response;
    try {
      response = await client.beta.messages.create({
        model,
        max_tokens: 16000,
        output_config: { effort: 'medium' },
        // If a request is declined, the API retries it on a suitable fallback model.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: SYSTEM,
        messages: [{ role: 'user', content: describe(req) }],
        // deno-lint-ignore no-explicit-any
      } as any);
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) throw new PublicError('The lyrics API key was rejected.', String(err));
      if (err instanceof Anthropic.RateLimitError) throw new PublicError('The lyrics helper is busy. Try again in a minute.', String(err));
      throw err;
    }
    if (response.stop_reason === 'refusal') {
      throw new PublicError('The lyrics helper declined this description. Try rewording it.', 'refusal', 400);
    }
    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    if (!text) throw new Error('Lyrics helper returned no text');
    return text.slice(0, 3000);
  };
}
