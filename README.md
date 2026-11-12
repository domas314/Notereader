# Notereader

A phone app for choir singers: photograph (or upload a PDF of) your sheet music,
and Notereader reads it, shows the score, and plays it back in strict tempo while
highlighting the notes being sung. You choose which voice you hear.

- **Scan** – camera photos, picked photos, multi-page PDFs, or MusicXML / MEI files.
  Recognition is built for imperfect input: tilted, unevenly lit, slightly blurry pages.
- **Voices** – each voice (Soprano / Alto / Tenor / Bass, or however many the score has)
  can be Full, Quiet or Off. "Only" solos one voice; "Lead" keeps the others quietly
  underneath. Works for open scores (one staff per voice) and closed scores
  (two voices sharing a staff). Each voice can be shifted by an octave.
- **Tempo** – 30–220 bpm, changeable while playing, with optional metronome click and
  a one-bar count-in. Playback is scheduled on the audio clock, so it does not drift.
- **Follow along** – sounding notes light up in the voice's colour and the score scrolls
  with the music. Tap any note to start from there; drag the slider to jump by bar.
- **Fix mistakes** – no scan is perfect. Pause, tap a wrong note, and move it up/down,
  set ♯ ♭ ♮, or remove it. Fixes are saved; "Undo all note fixes" returns to the scan.
- **Library** – scores are saved on the phone and play offline.

## How it is built

| Part | What it does |
| --- | --- |
| `web/` | The app itself: a plain HTML/JS web app (no build step) that installs to the home screen. Engraving by [Verovio](https://www.verovio.org) (vendored in `web/vendor/`), sound by the Web Audio API. |
| `server/` | A small FastAPI server that serves the app and runs sheet-music recognition with [homr](https://github.com/liebharc/homr). |

Reading the music needs the server (the recognition models are ~150 MB and too heavy
for a phone browser). Everything else – display, playback, saved scores – runs on the phone.

## Run it

```bash
python -m venv .venv && . .venv/bin/activate      # Python 3.11+
pip install -r server/requirements.txt
homr --init                                        # one-time model download (~150 MB)
uvicorn server.app:app --host 0.0.0.0 --port 7860
```

Open `http://<your-computer's-address>:7860` on your phone (same Wi-Fi).

Or with Docker (models are baked into the image):

```bash
docker build -t notereader .
docker run -p 7860:7860 notereader
```

To use it anywhere, host the container on any service that runs Docker images and
gives you an HTTPS address (for example a free Hugging Face *Docker Space*: the image
listens on port 7860, which is that platform's default). Over HTTPS the app can be
added to the home screen and works offline for saved scores. Allow roughly 2 GB of RAM;
a page takes about 10 s on a 4-core machine and longer on small shared CPUs.

If the app is served from somewhere else than the recognition server, enter the
server's address under Settings (the sliders icon on the start screen).

## Getting good scans

- Lay the page flat, fill the frame, avoid shadows across the staves.
- One page per photo; add pages in order (they can be re-ordered before reading).
- PDFs exported from notation software read best.
- Tenor parts written in treble clef: the small "8" under the clef is often lost in a
  scan, so Notereader lowers a too-high tenor line by an octave automatically. Change
  it under **Voices** if it guessed wrong.

## Known limits

- Repeats, first/second endings and D.C./D.S. are not followed; the music plays straight through.
- Lyrics, dynamics and tempo changes inside the piece are not read.
- Note fixes cover pitch and accidentals, not rhythm.
- The Docker image has not been built in CI yet; the server was tested by running it directly.

## Licences

homr is AGPL-3.0 and Verovio is LGPL-3.0; both are used unmodified. If you offer a
hosted Notereader to other people, the AGPL requires that you make this source
available to them.
