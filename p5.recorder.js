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
 * Usage: click the floating Record / Stop button (it's DOM, so it never appears in the recording).
 * Optional per-sketch overrides from setup():
 *   Recorder.configure({ durationSeconds: 8, exportPixelDensity: 2 });
 *
 * Each recording is a "session" that downloads:
 *   <session>-part001.zip …        PNG frames (p5.capture)
 *   <session>-web.mp4              quick H.264 encoded in the browser (WebCodecs), if enabled + supported
 *   <session>.recording.json       manifest — tells render-recordings.mjs the session is complete
 * Run `node render-recordings.mjs` in a terminal to turn the zips into <session>.mp4 + <session>-prores.mov.
 */

// ─── Tuneable parameters ──────────────────────────────────────────────────────
const RECORDER_FORMAT = "png";              // "png" | "jpg" | "webp" (zipped sequences) | "mp4" | "webm" | "gif"
const RECORDER_FRAMERATE = 60;              // playback fps written into the video / manifest
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
const RECORDER_BROWSER_MP4_BITRATE_MBPS = 40;     // high-res text needs a high bitrate to stay crisp
const RECORDER_BROWSER_MP4_KEYFRAME_SECONDS = 2;  // keyframe interval (seeking granularity)
const RECORDER_MP4_MUXER_URL = "https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.2/build/mp4-muxer.min.js";

// toggle button
const RECORDER_BUTTON_LABELS = { idle: "● Record", capturing: "■ Stop", encoding: "Encoding…" };
const RECORDER_BUTTON_POSITION = { top: "1rem", right: "1rem" }; // any CSS inset values
const RECORDER_BUTTON_COLORS = { idle: "#222", capturing: "#d62828", text: "#fff" };
// ──────────────────────────────────────────────────────────────────────────────

const Recorder = (() => {
  const IMAGE_SEQUENCE_FORMATS = ["png", "jpg", "webp"];
  const BUTTON_CLASS = "p5-recorder-toggle";
  // H.264 High profile, highest level first; level 5.x is needed above ~1080p
  const AVC_CODEC_CANDIDATES = ["avc1.640034", "avc1.640033", "avc1.640032", "avc1.640028"];

  // Runtime settings; start from the constants above, overridable via Recorder.configure().
  const settings = {
    format: RECORDER_FORMAT,
    framerate: RECORDER_FRAMERATE,
    durationSeconds: RECORDER_DURATION_SECONDS,
    exportPixelDensity: RECORDER_EXPORT_PIXEL_DENSITY,
    shouldResetFrameCount: RECORDER_RESET_FRAMECOUNT,
    mp4BitrateKbps: RECORDER_MP4_BITRATE_KBPS,
    quality: RECORDER_QUALITY,
    autoSaveEveryFrames: RECORDER_AUTO_SAVE_EVERY_FRAMES,
    filenamePrefix: RECORDER_FILENAME_PREFIX,
    shouldWriteManifest: RECORDER_WRITE_MANIFEST,
    shouldEncodeBrowserMp4: RECORDER_BROWSER_MP4,
    browserMp4BitrateMbps: RECORDER_BROWSER_MP4_BITRATE_MBPS,
  };

  let densityBeforeRecording = null; // restored once capturing ends
  let wasCapturing = false;          // previous-frame state, to detect auto-stop by duration
  let isStarting = false;            // guards double-clicks while start() awaits encoder setup
  let toggleButton = null;
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

  /** Merges per-sketch overrides into the runtime settings. */
  const configure = (overrides = {}) => Object.assign(settings, overrides);

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

  // ─── In-browser H.264 (WebCodecs → mp4-muxer) ──────────────────────────────

  /** Picks the first H.264 config this browser can encode at the given size, or null. */
  const findSupportedAvcConfig = async (width, height) => {
    for (const codec of AVC_CODEC_CANDIDATES) {
      const config = {
        codec,
        width,
        height,
        bitrate: settings.browserMp4BitrateMbps * 1e6,
        framerate: settings.framerate,
        latencyMode: "quality",
        avc: { format: "avc" }, // length-prefixed NALUs, required by MP4
      };
      const { supported } = await VideoEncoder.isConfigSupported(config).catch(() => ({ supported: false }));
      if (supported) return config;
    }
    return null;
  };

  /** Sets up an encoder + muxer pair; returns null (with a console note) if unavailable. */
  const createBrowserEncoder = async (width, height) => {
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
        video: { codec: "avc", width, height, frameRate: settings.framerate },
        fastStart: "in-memory", // moov atom up front → plays/streams immediately
      });
      const encoder = new VideoEncoder({
        output: (chunk, metadata) => muxer.addVideoChunk(chunk, metadata),
        error: (error) => console.error("p5.recorder: browser MP4 encoder error", error),
      });
      encoder.configure(encoderConfig);
      return { encoder, muxer, muxerTarget, frameIndex: 0, width, height };
    } catch (error) {
      console.warn("p5.recorder: browser MP4 disabled —", error.message);
      return null;
    }
  };

  /** Encodes the current canvas as the next video frame (timestamps are frame-exact, not wall-clock). */
  const encodeBrowserFrame = (browserEncoder) => {
    const frameDurationMicros = 1e6 / settings.framerate;
    const keyframeInterval = Math.max(1, Math.round(settings.framerate * RECORDER_BROWSER_MP4_KEYFRAME_SECONDS));
    const frame = new VideoFrame(p5.instance.canvas, {
      timestamp: Math.round(browserEncoder.frameIndex * frameDurationMicros),
      duration: Math.round(frameDurationMicros),
      // crop to the even size used by the encoder
      visibleRect: { x: 0, y: 0, width: browserEncoder.width, height: browserEncoder.height },
    });
    browserEncoder.encoder.encode(frame, { keyFrame: browserEncoder.frameIndex % keyframeInterval === 0 });
    frame.close();
    browserEncoder.frameIndex++;
  };

  /** Flushes the encoder, finalises the MP4 and downloads it. */
  const finishBrowserEncoder = async (browserEncoder, sessionName) => {
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
    };
  };

  /** Downloads the manifest render-recordings.mjs waits for before rendering. */
  const writeManifest = (finishedSession) => {
    if (!settings.shouldWriteManifest || !IMAGE_SEQUENCE_FORMATS.includes(settings.format)) return;
    const manifest = {
      session: finishedSession.name,
      format: settings.format,
      framerate: settings.framerate,
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
      .${BUTTON_CLASS} {
        position: fixed; z-index: 9999;
        top: ${RECORDER_BUTTON_POSITION.top}; right: ${RECORDER_BUTTON_POSITION.right};
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
  };

  /** Creates the floating Record / Stop button. */
  const createButton = () => {
    injectButtonStyles();
    toggleButton = document.createElement("button");
    toggleButton.type = "button";
    toggleButton.className = BUTTON_CLASS;
    toggleButton.addEventListener("click", handleToggleClick);
    document.body.appendChild(toggleButton);
    updateButton();
  };

  // ─── Recording control ─────────────────────────────────────────────────────

  const start = async () => {
    const capture = getCapture();
    if (!capture) return console.warn("p5.recorder: not ready yet");
    if (capture.state !== "idle" || session || isStarting) return console.warn("p5.recorder: busy");

    isStarting = true;
    updateButton();
    const sketch = p5.instance;
    // bump density only for the recording; restored in finishSession()
    if (settings.exportPixelDensity && settings.exportPixelDensity !== sketch.pixelDensity()) {
      densityBeforeRecording = sketch.pixelDensity();
      sketch.pixelDensity(settings.exportPixelDensity);
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
    console.log(`p5.recorder: recording "${session.name}" at ${width}×${height} ${settings.format}` +
      (browserEncoder ? " + browser MP4" : ""));
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

  /** Removes the button, its styles and all listeners. */
  const destroy = () => {
    toggleButton?.removeEventListener("click", handleToggleClick);
    toggleButton?.remove();
    styleElement?.remove();
    toggleButton = null;
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
