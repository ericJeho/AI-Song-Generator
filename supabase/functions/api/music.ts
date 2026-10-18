// Request validation and the music providers (ElevenLabs, MiniMax, demo).

export const GENRES = ['Pop', 'Hip-Hop', 'Afrobeats', 'Amapiano', 'R&B', 'Lo-fi', 'House', 'Rock', 'Jazz', 'Synthwave', 'Folk', 'Cinematic'];
export const MOODS = ['Euphoric', 'Bittersweet', 'Chill', 'Melancholic', 'Dark', 'Romantic', 'Energetic', 'Dreamy'];
export const INSTRUMENTS = ['Piano', 'Acoustic guitar', 'Electric guitar', '808s', 'Synth pads', 'Strings', 'Saxophone', 'Talking drum', 'Bass', 'Brass'];
const VOICES = ['Female', 'Male', 'Duet'];
const LYRIC_MODES = ['auto', 'custom', 'none'] as const;

export type SongRequest = {
  prompt: string;
  genres: string[];
  mood: string | null;
  instruments: string[];
  lyricMode: 'auto' | 'custom' | 'none';
  lyrics: string;
  voice: string | null;
  tempo: number;
  length: number;
};

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// An error whose message is safe to show to the person using the app.
export class PublicError extends Error {
  constructor(public publicMessage: string, detail: string, public status = 502) {
    super(detail);
  }
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = parseInt(String(value), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function pickList(value: unknown, allowed: string[], max: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((v) => allowed.includes(v)))].slice(0, max);
}

// Any genre the visitor types: printable text only, at most 40 characters each, up to 3, no duplicates.
// Known genres keep their usual spelling ('afrobeats' -> 'Afrobeats').
export function cleanGenres(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== 'string') continue;
    // deno-lint-ignore no-control-regex
    const text = v.replace(/[<>\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!text) continue;
    const name = GENRES.find((g) => g.toLowerCase() === text.toLowerCase()) ?? text;
    if (!out.some((g) => g.toLowerCase() === name.toLowerCase())) out.push(name);
    if (out.length === 3) break;
  }
  return out;
}

// deno-lint-ignore no-explicit-any
export function validate(body: any, { needLyrics = true } = {}): SongRequest {
  const prompt = String(body?.prompt ?? '').trim().slice(0, 300);
  if (!prompt) throw new HttpError(400, 'Describe your song first.');
  const lyricMode = LYRIC_MODES.includes(body.lyricMode) ? body.lyricMode : 'auto';
  const lyrics = lyricMode === 'custom' ? String(body.lyrics ?? '').trim().slice(0, 3000) : '';
  if (needLyrics && lyricMode === 'custom' && !lyrics) throw new HttpError(400, 'Add your lyrics, or pick another lyrics option.');
  return {
    prompt,
    genres: cleanGenres(body.genres),
    mood: MOODS.includes(body.mood) ? body.mood : null,
    instruments: pickList(body.instruments, INSTRUMENTS, INSTRUMENTS.length),
    lyricMode,
    lyrics,
    voice: lyricMode === 'none' ? null : VOICES.includes(body.voice) ? body.voice : 'Female',
    tempo: clampInt(body.tempo, 60, 180, 104),
    length: clampInt(body.length, 30, 300, 180),
  };
}

