/**
 * p5.recorder.js — reusable, frame-exact video / image-sequence recorder for p5.js (global mode).
 * Part of p5-HD-recorder: https://github.com/ronyginosar/p5-HD-recorder (MIT)
 * Thin wrapper around p5.capture (https://github.com/tapioca24/p5.capture).
 *
 * Setup (index.html), in this order:
 *   <script src="p5.js"></script>
 *   <script src="https://cdn.jsdelivr.net/npm/p5.capture@1.6.1/dist/p5.capture.umd.min.js"></script>
 *   <script src="p5.recorder.js"></script>
 *   <script src="sketch.js"></script>
 *
 * Usage: pick Instagram / True HD / GIF on the floating switch, then click Record / Stop
 * (both are DOM, so they never appear in the recording).
 * Optional per-sketch overrides from setup():
 *   Recorder.configure({ preset: "trueHD", durationSeconds: 8, exportPixelDensity: 2 });
 *
 * Export presets (RECORDER_EXPORT_PRESET): "instagram" = ≤1080 px wide, 30 fps, 16 Mbps;
 * "trueHD" = sketch resolution, capture fps, 40 Mbps; "gif" = looping <session>.gif (≤540 px wide, 20 fps)
 * instead of the browser MP4, no frame zips. The MP4 presets are Rec. 709 SDR; for the browser MP4 only the
 * container is relabelled (the H.264 stream keeps whatever the browser's encoder wrote, sometimes sRGB) —
 * render-recordings.mjs sets both.
 * Capture always runs at RECORDER_FRAMERATE; a lower output fps drops frames evenly, so motion speed is kept.
 *
 * Each recording is a "session" that downloads:
 *   <session>-part001.zip …        PNG frames (p5.capture), at full capture fps
 *   <session>-web.mp4              quick H.264 encoded in the browser (WebCodecs), if enabled + supported
 *   <session>.gif                  "gif" preset only (replaces the zips, MP4 and manifest)
 *   <session>.recording.json       manifest — tells render-recordings.mjs the session is complete
 * Run `node render-recordings.mjs` in a terminal to turn the zips into <session>.mp4 + <session>-prores.mov.
 */

// ─── Tuneable parameters ──────────────────────────────────────────────────────
// Export toggle: "instagram" (Instagram's best HD), "trueHD" (full fps / bitrate / resolution, for archive & editing)
// or "gif" (looping GIF for previews / web).
// browserOutput: what's encoded in the browser ("mp4" | "gif"); shouldDownloadFrames: download the PNG zips + manifest
const RECORDER_EXPORT_PRESET = "trueHD";
const RECORDER_EXPORT_PRESETS = {
  // Instagram re-encodes anything above this, so match it: ≤1080 px wide, 30 fps, 15–20 Mbps
  instagram: { outputFramerate: 30, browserMp4BitrateMbps: 16, maxOutputWidth: 1080, browserOutput: "mp4", shouldDownloadFrames: true },
  // null = keep the capture fps / the sketch's resolution
  trueHD: { outputFramerate: null, browserMp4BitrateMbps: 40, maxOutputWidth: null, browserOutput: "mp4", shouldDownloadFrames: true },
  // 60 → 20 fps is an exact frame step and an exact GIF delay (5 cs); GIF frames are held in memory, so keep it small
  gif: { outputFramerate: 20, browserMp4BitrateMbps: null, maxOutputWidth: 540, browserOutput: "gif", shouldDownloadFrames: false },
};

const RECORDER_FORMAT = "png";              // "png" | "jpg" | "webp" (zipped sequences) | "mp4" | "webm" | "gif"
const RECORDER_FRAMERATE = 60;              // capture fps: one captured frame per draw() (the sketch's native speed)
const RECORDER_DURATION_SECONDS = null;     // auto-stop after N seconds of output; null = stop manually
const RECORDER_EXPORT_PIXEL_DENSITY = null; // e.g. 2 → 1080×1350 from a 540×675 canvas; null = keep sketch's density
const RECORDER_RESET_FRAMECOUNT = true;     // restart frameCount at 0 so frameCount-driven animations are reproducible
const RECORDER_MP4_BITRATE_KBPS = 20000;    // p5.capture "mp4" format only — its default (5000) is too low for high-res
const RECORDER_QUALITY = 1;                 // 0–1, for WebM / GIF / JPG / WebP
const RECORDER_AUTO_SAVE_EVERY_FRAMES = 600; // image sequences only: download a zip every N frames to cap memory
const RECORDER_SHOW_CAPTURE_UI = false;     // show p5.capture's built-in floating panel
const RECORDER_TITLE_PREFIX = "● REC ";     // prepended to the tab title while capturing
const RECORDER_FILENAME_PREFIX = "recording"; // session name = <prefix>-<YYYYMMDD-HHMMSS>
const RECORDER_WRITE_MANIFEST = true;       // download <session>.recording.json for render-recordings.mjs

