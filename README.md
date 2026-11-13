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
- **Sound** – sung parts play as a recorded choir ("aah"), the piano as a recorded grand piano.
  Under Voices you can switch to piano for everything (clearest for learning notes) or simple tones.
- **Tempo** – 30–220 bpm, changeable while playing, with optional metronome click and
  a one-bar count-in. Playback is scheduled on the audio clock, so it does not drift.
- **Follow along** – sounding notes light up in the voice's colour and the score scrolls
  with the music. Tap any note to start from there; drag the slider to jump by bar.
- **Fix mistakes** – no scan is perfect. Pause, tap a wrong note, and move it up/down,
  set ♯ ♭ ♮, or remove it. Fixes are saved; "Undo all note fixes" returns to the scan.
- **Library** – scores are saved on the phone and play offline.

## Install (Android)

Open the releases of the update repository
[domas314/Checkupdate](https://github.com/domas314/Checkupdate/releases) on the phone,
download `Notereader.apk` from the newest release and open it. Android asks once to allow
installing from that source. The app is about 200 MB because it carries the recognition
engine and its models.

**Updates.** The app looks at Checkupdate's latest release when it starts. If there is a
newer version it shows *Update available → Download*; open the downloaded file to install
it over the old one (saved scores are kept). You can also check by hand under the sliders
icon → *Check for updates*.

**Publishing.** Every push here builds the APK and publishes it as release `v1.<build>` of
Checkupdate. That needs one secret in this repository (Settings → Secrets and variables →
Actions): `CHECKUPDATE_TOKEN`, a
[fine-grained token](https://github.com/settings/personal-access-tokens/new) with access to
*only* `domas314/Checkupdate` and the permission *Contents: Read and write*. Without it the
build is published as a release of this repository instead, where installed apps don't see it.
To change the update repository, edit `UPDATE_REPO` in `.github/workflows/android.yml`.

## How reading works

Reading happens in steps: find the staves and notes on the page (segmentation), then read
each staff. To make that fast on a phone:

- **Blank areas are skipped.** Margins, the table around a photo and empty space under the
  last system are not run through the segmentation network. Ink is judged against the paper
  around it, so faint or dim pages are read in full, and areas next to music are never skipped.
- **Several cores.** Helper workers (`web/omr/pool.js`) segment the page and read the staves
  side by side, one per spare core: up to 3 on phones reporting 8 GB of memory, 2 on 4 GB,
  none below. Each needs about 300 MB. If the phone ever closes the app during a reading, the
  next readings use fewer helpers.
- **8-bit staff reader.** The network that looks at each staff runs with 8-bit weights
  (converted by `npm run engine`), about twice as fast and a third of the size.

Measured on a full page of four-part music (12 staves) on a 4-core computer: 123 s before
these changes, 45 s after, with exactly the same notes read. Phones are slower than that
computer; expect roughly a minute or two per page.

| Part | What it does |
| --- | --- |
| `web/` | The whole app: plain HTML/JS, no build step. |
| `web/omr/` | On-device recognition: runs [homr](https://github.com/liebharc/homr) (Python) in [Pyodide](https://pyodide.org), with its neural networks executed by [ONNX Runtime Web](https://onnxruntime.ai) in parallel helper workers. |
| `web/reader.js` | Turns photos, PDFs ([pdf.js](https://mozilla.github.io/pdf.js/)) and web links into pages for the engine. |
| `web/score.js`, `web/player.js` | Engraving with [Verovio](https://www.verovio.org), voice splitting, and the tempo-locked Web Audio player. |
| `web/update.js` | Update check against the Checkupdate repository's releases. |
| `web/engine/` | The engine's large files (~195 MB). Not stored in the repository: `npm run engine` downloads them from the projects' public releases. |
| `.github/workflows/android.yml` | Builds the APK on every push and publishes it to Checkupdate as release `v1.<build>`. |

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

- Repeat signs and first/second endings are followed. D.C., D.S., Coda and Fine are not.
- Hymn-style scores (Soprano + Alto on one staff, Tenor + Bass on another) are read as four
  voices, also when the barlines are not drawn through both staves.
- A piano or organ accompaniment is recognised when it is written on a braced pair of staves
  below the voices; it then appears as one "Piano" entry next to the voices.
- Scans carry no part names, so parts are named by layout: four lines are Soprano, Alto,
  Tenor, Bass; three are Soprano, Alto, Baritone (or Soprano 1, Soprano 2, Alto when all
  three are high). Tap a name under Voices to rename it.
- Scores scanned before repeats were fixed may have their start-repeat sign in the wrong
  place; scan them again.
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

Sounds: the piano is the Salamander Grand Piano V3 by Alexander Holm (CC BY 3.0, via
`@audio-samples/piano-mp3-velocity8`); the choir is "Choir Aahs" from the MusyngKite sound font
(CC BY-SA 3.0, via midi-js-soundfonts / `web-music-score-samples`).
