# Notereader

A phone app for choir singers: photograph your sheet music (or open a PDF, or paste a
link to one) and Notereader reads it, shows the score, and plays it back in strict tempo
while highlighting the notes being sung. You choose which voice you hear.

**Everything runs on the phone.** There is no server: the music is read, stored and
played on the device and never uploaded.

- **Scan** – camera photos, picked photos, multi-page PDFs, MusicXML / MEI files, or a
  **web link** to a PDF (or to a page that has the PDF on it).
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

## Install (Android)

Open this repository's **Releases** page on the phone, download `Notereader.apk` from the
newest release and open it. Android asks once to allow installing from that source.
The app is about 200 MB because it carries the recognition engine and its models.

**Updates.** The app looks at this repository's latest release when it starts. If there
is a newer version it shows *Update available → Download*; open the downloaded file to
install it over the old one (saved scores are kept). You can also check by hand under
the sliders icon → *Check for updates*.
Update checks need the repository to be **public** – a private repository cannot be
read by the app.

## How reading works

Reading a page takes a few minutes on a phone (about 70 s per page on a desktop-class
processor). Keep the app open while it works; the screen is kept awake.

| Part | What it does |
| --- | --- |
| `web/` | The whole app: plain HTML/JS, no build step. |
| `web/omr/` | On-device recognition: runs [homr](https://github.com/liebharc/homr) (Python) in [Pyodide](https://pyodide.org), with its neural networks executed by [ONNX Runtime Web](https://onnxruntime.ai). |
| `web/reader.js` | Turns photos, PDFs ([pdf.js](https://mozilla.github.io/pdf.js/)) and web links into pages for the engine. |
| `web/score.js`, `web/player.js` | Engraving with [Verovio](https://www.verovio.org), voice splitting, and the tempo-locked Web Audio player. |
| `web/update.js` | Update check against this repository's releases. |
| `web/engine/` | The engine's large files (~195 MB). Not stored in the repository: `npm run engine` downloads them from the projects' public releases. |
| `.github/workflows/android.yml` | Builds the APK on every push and publishes it as release `v1.<build>`. |

It needs a current Android System WebView / Chrome (version 137 or newer).

## Build it yourself

```bash
npm install
npm run engine            # download the reading engine into web/engine (needs python3, curl, unzip)
npm run serve             # try it in a desktop Chrome at http://localhost:8080
npm run android:prepare   # create the Android project (Node 22, Java 21, Android SDK)
npm run android:build     # -> android/app/build/outputs/apk/debug/app-debug.apk
```

## Reading from web links

The app downloads the address you paste. If it is a web page, it looks for PDF links and
embedded PDF viewers; with several PDFs you pick one. Pages that need a login, or that
only show the music through scripts, cannot be read – open the PDF itself and copy its
address, or download it and use *Photos / PDF*.

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
- iPhone is not supported: there is no APK equivalent, and Safari lacks a feature the
  reading engine needs.

## Signing key

Android only installs an update over an existing app if both are signed with the same
key, so the build uses the fixed key in `android-signing/` (password `android`). It is a
convenience key, not a secret: anyone with this repository can sign an APK with it. That
is fine for an app you install yourself from your own releases; if you ever distribute
it more widely, replace it with a key kept in a GitHub Actions secret.

## Licences

homr is AGPL-3.0 and is shipped inside the app unmodified, so the app as a whole must be
offered under AGPL-compatible terms with its source available (this repository).
Verovio is LGPL-3.0; Pyodide is MPL-2.0; ONNX Runtime and pdf.js are MIT / Apache-2.0.
