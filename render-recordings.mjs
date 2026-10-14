#!/usr/bin/env node
/**
 * render-recordings.mjs — companion to p5.recorder.js.
 * Part of p5-HD-recorder: https://github.com/ronyginosar/p5-HD-recorder (MIT)
 * Watches a downloads folder; when a recording's manifest (<session>.recording.json) and all of its
 * PNG zip parts have arrived, unzips the frames and renders them with the local ffmpeg into:
 *   <session>.mp4         H.264, yuv420p — small, plays everywhere / Instagram
 *   <session>-prores.mov  ProRes 422 HQ, 10-bit — for editing
 * Both are Rec. 709 SDR. fps / bitrate cap follow the recording's export preset ("instagram" | "trueHD").
 * Outputs land next to the zips. Requires ffmpeg + unzip on PATH (both standard on macOS w/ ffmpeg installed).
 *
 * Usage:
 *   node render-recordings.mjs                     # watch ~/Downloads until Ctrl+C
 *   node render-recordings.mjs --once              # render whatever is complete now, then exit
 *   node render-recordings.mjs --preset instagram  # force a preset instead of the manifest's
 *   node render-recordings.mjs --dir ~/Desktop/rec --codecs h264 --keep-frames
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// ─── Tuneable parameters ──────────────────────────────────────────────────────
const DEFAULT_WATCH_DIR = path.join(os.homedir(), "Downloads");
const DEFAULT_CODECS = ["h264", "prores"];   // which outputs to render
const POLL_INTERVAL_MS = 2000;               // how often to rescan the folder
const STALL_TIMEOUT_MS = 60000;              // render anyway if frames are missing and no new part arrived for this long
const KEEP_EXTRACTED_FRAMES = false;         // keep <session>-frames/ after rendering
const H264_CRF = 16;                         // lower = better quality / bigger file (18 ≈ visually lossless)
// export presets — the manifest's preset (set in p5.recorder.js) is used unless --preset overrides it
const DEFAULT_EXPORT_PRESET = "trueHD";      // for manifests written before presets existed
const EXPORT_PRESETS = {
  // Instagram: 30 fps, CRF peaks capped at 20 Mbps (its 1080p sweet spot is 15–20 Mbps)
  instagram: { outputFramerate: 30, h264MaxBitrateMbps: 20 },
  // full capture fps, uncapped CRF
  trueHD: { outputFramerate: null, h264MaxBitrateMbps: null },
};
const H264_PRESET = "slow";                  // slower = smaller file at the same quality
const PRORES_PROFILE = 3;                    // 0 proxy, 1 LT, 2 standard, 3 HQ, 4 4444
const MANIFEST_SUFFIX = ".recording.json";
// ──────────────────────────────────────────────────────────────────────────────

// Rec. 709 SDR, limited range: tags written into every output
const REC709_TAG_ARGS = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"];

/** ffmpeg output definitions; each gets the shared image-sequence input. buildArgs receives the export preset. */
const CODEC_OUTPUTS = {
  h264: {
    filenameSuffix: ".mp4",
    pixelFormat: "yuv420p",
    buildArgs: ({ h264MaxBitrateMbps }) => [
      "-c:v", "libx264", "-profile:v", "high", "-crf", String(H264_CRF), "-preset", H264_PRESET,
      // capped CRF: quality-driven, but peaks never exceed the max bitrate
      ...(h264MaxBitrateMbps ? ["-maxrate", `${h264MaxBitrateMbps}M`, "-bufsize", `${h264MaxBitrateMbps * 2}M`] : []),
      "-movflags", "+faststart"],
  },
  prores: {
    filenameSuffix: "-prores.mov",
    pixelFormat: "yuv422p10le",
    buildArgs: () => ["-c:v", "prores_ks", "-profile:v", String(PRORES_PROFILE), "-vendor", "apl0"],
  },
};

/**
 * Filter chain: drop frames to the output fps, pad to even size, then convert RGB → YUV
 * with the BT.709 matrix (ffmpeg's default for RGB input is BT.601, which shifts colors).
 */
const buildVideoFilter = (outputFramerate, pixelFormat) =>
  [`fps=${outputFramerate}`, "pad=ceil(iw/2)*2:ceil(ih/2)*2",
    "scale=out_color_matrix=bt709:out_range=tv", `format=${pixelFormat}`,
    "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv"].join(",");