// in-browser H.264 MP4 alongside the frames (WebCodecs + mp4-muxer; ProRes needs the terminal script)
const RECORDER_BROWSER_MP4 = true;
const RECORDER_BROWSER_MP4_KEYFRAME_SECONDS = 2;  // keyframe interval (seeking granularity)
// Rec. 709 SDR tag for the MP4 container (`colr` box); the H.264 stream's own tag is the browser encoder's choice
const RECORDER_BROWSER_MP4_COLOR_SPACE = { primaries: "bt709", transfer: "bt709", matrix: "bt709", fullRange: false };
const RECORDER_MP4_MUXER_URL = "https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.2/build/mp4-muxer.min.js";

// in-browser GIF for the "gif" preset (gif.js — the encoder p5.capture uses internally; loaded on demand)
const RECORDER_GIF_LIBRARY_URL = "https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.js";
const RECORDER_GIF_WORKER_URL = "https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.worker.js";
const RECORDER_GIF_QUALITY = 10;    // palette sampling: 1 = best colours (slowest) … 30 = fastest
const RECORDER_GIF_DITHER = false;  // false | "FloydSteinberg" | "Atkinson" | "Stucki" — smoother gradients, bigger file
const RECORDER_GIF_LOOP_COUNT = 0;  // 0 = loop forever, -1 = play once, N = repeat N times
const RECORDER_GIF_WORKERS = 4;     // parallel encoding workers

// toggle button
const RECORDER_BUTTON_LABELS = { idle: "● Record", capturing: "■ Stop", encoding: "Encoding…" };
const RECORDER_BUTTON_POSITION = { top: "1rem", right: "1rem" }; // any CSS inset values (button + preset switch)
const RECORDER_BUTTON_COLORS = { idle: "#222", capturing: "#d62828", text: "#fff" };

// on-screen export preset switch, next to the Record button; locked while recording
const RECORDER_SHOW_PRESET_SWITCH = true;
const RECORDER_PRESET_LABELS = { instagram: "Instagram", trueHD: "True HD", gif: "GIF" }; // also sets the order
// the switch's last choice is remembered in this browser and wins over the code's preset; null = don't remember
const RECORDER_PRESET_STORAGE_KEY = "p5-recorder-preset";
// ──────────────────────────────────────────────────────────────────────────────

