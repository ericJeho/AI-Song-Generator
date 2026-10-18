# Cadence — AI song generator

Turn a short text prompt into a full song, with controls for:

- **Genre**: up to 3 of 12 (Pop, Hip-Hop, Afrobeats, Amapiano, R&B, Lo-fi, House, Rock, Jazz, Synthwave, Folk, Cinematic)
- **Mood**: Euphoric, Bittersweet, Chill, Melancholic, Dark, Romantic, Energetic, Dreamy
- **Instruments**: piano, guitars, 808s, synth pads, strings, saxophone, talking drum, bass, brass
- **Lyrics**: written by the music model, your own, or instrumental; female, male or duet vocals
- **Lyrics helper**: "Draft from my description" writes editable lyrics with Claude
- **Tempo** (60–180 BPM) and **length** (1–4 minutes)

Songs are made with **ElevenLabs Music** or **MiniMax Music**. Each click makes two versions, which can be played, downloaded as MP3, removed, or **remixed** (loads a song's settings back into the composer). Visitors sign in, need an invite code, and have a daily song limit, so strangers can't spend your API balance.

## How it's built

```
Appwrite Sites (public/)          Supabase project "cadence"
  index.html, app.js  ──sign in──▶  Auth (email + password)
  provider.js         ──read─────▶  songs table (each user sees only their own rows)
                      ──POST─────▶  Edge Function "api" ──▶ ElevenLabs or MiniMax, Claude
  <audio>             ◀──MP3──────  Storage bucket "songs"
```

- **Supabase** (`supabase/`): sign-in, the database (`profiles`, `songs`, `daily_usage`), MP3 storage, and the `api` Edge Function that checks the invite code and daily limit, calls the music and lyrics APIs, and saves the result. API keys live only in the function's secrets.
- **Appwrite Sites** (`public/`): serves the static web page. No build step.
- Generating is asynchronous: `/generate` creates "pending" songs and returns at once; the function makes the audio in the background, and the page refreshes the list every few seconds until the songs are ready.

| File | Purpose |
| --- | --- |
| `supabase/migrations/…_init.sql` | Tables, row-level security, new-user trigger, daily-limit function, `songs` bucket |
| `supabase/functions/api/index.ts` | Edge Function entry: connects routes to Supabase and the APIs |
| `supabase/functions/api/handler.ts` | Routes: `/health`, `/me`, `/redeem`, `/generate`, `/lyrics` |
| `supabase/functions/api/music.ts` | Input checks and the ElevenLabs / MiniMax / demo providers |
| `supabase/functions/api/lyrics.ts` | Lyrics helper (Claude API) |
| `supabase/functions/api/handler_test.ts` | Tests (`npm test`) |
| `public/config.js` | Supabase project URL and publishable key (public by design) |
| `public/provider.js` | Browser side: sign-in, song list, calls to the function |
| `public/app.js`, `index.html`, `styles.css` | The page |
| `public/vendor/` | Bundled supabase-js browser build (MIT licence alongside) |
| `appwrite.config.json` | Appwrite Sites deployment settings |

## Setup

The Supabase project (`pbipjfwhdrlktlzgstxw`, eu-west-1) already has the database, storage bucket and `api` function deployed. Until a music key is added, it runs in demo mode (silent songs, nothing charged).

### 1. Add the secrets in Supabase

Supabase dashboard → **Edge Functions → Secrets**:

| Secret | What it does |
| --- | --- |
| `ELEVENLABS_API_KEY` | Music from ElevenLabs (a plan that includes music). |
| `MINIMAX_API_KEY` | Music from MiniMax. If both are set, `MUSIC_PROVIDER` (`elevenlabs` or `minimax`) picks. |
| `ANTHROPIC_API_KEY` | Turns on the lyrics helper. Optional. |
| `SIGNUP_CODE` | Invite code accounts need before they can generate. **Set this**, or anyone who signs up can use your balance. |
| `ALLOWED_ORIGIN` | Your Appwrite site's address (e.g. `https://cadence.appwrite.network`), so only your site can call the function from a browser. |
| `DAILY_SONGS_PER_USER`, `DAILY_LYRICS_PER_USER`, `VERSIONS_PER_REQUEST` | Optional limits (defaults 10, 20, 2). |

### 2. Publish the page on Appwrite Sites

Either connect the GitHub repository in the Appwrite Console (**Sites → Create site → Connect a repository**, root directory `public`, framework *Other*, no install or build command, output directory `./`), or use the CLI:

```sh
npm install -g appwrite-cli
appwrite login
# put your Appwrite project ID and endpoint into appwrite.config.json
appwrite push sites --all
```

### 3. Point Supabase sign-in at the site

Supabase dashboard → **Authentication → URL Configuration**: set **Site URL** to the Appwrite site's address and add it under **Redirect URLs**, so confirmation emails link back to the app. Supabase's built-in email sender only allows a few emails an hour; for real use, add your own SMTP server under **Authentication → Emails**.

## Development

```sh
npm install        # installs Deno locally
npm test           # Edge Function tests (in-memory database, local stand-ins for the APIs)
npm run check      # type-check the function
npm run serve      # serve public/ at http://localhost:8000 against the live Supabase project
```

To deploy changes with the Supabase CLI: `supabase link --project-ref pbipjfwhdrlktlzgstxw`, then `supabase db push` and `supabase functions deploy api`.

## Limits to know

- On Supabase's free plan an Edge Function's background work is cut off after about 150 seconds. Long songs, or a slow music service, may not finish. The page marks a song still pending after 10 minutes as failed.
- MiniMax support was written from memory of its API and has only been tested against a stand-in.
- The previous self-hosted Node.js version is in this repository's history (commit `1170786`).