/** Parses --dir, --codecs, --preset, --once, --keep-frames. */
const parseArguments = (argv) => {
  const options = {
    watchDir: DEFAULT_WATCH_DIR, codecs: DEFAULT_CODECS, presetOverride: null,
    isOnce: false, shouldKeepFrames: KEEP_EXTRACTED_FRAMES,
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--once") options.isOnce = true;
    else if (argument === "--keep-frames") options.shouldKeepFrames = true;
    else if (argument === "--dir") options.watchDir = path.resolve(argv[++index].replace(/^~(?=$|\/)/, os.homedir()));
    else if (argument === "--codecs") options.codecs = argv[++index].split(",").map((codec) => codec.trim());
    else if (argument === "--preset") options.presetOverride = argv[++index];
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (options.presetOverride && !EXPORT_PRESETS[options.presetOverride]) {
    throw new Error(`unknown preset: ${options.presetOverride} — use ${Object.keys(EXPORT_PRESETS).join(" or ")}`);
  }
  const unknownCodecs = options.codecs.filter((codec) => !CODEC_OUTPUTS[codec]);
  if (unknownCodecs.length) throw new Error(`unknown codec(s): ${unknownCodecs.join(", ")} — use h264,prores`);
  return options;
};

/** Runs a command; resolves with stdout, rejects with stderr on non-zero exit. */
const runCommand = (command, args, { shouldInheritOutput = false } = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: shouldInheritOutput ? ["ignore", "inherit", "inherit"] : "pipe" });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (data) => (stdout += data));
    child.stderr?.on("data", (data) => (stderr += data));
    child.on("error", reject);
    child.on("close", (exitCode) =>
      exitCode === 0 ? resolve(stdout) : reject(new Error(`${command} exited ${exitCode}\n${stderr}`)));
  });

const fileExists = (filePath) => fs.access(filePath).then(() => true, () => false);

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// zip → image count, keyed by name+size so finished downloads are only listed once
const zipImageCountCache = new Map();

/** Counts image entries inside a zip without extracting it. */
const countImagesInZip = async (zipPath, imageExtension) => {
  const { size } = await fs.stat(zipPath);
  const cacheKey = `${zipPath}:${size}`;
  if (zipImageCountCache.has(cacheKey)) return zipImageCountCache.get(cacheKey);
  const listing = await runCommand("unzip", ["-Z1", zipPath]);
  const imageCount = listing.split("\n").filter((entry) => entry.endsWith(`.${imageExtension}`)).length;
  zipImageCountCache.set(cacheKey, imageCount);
  return imageCount;
};

/** Finds <session>-partNNN.zip files (fully downloaded ones only — browsers use temp names while writing). */
const findSessionParts = (fileNames, sessionName) => {
  const partPattern = new RegExp(`^${escapeRegExp(sessionName)}-part\\d+\\.zip$`);
  return fileNames.filter((fileName) => partPattern.test(fileName)).sort();
};

/** Extracts every part flat into one folder; frame names are already numbered continuously across parts. */
const extractFrames = async (watchDir, partNames, framesDir) => {
  await fs.rm(framesDir, { recursive: true, force: true });
  await fs.mkdir(framesDir, { recursive: true });
  for (const partName of partNames) {
    await runCommand("unzip", ["-q", "-o", "-j", path.join(watchDir, partName), "-d", framesDir]);
  }
};

/** Detects the first frame index + digit padding from the extracted filenames (p5.capture: 0000000.png). */
const detectFramePattern = async (framesDir, imageExtension) => {
  const imageNames = (await fs.readdir(framesDir)).filter((name) => name.endsWith(`.${imageExtension}`)).sort();
  if (!imageNames.length) throw new Error("no frames extracted");
  const firstStem = path.basename(imageNames[0], `.${imageExtension}`);
  if (!/^\d+$/.test(firstStem)) throw new Error(`unexpected frame name: ${imageNames[0]}`);
  return { inputPattern: `%0${firstStem.length}d.${imageExtension}`, startNumber: Number(firstStem), frameTotal: imageNames.length };
};

/** Picks the preset (--preset → manifest → default) and output fps (--preset → manifest → preset → capture fps). */
const resolveExportSettings = (manifest, presetOverride) => {
  const presetName = presetOverride ?? manifest.preset ?? DEFAULT_EXPORT_PRESET;
  const preset = EXPORT_PRESETS[presetName] ?? EXPORT_PRESETS[DEFAULT_EXPORT_PRESET];
  const requestedFramerate = presetOverride ? preset.outputFramerate : (manifest.outputFramerate ?? preset.outputFramerate);
  const outputFramerate = Math.min(requestedFramerate ?? manifest.framerate, manifest.framerate);
  return { presetName, preset, outputFramerate };
};