const Recorder = (() => {
  const IMAGE_SEQUENCE_FORMATS = ["png", "jpg", "webp"];
  const BUTTON_CLASS = "p5-recorder-toggle";
  const CONTROLS_CLASS = "p5-recorder-controls";
  const PRESET_SWITCH_CLASS = "p5-recorder-preset-switch";

  /** Preset last picked on the on-screen switch, or null (switch hidden, storage off/unavailable, or stale value). */
  const readSavedPreset = () => {
    if (!RECORDER_SHOW_PRESET_SWITCH || !RECORDER_PRESET_STORAGE_KEY) return null;
    try {
      const savedPreset = localStorage.getItem(RECORDER_PRESET_STORAGE_KEY);
      return RECORDER_EXPORT_PRESETS[savedPreset] ? savedPreset : null;
    } catch {
      return null; // storage blocked (e.g. some privacy modes)
    }
  };

  const writeSavedPreset = (preset) => {
    if (!RECORDER_PRESET_STORAGE_KEY) return;
    try {
      localStorage.setItem(RECORDER_PRESET_STORAGE_KEY, preset);
    } catch {
      // storage blocked: the choice still applies for this page view
    }
  };

  let savedPreset = readSavedPreset();
  // H.264 High profile, highest level first; level 5.x is needed above ~1080p
  const AVC_CODEC_CANDIDATES = ["avc1.640034", "avc1.640033", "avc1.640032", "avc1.640028"];

  // Runtime settings; start from the constants above, overridable via Recorder.configure().
  const settings = {
    preset: savedPreset ?? RECORDER_EXPORT_PRESET,
    format: RECORDER_FORMAT,
    framerate: RECORDER_FRAMERATE,
    outputFramerate: null,       // null = from the preset
    browserMp4BitrateMbps: null, // null = from the preset
    maxOutputWidth: null,        // null = from the preset
    durationSeconds: RECORDER_DURATION_SECONDS,
    exportPixelDensity: RECORDER_EXPORT_PIXEL_DENSITY,
    shouldResetFrameCount: RECORDER_RESET_FRAMECOUNT,
    mp4BitrateKbps: RECORDER_MP4_BITRATE_KBPS,
    quality: RECORDER_QUALITY,
    autoSaveEveryFrames: RECORDER_AUTO_SAVE_EVERY_FRAMES,
    filenamePrefix: RECORDER_FILENAME_PREFIX,
    shouldWriteManifest: RECORDER_WRITE_MANIFEST,
    shouldEncodeBrowserMp4: RECORDER_BROWSER_MP4,
  };

  let densityBeforeRecording = null; // restored once capturing ends
  let wasCapturing = false;          // previous-frame state, to detect auto-stop by duration
  let isStarting = false;            // guards double-clicks while start() awaits encoder setup
  let toggleButton = null;
  let presetSwitch = null;
  let controlsElement = null; // fixed wrapper holding the preset switch + Record button
  let styleElement = null;
  const originalTitle = document.title;

  // per-recording session
  let session = null; // { name, partCount, capturedFrames, width, height, browserEncoder }

  if (typeof P5Capture === "undefined") {
    console.error("p5.recorder: P5Capture not found — load p5.capture before p5.recorder.js");
  } else {
    // must run before p5 initialises (i.e. at script load), per p5.capture docs
    P5Capture.setDefaultOptions({ disableUi: !RECORDER_SHOW_CAPTURE_UI });
  }

  /** Returns the p5.capture singleton, or null if the library or sketch isn't ready. */
  const getCapture = () => {
    if (typeof P5Capture === "undefined" || !window.p5 || !p5.instance) return null;
    return P5Capture.getInstance();
  };

  /** "idle" | "capturing" | "encoding" (idle when not ready yet). */
  const getState = () => getCapture()?.state ?? "idle";
  const isRecording = () => getState() === "capturing";

  /** Merges per-sketch overrides into the runtime settings; a preset picked on the switch still wins. */
  const configure = (overrides = {}) => {
    Object.assign(settings, overrides);
    if (savedPreset) settings.preset = savedPreset;
    updatePresetSwitch();
    return settings;
  };

  // ─── Helpers ───────────────────────────────────────────────────────────────

  const padNumber = (value, digits) => String(value).padStart(digits, "0");

  /** e.g. "recording-20261013-110512" — shared by every file of one recording. */
  const createSessionName = (date = new Date()) => {
    const datePart = `${date.getFullYear()}${padNumber(date.getMonth() + 1, 2)}${padNumber(date.getDate(), 2)}`;
    const timePart = `${padNumber(date.getHours(), 2)}${padNumber(date.getMinutes(), 2)}${padNumber(date.getSeconds(), 2)}`;
    return `${settings.filenamePrefix}-${datePart}-${timePart}`;
  };

  /** Triggers a browser download for an in-memory blob. */
  const downloadBlob = (blob, filename) => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000); // give the download time to start
  };

  /** Loads a classic <script> once; resolves immediately if already present. */
  const loadScriptOnce = (() => {
    const pending = new Map();
    return (url) => {
      if (!pending.has(url)) {
        pending.set(url, new Promise((resolve, reject) => {
          const script = document.createElement("script");
          script.src = url;
          script.onload = resolve;
          script.onerror = () => reject(new Error(`failed to load ${url}`));
          document.head.appendChild(script);
        }));
      }
      return pending.get(url);
    };
  })();

  const isWebCodecsAvailable = () => typeof VideoEncoder !== "undefined" && typeof VideoFrame !== "undefined";

  /** Active preset; unknown names fall back to trueHD (with a warning). */
  const getPreset = () => {
    const preset = RECORDER_EXPORT_PRESETS[settings.preset];
    if (preset) return preset;
    console.warn(`p5.recorder: unknown preset "${settings.preset}" — using "trueHD"`);
    return RECORDER_EXPORT_PRESETS.trueHD;
  };

  /** Output fps (explicit setting → preset → capture fps), never above the capture fps. */
  const getOutputFramerate = () =>
    Math.min(settings.outputFramerate ?? getPreset().outputFramerate ?? settings.framerate, settings.framerate);

  const getBrowserMp4BitrateMbps = () => settings.browserMp4BitrateMbps ?? getPreset().browserMp4BitrateMbps;
  const getMaxOutputWidth = () => settings.maxOutputWidth ?? getPreset().maxOutputWidth;
  const getBrowserOutput = () => getPreset().browserOutput ?? "mp4";
  const isFrameDownloadEnabled = () => getPreset().shouldDownloadFrames ?? true;

  /** Keep 1 of every N captured frames, e.g. 60 → 30 fps keeps every 2nd frame. */
  const getFrameStep = () => Math.max(1, Math.round(settings.framerate / getOutputFramerate()));

  /** Sets up the preset's in-browser encoder ("mp4" | "gif"); null if disabled / unsupported. */
  const createBrowserEncoder = (width, height) =>
    getBrowserOutput() === "gif" ? createGifEncoder(width, height) : createMp4Encoder(width, height);

  /** Feeds the current canvas to the browser encoder, dropping frames evenly to reach the output fps. */
  const encodeBrowserFrame = (browserEncoder) => {
    const isSkippedFrame = browserEncoder.sourceFrameIndex++ % getFrameStep() !== 0;
    if (isSkippedFrame) return;
    if (browserEncoder.kind === "gif") addGifFrame(browserEncoder);
    else encodeMp4Frame(browserEncoder);
    browserEncoder.frameIndex++;
  };

  /** Finalises the browser encoder's file and downloads it. */
  const finishBrowserEncoder = (browserEncoder, sessionName) =>
    browserEncoder.kind === "gif"
      ? finishGifEncoder(browserEncoder, sessionName)
      : finishMp4Encoder(browserEncoder, sessionName);

  // ─── In-browser H.264 (WebCodecs → mp4-muxer) ──────────────────────────────

  /** Picks the first H.264 config this browser can encode at the given size, or null. */
  const findSupportedAvcConfig = async (width, height) => {
    for (const codec of AVC_CODEC_CANDIDATES) {
      const config = {
        codec,
        width,
        height,
        bitrate: getBrowserMp4BitrateMbps() * 1e6,
        framerate: getOutputFramerate(),
        latencyMode: "quality",
        avc: { format: "avc" }, // length-prefixed NALUs, required by MP4
      };
      const { supported } = await VideoEncoder.isConfigSupported(config).catch(() => ({ supported: false }));
      if (supported) return config;
    }
    return null;
  };

  /** Sets up an encoder + muxer pair; returns null (with a console note) if unavailable. */
  const createMp4Encoder = async (width, height) => {
    if (!settings.shouldEncodeBrowserMp4) return null;
    if (!isWebCodecsAvailable()) {
      console.warn("p5.recorder: WebCodecs not available — skipping browser MP4 (use render-recordings.mjs)");
      return null;
    }
    try {
      await loadScriptOnce(RECORDER_MP4_MUXER_URL);
      const encoderConfig = await findSupportedAvcConfig(width, height);
      if (!encoderConfig) {
        console.warn(`p5.recorder: no H.264 encoder for ${width}×${height} — skipping browser MP4`);
        return null;
      }

      const muxerTarget = new Mp4Muxer.ArrayBufferTarget();
      const muxer = new Mp4Muxer.Muxer({
        target: muxerTarget,
        video: { codec: "avc", width, height, frameRate: getOutputFramerate() },
        fastStart: "in-memory", // moov atom up front → plays/streams immediately
      });
      const encoder = new VideoEncoder({
        output: (chunk, metadata) => muxer.addVideoChunk(chunk, withRec709ColorSpace(metadata)),
        error: (error) => console.error("p5.recorder: browser MP4 encoder error", error),
      });
      encoder.configure(encoderConfig);
      return { kind: "mp4", encoder, muxer, muxerTarget, sourceFrameIndex: 0, frameIndex: 0, width, height };
    } catch (error) {
      console.warn("p5.recorder: browser MP4 disabled —", error.message);
      return null;
    }
  };

  /** Overrides the decoder config's color tag (sRGB from canvas) with Rec. 709 for the MP4 `colr` box. */
  const withRec709ColorSpace = (metadata) => {
    if (!metadata?.decoderConfig) return metadata;
    return { ...metadata, decoderConfig: { ...metadata.decoderConfig, colorSpace: RECORDER_BROWSER_MP4_COLOR_SPACE } };
  };

  /** Encodes the current canvas as the next video frame (timestamps are frame-exact, not wall-clock). */
  const encodeMp4Frame = (browserEncoder) => {
    const outputFramerate = getOutputFramerate();
    const frameDurationMicros = 1e6 / outputFramerate;
    const keyframeInterval = Math.max(1, Math.round(outputFramerate * RECORDER_BROWSER_MP4_KEYFRAME_SECONDS));
    const frame = new VideoFrame(p5.instance.canvas, {
      timestamp: Math.round(browserEncoder.frameIndex * frameDurationMicros),
      duration: Math.round(frameDurationMicros),
      // crop to the even size used by the encoder
      visibleRect: { x: 0, y: 0, width: browserEncoder.width, height: browserEncoder.height },
    });
    browserEncoder.encoder.encode(frame, { keyFrame: browserEncoder.frameIndex % keyframeInterval === 0 });
    frame.close();
  };

  /** Flushes the encoder, finalises the MP4 and downloads it. */
  const finishMp4Encoder = async (browserEncoder, sessionName) => {
    try {
      await browserEncoder.encoder.flush();
      browserEncoder.muxer.finalize();
      const blob = new Blob([browserEncoder.muxerTarget.buffer], { type: "video/mp4" });
      downloadBlob(blob, `${sessionName}-web.mp4`);
      console.log(`p5.recorder: browser MP4 ready (${(blob.size / 1e6).toFixed(1)} MB)`);
    } catch (error) {
      console.error("p5.recorder: failed to finalise browser MP4", error);
    } finally {
      if (browserEncoder.encoder.state !== "closed") browserEncoder.encoder.close();
    }
  };

  // ─── In-browser GIF (gif.js) ───────────────────────────────────────────────

  /** Sets up a gif.js encoder; its worker runs from a blob URL because CDN workers are cross-origin. */
  const createGifEncoder = async (width, height) => {
    try {
      await loadScriptOnce(RECORDER_GIF_LIBRARY_URL);
      const workerUrl = URL.createObjectURL(
        new Blob([`importScripts("${RECORDER_GIF_WORKER_URL}")`], { type: "text/javascript" }));
      const gif = new GIF({
        width,
        height,
        quality: RECORDER_GIF_QUALITY,
        dither: RECORDER_GIF_DITHER,
        repeat: RECORDER_GIF_LOOP_COUNT,
        workers: RECORDER_GIF_WORKERS,
        workerScript: workerUrl,
      });
      return { kind: "gif", gif, workerUrl, sourceFrameIndex: 0, frameIndex: 0, width, height };
    } catch (error) {
      console.warn("p5.recorder: GIF disabled —", error.message);
      return null;
    }
  };

  /** Copies the current canvas into the GIF (cropped to the even output size). */
  const addGifFrame = (gifEncoder) => {
    // GIF delays are whole centiseconds: carry the rounding error so the total length stays exact (30 fps → 3,3,4 cs…)
    const centisecondsPerFrame = 100 / (settings.framerate / getFrameStep());
    const frameIndex = gifEncoder.frameIndex;
    const delayCentiseconds = Math.round((frameIndex + 1) * centisecondsPerFrame) - Math.round(frameIndex * centisecondsPerFrame);
    gifEncoder.gif.addFrame(p5.instance.canvas, { delay: delayCentiseconds * 10, copy: true });
  };

  /** Renders the GIF in the workers, downloads it and frees the workers. */
  const finishGifEncoder = (gifEncoder, sessionName) => new Promise((resolve) => {
    const { gif, workerUrl } = gifEncoder;
    const cleanUp = () => {
      gif.freeWorkers.forEach((worker) => worker.terminate()); // gif.js keeps idle workers alive otherwise
      URL.revokeObjectURL(workerUrl);
      resolve();
    };
    if (gifEncoder.frameIndex === 0) return cleanUp();

    gif.on("finished", (blob) => {
      downloadBlob(blob, `${sessionName}.gif`);
      console.log(`p5.recorder: GIF ready (${(blob.size / 1e6).toFixed(1)} MB, ${gifEncoder.frameIndex} frames)`);
      cleanUp();
    });
    gif.render();
  });

  // ─── p5.capture options + manifest ─────────────────────────────────────────

  /** Builds the option object p5.capture.start() expects, sized for the export density. */
  const buildCaptureOptions = (width, height) => {
    const isImageSequence = IMAGE_SEQUENCE_FORMATS.includes(settings.format);
    return {
      format: settings.format,
      framerate: settings.framerate,
      quality: settings.quality,
      bitrate: settings.mp4BitrateKbps,
      width,
      height,
      duration: settings.durationSeconds ? Math.round(settings.durationSeconds * settings.framerate) : null,
      autoSaveDuration: isImageSequence ? settings.autoSaveEveryFrames : null,
      // one name per zip part; frame filenames inside are numbered continuously across parts
      baseFilename: () => `${session.name}-part${padNumber(++session.partCount, 3)}`,
      // not calling p5.capture's download callback discards the part (zips still auto-save, so memory stays capped)
      beforeDownload: isFrameDownloadEnabled() ? undefined : () => {},
    };
  };

  /** Downloads the manifest render-recordings.mjs waits for before rendering. */
  const writeManifest = (finishedSession) => {
    if (!settings.shouldWriteManifest || !isFrameDownloadEnabled() || !IMAGE_SEQUENCE_FORMATS.includes(settings.format)) return;
    const manifest = {
      session: finishedSession.name,
      preset: settings.preset,
      format: settings.format,
      framerate: settings.framerate,
      outputFramerate: getOutputFramerate(),
      frameCount: finishedSession.capturedFrames,
      width: finishedSession.width,
      height: finishedSession.height,
    };
    const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" });
    downloadBlob(blob, `${finishedSession.name}.recording.json`);
  };

  // ─── Toggle button ─────────────────────────────────────────────────────────

  /** Injects the button's CSS once, so the file stays drop-in with no stylesheet edits. */
  const injectButtonStyles = () => {
    styleElement = document.createElement("style");
    styleElement.textContent = `
      .${CONTROLS_CLASS} {
        position: fixed; z-index: 9999;
        top: ${RECORDER_BUTTON_POSITION.top}; right: ${RECORDER_BUTTON_POSITION.right};
        display: flex; align-items: center; gap: 0.5rem;
      }
      .${PRESET_SWITCH_CLASS} {
        display: flex; padding: 0.25rem; gap: 0.25rem;
        background: ${RECORDER_BUTTON_COLORS.idle}; border-radius: 999px; opacity: 0.85;
      }
      .${PRESET_SWITCH_CLASS}:hover, .${PRESET_SWITCH_CLASS}:focus-within { opacity: 1; }
      .${PRESET_SWITCH_CLASS} button {
        min-height: 36px; padding: 0 0.875rem;
        font: 600 0.8125rem/1 system-ui, sans-serif; color: ${RECORDER_BUTTON_COLORS.text};
        background: transparent; border: none; border-radius: 999px; cursor: pointer;
        touch-action: manipulation;
      }
      .${PRESET_SWITCH_CLASS} button[aria-pressed="true"] {
        color: ${RECORDER_BUTTON_COLORS.idle}; background: ${RECORDER_BUTTON_COLORS.text};
      }
      .${PRESET_SWITCH_CLASS} button:focus-visible { outline: 2px solid ${RECORDER_BUTTON_COLORS.capturing}; outline-offset: 1px; }
      .${PRESET_SWITCH_CLASS} button:disabled { cursor: not-allowed; opacity: 0.6; }
      .${BUTTON_CLASS} {
        min-width: 44px; min-height: 44px; padding: 0.5rem 1rem;
        font: 600 0.875rem/1 system-ui, sans-serif;
        color: ${RECORDER_BUTTON_COLORS.text}; background: ${RECORDER_BUTTON_COLORS.idle};
        border: none; border-radius: 999px; cursor: pointer; opacity: 0.85;
        touch-action: manipulation;
      }
      .${BUTTON_CLASS}:hover, .${BUTTON_CLASS}:focus-visible { opacity: 1; }
      .${BUTTON_CLASS}:focus-visible { outline: 2px solid ${RECORDER_BUTTON_COLORS.capturing}; outline-offset: 2px; }
      .${BUTTON_CLASS}[data-state="capturing"] { background: ${RECORDER_BUTTON_COLORS.capturing}; }
      .${BUTTON_CLASS}:disabled { cursor: progress; opacity: 0.6; }
    `;
    document.head.appendChild(styleElement);
  };

  /** Recorder state as shown on the button (setup / finalising count as "encoding"). */
  const getButtonState = () => {
    if (isStarting) return "encoding";
    const state = getState();
    if (state === "idle" && session) return "encoding"; // browser MP4 / manifest still finishing
    return state;
  };

  /** Syncs the button's label, aria state and disabled flag with the recorder state. */
  const updateButton = () => {
    if (!toggleButton) return;
    const state = getButtonState();
    if (toggleButton.dataset.state === state) return; // avoid DOM writes every frame
    toggleButton.dataset.state = state;
    toggleButton.textContent = RECORDER_BUTTON_LABELS[state];
    toggleButton.setAttribute("aria-pressed", String(state === "capturing"));
    toggleButton.setAttribute("aria-label", state === "capturing" ? "Stop recording" : "Start recording");
    toggleButton.disabled = state === "encoding";
    updatePresetSwitch(); // lock / unlock with the recording state
  };

  /** Short spec line for a preset, e.g. "≤1080 px wide · 30 fps · 16 Mbps" (used as the option's tooltip). */
  const describePreset = ({ outputFramerate, browserMp4BitrateMbps, maxOutputWidth, browserOutput }) => [
    maxOutputWidth ? `≤${maxOutputWidth} px wide` : "full resolution",
    outputFramerate ? `${outputFramerate} fps` : "capture fps",
    browserOutput === "gif" ? "looping GIF" : `${browserMp4BitrateMbps} Mbps`,
  ].join(" · ");

  /** Marks the active preset and locks the switch unless the recorder is idle. */
  const updatePresetSwitch = () => {
    if (!presetSwitch) return;
    const isLocked = getButtonState() !== "idle"; // the preset is read when a recording starts
    for (const option of presetSwitch.children) {
      option.setAttribute("aria-pressed", String(option.dataset.preset === settings.preset));
      option.disabled = isLocked;
    }
  };

  /** Switch handler: applies + remembers the preset (ignored while recording). */
  const selectPreset = (preset) => {
    if (!RECORDER_EXPORT_PRESETS[preset] || getButtonState() !== "idle") return;
    settings.preset = preset;
    savedPreset = preset;
    writeSavedPreset(preset);
    updatePresetSwitch();
    console.log(`p5.recorder: export preset "${preset}" (${describePreset(getPreset())})`);
  };

  const handlePresetClick = (event) => {
    const option = event.target.closest("button[data-preset]");
    if (option) selectPreset(option.dataset.preset);
  };

  /** Builds the Instagram | True HD switch: one native button per preset (keyboard + screen-reader friendly). */
  const createPresetSwitch = () => {
    presetSwitch = document.createElement("div");
    presetSwitch.className = PRESET_SWITCH_CLASS;
    presetSwitch.setAttribute("role", "group");
    presetSwitch.setAttribute("aria-label", "Export preset");
    for (const [preset, label] of Object.entries(RECORDER_PRESET_LABELS)) {
      if (!RECORDER_EXPORT_PRESETS[preset]) continue;
      const option = document.createElement("button");
      option.type = "button";
      option.textContent = label;
      option.title = describePreset(RECORDER_EXPORT_PRESETS[preset]);
      option.dataset.preset = preset;
      presetSwitch.appendChild(option);
    }
    presetSwitch.addEventListener("click", handlePresetClick);
    return presetSwitch;
  };

  /** Creates the floating controls: preset switch (optional) + Record / Stop button. */
  const createButton = () => {
    injectButtonStyles();
    controlsElement = document.createElement("div");
    controlsElement.className = CONTROLS_CLASS;
    if (RECORDER_SHOW_PRESET_SWITCH) controlsElement.appendChild(createPresetSwitch());
    toggleButton = document.createElement("button");
    toggleButton.type = "button";
    toggleButton.className = BUTTON_CLASS;
    toggleButton.addEventListener("click", handleToggleClick);
    controlsElement.appendChild(toggleButton);
    document.body.appendChild(controlsElement);
    updateButton();
    updatePresetSwitch();
  };

  // ─── Recording control ─────────────────────────────────────────────────────

  const start = async () => {
    const capture = getCapture();
    if (!capture) return console.warn("p5.recorder: not ready yet");
    if (capture.state !== "idle" || session || isStarting) return console.warn("p5.recorder: busy");

    isStarting = true;
    updateButton();
    const sketch = p5.instance;
    // change density only for the recording (export density, capped by the preset's max width); restored in finishSession()
    const maxOutputWidth = getMaxOutputWidth();
    let targetDensity = settings.exportPixelDensity || sketch.pixelDensity();
    if (maxOutputWidth) targetDensity = Math.min(targetDensity, maxOutputWidth / sketch.width);
    if (targetDensity !== sketch.pixelDensity()) {
      densityBeforeRecording = sketch.pixelDensity();
      sketch.pixelDensity(targetDensity);
    }

    // even dimensions keep H.264 encoders happy
    const outputDensity = sketch.pixelDensity();
    const width = Math.floor((sketch.width * outputDensity) / 2) * 2;
    const height = Math.floor((sketch.height * outputDensity) / 2) * 2;

    const browserEncoder = await createBrowserEncoder(width, height);
    session = { name: createSessionName(), partCount: 0, capturedFrames: 0, width, height, browserEncoder };

    // p5 increments frameCount before draw(), so the first recorded frame is frameCount 1 — same as a fresh run
    if (settings.shouldResetFrameCount) sketch.frameCount = 0;

    await capture.start(buildCaptureOptions(width, height));
    isStarting = false;
    console.log(`p5.recorder: recording "${session.name}" [${settings.preset}] at ${width}×${height} ${settings.format}, ` +
      `${settings.framerate} → ${getOutputFramerate()} fps` +
      (browserEncoder ? ` + browser ${browserEncoder.kind.toUpperCase()}` : ""));
  };

  const stop = () => {
    const capture = getCapture();
    if (!capture || capture.state !== "capturing") return;
    capture.stop(); // encoding + zip download happen asynchronously inside p5.capture
  };

  const toggle = () => (isRecording() ? stop() : start());

  /** Wraps up once capturing ends (manual stop or duration reached): density, MP4, manifest. */
  const finishSession = async () => {
    document.title = originalTitle;
    if (densityBeforeRecording !== null) {
      p5.instance.pixelDensity(densityBeforeRecording);
      densityBeforeRecording = null;
    }
    const finishedSession = session;
    if (!finishedSession) return;
    console.log(`p5.recorder: captured ${finishedSession.capturedFrames} frames`);
    if (finishedSession.browserEncoder) await finishBrowserEncoder(finishedSession.browserEncoder, finishedSession.name);
    writeManifest(finishedSession);
    session = null;
    updateButton();
  };

  /** Runs after every draw() (after p5.capture's own hook): counts/encodes frames, detects stop. */
  const handlePostDraw = () => {
    const isCapturingNow = isRecording();
    if (isCapturingNow && session) {
      session.capturedFrames++;
      if (session.browserEncoder) encodeBrowserFrame(session.browserEncoder);
      document.title = RECORDER_TITLE_PREFIX + originalTitle;
    }
    if (wasCapturing && !isCapturingNow) finishSession();
    wasCapturing = isCapturingNow;
    updateButton();
  };

  const handleToggleClick = () => {
    toggle();
    updateButton();
  };

  /** Removes the controls, their styles and all listeners. */
  const destroy = () => {
    toggleButton?.removeEventListener("click", handleToggleClick);
    presetSwitch?.removeEventListener("click", handlePresetClick);
    controlsElement?.remove();
    styleElement?.remove();
    toggleButton = null;
    presetSwitch = null;
    controlsElement = null;
    styleElement = null;
    window.removeEventListener("pagehide", destroy);
  };

  if (window.p5) p5.prototype.registerMethod("post", handlePostDraw);
  // script loads in <head>, so wait for <body> before adding the button
  if (document.body) createButton();
  else document.addEventListener("DOMContentLoaded", createButton, { once: true });
  window.addEventListener("pagehide", destroy);

  return { start, stop, toggle, isRecording, configure, destroy, settings };
})();
