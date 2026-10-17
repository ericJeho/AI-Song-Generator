# Cadence — AI song generator

Turn a short text prompt into a full song, with controls for:

- **Genre**: up to 3 of 12 (Pop, Hip-Hop, Afrobeats, Amapiano, R&B, Lo-fi, House, Rock, Jazz, Synthwave, Folk, Cinematic)
- **Mood**: Euphoric, Bittersweet, Chill, Melancholic, Dark, Romantic, Energetic, Dreamy
- **Instruments**: piano, guitars, 808s, synth pads, strings, saxophone, talking drum, bass, brass
- **Lyrics**: AI-written, your own lyrics, or instrumental; female, male or duet vocals
- **Tempo** (60–180 BPM) and **length** (1–4 minutes)

Songs are generated with the [ElevenLabs Music API](https://elevenlabs.io/docs/api-reference/music/compose). Each click makes two versions, which appear in the song list where they can be played and downloaded as MP3.

## Run it

Requires Node 18 or newer. There are no packages to install.

```sh
cp .env.example .env      # then put your ElevenLabs API key in .env
npm start                 # open http://localhost:8000
```

Without a key, the app runs in **demo mode**: everything works, but songs are silent placeholders and no credits are spent.

### Getting an API key

1. Create an account at elevenlabs.io and choose a plan that includes music generation.
2. Create an API key in your account's developer settings.
3. Paste it into `.env` as `ELEVENLABS_API_KEY=…`.

Each song is one paid API call, so one click costs two songs by default. Lower `VERSIONS_PER_REQUEST` in `.env` to 1 to halve that. `RATE_LIMIT_PER_HOUR` caps how many generate requests each visitor can make (default 20).

## How it works

```
browser (public/)  ──POST /api/generate──▶  server.js  ──▶  ElevenLabs /v1/music
       ▲                                        │
       └──────── /audio/<id>.mp3 ◀──── saves MP3 to generated/
```

- `server.js` validates the request (only known genres, moods and instruments; prompt ≤300 characters, lyrics ≤3000), turns the choices into a music prompt, calls the provider and saves the returned MP3.
- The API key stays on the server. It is never sent to the browser.
- `providers/elevenlabs.js` builds the prompt and calls the API. To use a different music service, add another file in `providers/` with the same `generate(request) → { audio, extension }` shape and select it in `server.js`.

## Deploying

GitHub Pages only serves static files, so it can show the demo but cannot generate real songs. To go live, deploy the whole repository to a Node host.

**Render (set up in this repo):** in the Render dashboard choose **New › Blueprint**, pick this repository, and paste your ElevenLabs key when asked. `render.yaml` creates the web service, a health check and a 1 GB disk so songs survive redeploys (disks need a paid instance).

**Any other Node host** (Railway, Fly.io, a VPS):

- Start command: `npm start`
- Environment variable: `ELEVENLABS_API_KEY`
- Generated songs are saved in `generated/` (or `AUDIO_DIR`). On hosts with temporary disks they are lost on redeploy unless you attach a persistent disk.

## Files

| File | Purpose |
| --- | --- |
| `server.js` | Web server, `/api/generate`, input checks, rate limit, audio storage |
| `providers/elevenlabs.js` | ElevenLabs Music API call and prompt building |
| `providers/mock.js` | Demo mode when no key is set |
| `public/index.html` | Page structure |
| `public/styles.css` | Visual design (colours and fonts are CSS variables in `:root`) |
| `public/app.js` | Composer controls, song list, playback, download |
| `public/provider.js` | Browser side of generation; falls back to demo mode without the server |
| `.env.example` | Settings template |
| `render.yaml` | One-click deploy to Render |
