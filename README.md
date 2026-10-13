# p5-HD-recorder

Frame-exact, high-resolution recording for [p5.js](https://p5js.org) sketches (global mode). Drop it in and a floating **● Record / ■ Stop** button appears, which saves:

- **PNG frames** (zipped), always
- **H.264 MP4**, made in the browser right away (`-web.mp4`)
- **High-quality MP4 + ProRes 422 HQ `.mov`**, made by a terminal helper using your local ffmpeg

Recording is frame-exact: a slow or high-res sketch still plays back at the set fps, with no dropped frames. Built on [p5.capture](https://github.com/tapioca24/p5.capture), [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) and [FFmpeg](https://ffmpeg.org); see [Credits](#credits).

## Quick start (no download)

Add to your `index.html`, **after p5 and before your sketch**:

```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/p5.js/1.11.1/p5.js"></script>
<script src="https://cdn.jsdelivr.net/npm/p5.capture@1.6.1/dist/p5.capture.umd.min.js"></script>
<script src="https://cdn.jsdelivr.net/gh/ronyginosar/p5-HD-recorder@main/p5.recorder.js"></script>
<script src="sketch.js"></script>
```

No changes to the sketch are needed. Set `pixelDensity()` once in `setup()`, never inside `draw()`.

## Files (to use locally or customise)

| File | Copy to | Purpose |
| --- | --- | --- |
| `p5.recorder.js` | your project, next to `index.html` (then use `<script src="p5.recorder.js">`) | the button + recording logic |
| `render-recordings.mjs` | anywhere | turns the downloaded zips into MP4 + ProRes |
| `example/` | n/a | minimal demo sketch |

## Usage

1. Start the helper once in a terminal (needs [Node](https://nodejs.org) and [ffmpeg](https://ffmpeg.org), e.g. `brew install ffmpeg`):
   ```bash
   node render-recordings.mjs
   ```
2. Open the sketch, click **● Record**, then **■ Stop**. Allow multiple downloads if the browser asks.
3. In `~/Downloads` you get:

| File | From |
| --- | --- |
| `recording-<date>-<time>-part001.zip` … | browser |
| `recording-<date>-<time>-web.mp4` | browser |
| `recording-<date>-<time>.recording.json` | browser (tells the helper the recording is complete) |
| `recording-<date>-<time>.mp4` | helper |
| `recording-<date>-<time>-prores.mov` | helper |

Helper options: `--once` (render what's ready, then exit) · `--codecs h264` or `--codecs prores` · `--dir <folder>` · `--keep-frames`.

## Settings

Tuneable constants are at the top of `p5.recorder.js` (fps, duration, export density, bitrate, button look) and of `render-recordings.mjs` (CRF, ProRes profile, watched folder).

Per-sketch overrides, from `setup()`:

```js
Recorder.configure({ durationSeconds: 8, exportPixelDensity: 2, framerate: 30 });
```

Programmatic control: `Recorder.start()`, `Recorder.stop()`, `Recorder.toggle()`, `Recorder.isRecording()`, `Recorder.destroy()`.

## Notes

- Animations driven by `frameCount` restart from frame 1 when recording starts, so takes are repeatable.
- The browser MP4 needs WebCodecs (Chrome, Edge, Safari 16.4+, recent Firefox); otherwise it's skipped and the helper still makes both videos.
- ProRes is only made by the helper, because browsers can't encode it.
- p5.js 1.x, global mode. Serve the page over `http://` (e.g. `npx serve` or VS Code Live Server), not `file://`.

## Credits

This project is a thin layer on top of excellent open-source work:

| Library | Author | Used for | License |
| --- | --- | --- | --- |
| [p5.js](https://p5js.org) ([GitHub](https://github.com/processing/p5.js)) | Processing Foundation & contributors | the sketch runtime | LGPL-2.1 |
| [p5.capture](https://github.com/tapioca24/p5.capture) | [tapioca24](https://github.com/tapioca24) | frame-exact capture of the p5 canvas, PNG/JPG/WebP zips | MIT |
| [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) | [Vanilagy](https://github.com/Vanilagy) | packaging browser-encoded H.264 into an MP4 file | MIT |
| [WebCodecs API](https://developer.mozilla.org/docs/Web/API/WebCodecs_API) | W3C / browser vendors | hardware H.264 encoding in the browser | web standard |
| [FFmpeg](https://ffmpeg.org) with [x264](https://www.videolan.org/developers/x264.html) | FFmpeg & VideoLAN developers | final H.264 and ProRes renders (helper script) | LGPL / GPL |
| [Node.js](https://nodejs.org) | OpenJS Foundation | running the helper script | MIT |
| [jsDelivr](https://www.jsdelivr.com) | jsDelivr | serving the scripts from a CDN | free public CDN |

p5.capture itself builds on [webm-writer-js](https://github.com/thenickdude/webm-writer-js), [gif.js](https://github.com/jnordberg/gif.js) and [h264-mp4-encoder](https://github.com/TrevorSundberg/h264-mp4-encoder) for its other export formats.

None of these are bundled here; they're loaded from their CDNs or installed on your machine, under their own licenses.

## License

MIT for the code in this repository (`p5.recorder.js`, `render-recordings.mjs`, `example/`).
