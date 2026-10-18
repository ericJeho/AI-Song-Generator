# Cadence — AI song generator

Turn a short text prompt into a full song, with controls for:

- **Genre**: up to 3 of 12 (Pop, Hip-Hop, Afrobeats, Amapiano, R&B, Lo-fi, House, Rock, Jazz, Synthwave, Folk, Cinematic)
- **Mood**: Euphoric, Bittersweet, Chill, Melancholic, Dark, Romantic, Energetic, Dreamy
- **Instruments**: piano, guitars, 808s, synth pads, strings, saxophone, talking drum, bass, brass
- **Lyrics**: AI-written by the music model, your own lyrics, or instrumental; female, male or duet vocals
- **Lyrics helper**: "Draft from my description" writes editable lyrics with Claude
- **Tempo** (60–180 BPM) and **length** (1–4 minutes)

Songs are made with **ElevenLabs Music** or **MiniMax Music** (your choice). Each click makes two versions, which appear in the song list where they can be played, downloaded as MP3, removed, or **remixed** (loads that song's settings back into the composer to tweak and regenerate).

Visitors **sign in** to generate, and each account has a **daily song limit**, so strangers can't spend your API balance. An invite code can restrict who may create an account.

Each visitor's song list is saved in their own browser, so visitors never see each other's songs. The MP3s live on the server under unguessable links.

## Run it

Requires Node 18 or newer.

```sh
npm install
cp .env.example .env      # then fill in your keys (see below)
npm start                 # open http://localhost:8000
```

Without a music key, the app runs in **demo mode**: everything works, but songs are silent placeholders and nothing is charged.

### Keys and settings (`.env`)

| Setting | What it does |
| --- | --- |
| `ELEVENLABS_API_KEY` | Music from ElevenLabs (a plan that includes music). |
| `MINIMAX_API_KEY` | Music from MiniMax. If both keys are set, `MUSIC_PROVIDER` picks (`elevenlabs` or `minimax`). |
| `ANTHROPIC_API_KEY` | Turns on the lyrics helper (Claude). Optional. |
| `REQUIRE_LOGIN` | `true` (default): visitors must sign in to generate. |
| `SIGNUP_CODE` | Invite code needed to create an account. **Set this**, or anyone can sign up. |
| `DAILY_SONGS_PER_USER` | Songs each account can make per day (default 10). Each version counts. |
| `DAILY_LYRICS_PER_USER` | Lyric drafts per account per day (default 20). |
| `VERSIONS_PER_REQUEST` | Songs per click (default 2). Each is a separate paid API call. |
| `RATE_LIMIT_PER_HOUR` | Generate requests per visitor IP per hour (default 20). |
| `DATA_DIR` | Where accounts and songs are stored (default `./data`). |

## Accounts

- Passwords are hashed with scrypt; accounts are stored in `DATA_DIR/users.json`.
- Sessions are signed, HTTP-only cookies that last 30 days. The signing key is `SESSION_SECRET`, or a random key saved in `DATA_DIR/session-secret`.
- Sign-in and sign-up attempts are limited to 10 per 15 minutes per IP.
- Daily limits reset at midnight UTC. Failed generations don't count.
- To reset a password or remove an account, edit `users.json` while the server is stopped (delete the user's entry and have them sign up again).

## Tests

```sh
npm test
```

Starts the server against local stand-ins for the ElevenLabs, MiniMax and Claude APIs. Checks sign-up, sign-in, sessions and tampered cookies, invite codes, daily limits, the exact requests each API receives, audio serving, input validation, file-path safety, error messages, demo mode and the rate limit. GitHub Actions runs them on every push.

## How it works

```
browser (public/) ──POST /api/generate──▶ server.js ──▶ ElevenLabs /v1/music
       │          ──POST /api/lyrics────▶    │      ──▶ or MiniMax /v1/music_generation
       │          ──/api/login, signup──▶    │      ──▶ Claude (lyrics helper)
       ▲                                     │
       └────────── /audio/<id>.mp3 ◀──── saves MP3s to DATA_DIR/generated/
```

- `server.js` checks the session and daily limit, validates the request (only known genres, moods and instruments; prompt ≤300 characters, lyrics ≤3000), calls the music provider and saves the MP3.
- API keys stay on the server and are never sent to the browser.
- To add another music service, add a file in `providers/` with the same `generate(request) → { audio, extension }` shape and select it in `pickProvider()` in `server.js`.

## Deploying

GitHub Pages only serves static files, so it can show the demo but cannot generate real songs. Deploy the whole repository to a Node host.

**Render (set up in this repo):** in the Render dashboard choose **New › Blueprint**, pick this repository, and fill in the keys and `SIGNUP_CODE` when asked. `render.yaml` creates the web service, a health check and a 1 GB disk so accounts and songs survive redeploys (disks need a paid instance).

**Any other Node host** (Railway, Fly.io, a VPS):

- Build command: `npm install`; start command: `npm start`
- Set the keys above as environment variables
- Point `DATA_DIR` at a persistent disk, or accounts and songs are lost on redeploy

## Files

| File | Purpose |
| --- | --- |
| `server.js` | Web server, API routes, validation, limits, audio storage |
| `lib/auth.js` | Accounts, password hashing, signed session cookies, daily limits |
| `providers/elevenlabs.js` | ElevenLabs Music API |
| `providers/minimax.js` | MiniMax Music API |
| `providers/lyrics.js` | Lyrics helper (Claude API) |
| `providers/mock.js` | Demo mode when no music key is set |
| `public/index.html` | Page structure and sign-in dialog |
| `public/styles.css` | Visual design (colours and fonts are CSS variables in `:root`) |
| `public/app.js` | Composer, account, lyrics helper, song list, playback, remix, download |
| `public/provider.js` | Browser side of the API calls; demo mode without the server |
| `.env.example` | Settings template |
| `render.yaml` | One-click deploy to Render |
| `test/server.test.js` | Server tests (`npm test`) |