const STOP = ['the', 'and', 'for', 'with', 'after', 'about', 'from', 'into', 'that', 'this', 'last', 'by', 'through', 'late'];
export function titleFrom(prompt: string): string {
  const words = prompt.replace(/[^A-Za-z\s'-]/g, ' ').split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.includes(w.toLowerCase())).slice(0, 3);
  if (!words.length) return 'Untitled';
  return words.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

export function tagsFor(req: SongRequest): string {
  const tags = [];
  if (req.genres.length) tags.push(req.genres.join(' · '));
  if (req.mood) tags.push(req.mood);
  tags.push(req.tempo + ' BPM');
  if (req.lyricMode === 'none') tags.push('Instrumental');
  return tags.join(' · ');
}

export type MusicProvider = {
  name: string;
  generate(req: SongRequest): Promise<Uint8Array | null>;
};

const TIMEOUT_MS = 140_000;

// ---------- ElevenLabs ----------

export function elevenLabsPrompt(req: SongRequest): string {
  const lines = [];
  const style = [req.mood, ...req.genres].filter(Boolean).join(' ').toLowerCase();
  lines.push(`A ${style || 'modern'} song at ${req.tempo} BPM.`);
  lines.push(`Theme: ${req.prompt}`);
  if (req.instruments.length) lines.push(`Instrumentation: ${req.instruments.join(', ').toLowerCase()}.`);
  if (req.lyricMode === 'none') {
    lines.push('Instrumental only, no vocals.');
  } else {
    const voice = req.voice === 'Duet' ? 'a male and female vocal duet' : `a ${String(req.voice).toLowerCase()} lead vocalist`;
    if (req.lyricMode === 'custom') {
      lines.push(`Sung by ${voice}, using exactly these lyrics:`);
      lines.push(req.lyrics);
    } else {
      lines.push(`Sung by ${voice}, with original lyrics about the theme.`);
    }
  }
  return lines.join('\n');
}

export function elevenLabs(apiKey: string, baseUrl = 'https://api.elevenlabs.io', model = 'music_v1'): MusicProvider {
  return {
    name: 'elevenlabs',
    async generate(req) {
      const body: Record<string, unknown> = {
        prompt: elevenLabsPrompt(req),
        music_length_ms: Math.min(300000, Math.max(10000, req.length * 1000)),
        model_id: model,
      };
      if (req.lyricMode === 'none') body.force_instrumental = true;
      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/music?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        const detail = `ElevenLabs ${res.status}: ${(await res.text().catch(() => '')).slice(0, 500)}`;
        if (res.status === 401) throw new PublicError('The music API key was rejected.', detail);
        if (res.status === 402) throw new PublicError('The music API account is out of credits, or its plan does not include music.', detail);
        if (res.status === 400 || res.status === 422) throw new PublicError('The music service declined this prompt. Try rewording it (avoid naming real artists or copyrighted lyrics).', detail);
        if (res.status === 429) throw new PublicError('The music service is busy. Try again in a minute.', detail);
        throw new Error(detail);
      }
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}

// ---------- MiniMax ----------

export function miniMaxBody(req: SongRequest, model: string): Record<string, unknown> {
  const style = [req.mood, ...req.genres].filter(Boolean).join(', ').toLowerCase() || 'modern';
  const parts = [`${style}, ${req.tempo} BPM`];
  if (req.instruments.length) parts.push(req.instruments.join(', ').toLowerCase());
  if (req.lyricMode === 'none') parts.push('instrumental, no vocals');
  else parts.push(req.voice === 'Duet' ? 'male and female duet vocals' : `${String(req.voice).toLowerCase()} vocals`);
  parts.push(`about: ${req.prompt}`);

  const body: Record<string, unknown> = {
    model,
    prompt: parts.join('; ').slice(0, 2000),
    audio_setting: { sample_rate: 44100, bitrate: 256000, format: 'mp3' },
    output_format: 'hex',
  };
  if (req.lyricMode === 'custom') body.lyrics = req.lyrics;
  else if (req.lyricMode === 'none') body.lyrics = '[Instrumental]';
  else body.lyrics_optimizer = true; // MiniMax writes lyrics from the prompt
  return body;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export function miniMax(apiKey: string, baseUrl = 'https://api.minimax.io', model = 'music-2.6'): MusicProvider {
  return {
    name: 'minimax',
    async generate(req) {
      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/music_generation`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(miniMaxBody(req, model)),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const data = await res.json().catch(() => null);
      const code = data?.base_resp?.status_code ?? null;
      if (!res.ok || code !== 0) {
        const detail = 'MiniMax ' + (data?.base_resp ? `${code} ${data.base_resp.status_msg}` : `HTTP ${res.status}`);
        if (res.status === 401 || code === 1004) throw new PublicError('The music API key was rejected.', detail);
        if (code === 1008) throw new PublicError('The music API account is out of balance.', detail);
        if (res.status === 429 || code === 1002) throw new PublicError('The music service is busy. Try again in a minute.', detail);
        if (code === 1026 || code === 2013) throw new PublicError('The music service declined this prompt. Try rewording it.', detail);
        throw new Error(detail);
      }
      const audio = data?.data?.audio;
      if (!audio) throw new Error('MiniMax returned no audio');
      if (/^https?:\/\//.test(audio)) {
        const file = await fetch(audio, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!file.ok) throw new Error('MiniMax audio download failed: ' + file.status);
        return new Uint8Array(await file.arrayBuffer());
      }
      return hexToBytes(audio);
    },
  };
}

// ---------- Demo ----------

export const demo: MusicProvider = {
  name: 'mock',
  async generate() {
    await new Promise((r) => setTimeout(r, 1500));
    return null;
  },
};

export function pickProvider(env: (name: string) => string | undefined): MusicProvider {
  const choice = (env('MUSIC_PROVIDER') ?? '').toLowerCase();
  const eleven = env('ELEVENLABS_API_KEY');
  const mini = env('MINIMAX_API_KEY');
  if (choice === 'mock') return demo;
  if ((choice === 'minimax' || (!choice && !eleven)) && mini) {
    return miniMax(mini, env('MINIMAX_BASE_URL'), env('MINIMAX_MUSIC_MODEL'));
  }
  if (eleven) return elevenLabs(eleven, env('ELEVENLABS_BASE_URL'), env('ELEVENLABS_MUSIC_MODEL'));
  return demo;
}
