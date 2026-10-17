# Cadence — AI song generator

A web UI for creating songs from a short text prompt, with controls for:

- **Genre**: up to 3 of 12 (Pop, Hip-Hop, Afrobeats, Amapiano, R&B, Lo-fi, House, Rock, Jazz, Synthwave, Folk, Cinematic)
- **Mood**: Euphoric, Bittersweet, Chill, Melancholic, Dark, Romantic, Energetic, Dreamy
- **Instruments**: piano, guitars, 808s, synth pads, strings, saxophone, talking drum, bass, brass
- **Lyrics**: AI-written, your own lyrics, or instrumental; female, male or duet vocals
- **Tempo** (60–180 BPM) and **length** (1–4 minutes)

Every choice is gathered into one style string that is sent to the generator with the prompt. Each generation makes two versions, which appear in the song list with a player and waveform.

## Run it

It is a static site with no build step:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

Or enable GitHub Pages on the `main` branch.

## Connecting a real music model

Generation is currently **mocked**: `provider.js` waits about two seconds and returns silent placeholder songs. To make real music, replace `SongProvider.generate` in `provider.js` with a call to your own backend (an example is in the file). That backend calls the music-generation API of your choice and returns:

```json
[{ "title": "…", "tags": "…", "duration": 178, "audioUrl": "https://…/song.mp3" }]
```

When a song has an `audioUrl`, the player plays the real audio. Keep API keys on the server; never put them in `provider.js`.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page structure |
| `styles.css` | Visual design (colours and fonts are CSS variables in `:root`) |
| `app.js` | Composer controls, song list, playback |
| `provider.js` | The swappable generation backend (mock by default) |