/** Renders one session to every requested codec. */
const renderSession = async ({ watchDir, manifest, partNames, codecs, presetOverride, shouldKeepFrames }) => {
  const sessionName = manifest.session;
  const imageExtension = manifest.format ?? "png";
  const framesDir = path.join(watchDir, `${sessionName}-frames`);

  console.log(`\n▶ ${sessionName}: extracting ${partNames.length} part(s)…`);
  await extractFrames(watchDir, partNames, framesDir);
  const { inputPattern, startNumber, frameTotal } = await detectFramePattern(framesDir, imageExtension);
  const { presetName, preset, outputFramerate } = resolveExportSettings(manifest, presetOverride);
  console.log(`  [${presetName}] ${frameTotal} frames @ ${manifest.framerate} fps → ${outputFramerate} fps ` +
    `(${manifest.width}×${manifest.height})`);

  for (const codec of codecs) {
    const { filenameSuffix, pixelFormat, buildArgs } = CODEC_OUTPUTS[codec];
    const outputPath = path.join(watchDir, `${sessionName}${filenameSuffix}`);
    console.log(`  rendering ${path.basename(outputPath)}…`);
    await runCommand("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error", "-stats",
      "-framerate", String(manifest.framerate),
      "-start_number", String(startNumber),
      "-i", path.join(framesDir, inputPattern),
      "-vf", buildVideoFilter(outputFramerate, pixelFormat),
      ...buildArgs(preset),
      ...REC709_TAG_ARGS,
      outputPath,
    ], { shouldInheritOutput: true });
  }

  if (!shouldKeepFrames) await fs.rm(framesDir, { recursive: true, force: true });
  console.log(`✔ ${sessionName} done`);
};

/**
 * Decides whether a session is ready: all expected frames present across its parts,
 * or frames still missing but no new part has arrived within STALL_TIMEOUT_MS.
 */
const sessionProgress = new Map(); // sessionName → { lastFrameCount, lastChangeTime }

const isSessionReady = async (watchDir, manifest, partNames) => {
  const imageExtension = manifest.format ?? "png";
  let frameCount = 0;
  for (const partName of partNames) frameCount += await countImagesInZip(path.join(watchDir, partName), imageExtension);

  const now = Date.now();
  const progress = sessionProgress.get(manifest.session);
  if (!progress || progress.lastFrameCount !== frameCount) {
    sessionProgress.set(manifest.session, { lastFrameCount: frameCount, lastChangeTime: now });
  }
  if (frameCount >= manifest.frameCount) return true;

  const isStalled = frameCount > 0 && now - sessionProgress.get(manifest.session).lastChangeTime > STALL_TIMEOUT_MS;
  if (isStalled) console.warn(`⚠ ${manifest.session}: only ${frameCount}/${manifest.frameCount} frames arrived — rendering anyway`);
  return isStalled;
};

/** One scan of the folder: renders every complete session that has no outputs yet. */
const scanOnce = async ({ watchDir, codecs, presetOverride, shouldKeepFrames }, sessionsInProgress) => {
  const fileNames = await fs.readdir(watchDir);
  const manifestNames = fileNames.filter((fileName) => fileName.endsWith(MANIFEST_SUFFIX));

  for (const manifestName of manifestNames) {
    const sessionName = manifestName.slice(0, -MANIFEST_SUFFIX.length);
    if (sessionsInProgress.has(sessionName)) continue;

    // skip sessions already rendered for every requested codec
    const outputPaths = codecs.map((codec) => path.join(watchDir, `${sessionName}${CODEC_OUTPUTS[codec].filenameSuffix}`));
    const existing = await Promise.all(outputPaths.map(fileExists));
    if (existing.every(Boolean)) continue;

    try {
      const manifest = JSON.parse(await fs.readFile(path.join(watchDir, manifestName), "utf8"));
      const partNames = findSessionParts(fileNames, sessionName);
      if (!partNames.length || !(await isSessionReady(watchDir, manifest, partNames))) continue;

      sessionsInProgress.add(sessionName);
      const missingCodecs = codecs.filter((_, index) => !existing[index]);
      await renderSession({ watchDir, manifest, partNames, codecs: missingCodecs, presetOverride, shouldKeepFrames });
    } catch (error) {
      console.error(`✖ ${sessionName}: ${error.message}`);
      sessionsInProgress.add(sessionName); // don't retry a broken session every poll
    }
  }
};

const main = async () => {
  const options = parseArguments(process.argv.slice(2));
  await runCommand("ffmpeg", ["-version"]).catch(() => {
    throw new Error("ffmpeg not found on PATH");
  });

  const sessionsInProgress = new Set();
  console.log(`Watching ${options.watchDir} for *${MANIFEST_SUFFIX} → ${options.codecs.join(" + ")}`);

  if (options.isOnce) return scanOnce(options, sessionsInProgress);

  // poll with setTimeout (not setInterval) so a long render never overlaps the next scan
  let pollTimer = null;
  const poll = async () => {
    await scanOnce(options, sessionsInProgress).catch((error) => console.error(error.message));
    pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
  };
  const handleExit = () => {
    clearTimeout(pollTimer);
    process.exit(0);
  };
  process.on("SIGINT", handleExit);
  process.on("SIGTERM", handleExit);
  poll();
};

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
