#!/usr/bin/env node
/**
 * 离线导出审核目录中的普通 / 智能 EDL。
 *
 * 用法:
 *   node export_review_edl.js <review_dir> [--smart]
 *   node export_review_edl.js <review_dir> [--input delete_segments.json] [--output out.edl]
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SKILL_DIR = '/Users/xiaoshan/.claude/skills/剪口播';
const SMART_EDL_SCRIPT = path.join(SKILL_DIR, 'scripts', 'smart_edl.py');

function usage() {
  console.error('用法: node export_review_edl.js <review_dir> [--smart] [--input file.json] [--output out.edl]');
  process.exit(1);
}

function parseArgs(argv) {
  if (argv.length === 0) usage();

  const options = {
    reviewDir: path.resolve(argv[0]),
    smart: false,
    inputFile: null,
    outputFile: null,
  };

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--smart') {
      options.smart = true;
      continue;
    }
    if (arg === '--input') {
      options.inputFile = argv[++i];
      continue;
    }
    if (arg === '--output') {
      options.outputFile = argv[++i];
      continue;
    }
    usage();
  }

  return options;
}

function ensureDir(dirPath, label) {
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    throw new Error(`${label}不存在: ${dirPath}`);
  }
}

function ensureFile(filePath, label) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`${label}不存在: ${filePath}`);
  }
}

function isVideoFile(filePath) {
  return /\.(mp4|mkv|mov|avi|m4v|webm)$/i.test(filePath);
}

function findSourceVideo(reviewDir) {
  const entries = fs.readdirSync(reviewDir);
  const preferred = entries
    .filter((name) => /^source\./i.test(name))
    .map((name) => path.join(reviewDir, name))
    .find((fullPath) => {
      try {
        return isVideoFile(fullPath) && fs.statSync(fullPath).isFile();
      } catch (_) {
        return false;
      }
    });

  if (preferred) {
    return preferred;
  }

  const candidates = entries
    .filter((name) => isVideoFile(name))
    .map((name) => path.join(reviewDir, name));

  if (candidates.length === 1) {
    return candidates[0];
  }

  throw new Error(`无法自动找到审核源视频，请先在审核目录中补 source.mp4/source.mkv: ${reviewDir}`);
}

function secondsToTimecode(seconds, fps) {
  const totalFrames = Math.round(seconds * fps);
  const frames = totalFrames % fps;
  const totalSeconds = Math.floor(totalFrames / fps);
  const secs = totalSeconds % 60;
  const mins = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}:${String(frames).padStart(2, '0')}`;
}

function framesToTimecode(totalFrames, fps) {
  const safeFrames = Math.max(0, totalFrames);
  const frames = safeFrames % fps;
  const totalSeconds = Math.floor(safeFrames / fps);
  const secs = totalSeconds % 60;
  const mins = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}:${String(frames).padStart(2, '0')}`;
}

function timecodeToFrames(timecode, fps) {
  if (!timecode || !/^\d{2}:\d{2}:\d{2}:\d{2}$/.test(timecode)) {
    return 0;
  }
  const [hours, mins, secs, frames] = timecode.split(':').map((v) => parseInt(v, 10));
  return ((((hours * 60) + mins) * 60) + secs) * fps + frames;
}

function secondsToFrames(seconds, fps) {
  return Math.round(seconds * fps);
}

function getVideoDuration(videoPath) {
  const raw = execFileSync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=duration:format=duration',
    '-of', 'json',
    `file:${videoPath}`,
  ], { encoding: 'utf8' }).trim();

  const parsed = JSON.parse(raw || '{}');
  const streamDuration = parseFloat(parsed.streams?.[0]?.duration);
  if (Number.isFinite(streamDuration) && streamDuration > 0) {
    return streamDuration;
  }

  const formatDuration = parseFloat(parsed.format?.duration);
  if (Number.isFinite(formatDuration) && formatDuration > 0) {
    return formatDuration;
  }

  throw new Error(`无法探测视频时长: ${videoPath}`);
}

function getVideoFPS(videoPath) {
  const result = execFileSync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=r_frame_rate',
    '-of', 'csv=p=0',
    `file:${videoPath}`,
  ], { encoding: 'utf8' }).trim();

  const parts = result.split('/');
  if (parts.length === 2) {
    return Math.round(parseFloat(parts[0]) / parseFloat(parts[1]));
  }
  return parseFloat(result) || 25;
}

function getSourceTimecodeStart(videoPath, fps) {
  try {
    const raw = execFileSync('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream_tags=timecode:format_tags=timecode',
      '-of', 'json',
      `file:${videoPath}`,
    ], { encoding: 'utf8' }).trim();

    const parsed = JSON.parse(raw || '{}');
    const streamTag = parsed.streams?.[0]?.tags?.timecode;
    const formatTag = parsed.format?.tags?.timecode;
    const timecode = streamTag || formatTag;
    return timecodeToFrames(timecode, fps);
  } catch (_) {
    return 0;
  }
}

function normalizeKeepSegments(keepSegments, duration, fps) {
  const durationFrames = Math.max(0, Math.floor(duration * fps + 1e-6));
  const normalized = [];

  for (const seg of keepSegments) {
    const startFrame = Math.max(0, Math.min(durationFrames, secondsToFrames(seg.start, fps)));
    const endFrame = Math.max(startFrame, Math.min(durationFrames, secondsToFrames(seg.end, fps)));
    if (endFrame > startFrame) {
      normalized.push({ startFrame, endFrame });
    }
  }

  return { normalized, durationFrames };
}

function generatePlainEdl(videoPath, segments, outputFile) {
  const duration = getVideoDuration(videoPath);
  const fps = getVideoFPS(videoPath);
  const BUFFER_SEC = 0.05;
  const GAP_THRESHOLD = 0.3;
  const expandedDelete = segments
    .map((seg) => ({
      start: Math.max(0, seg.start - BUFFER_SEC),
      end: Math.min(duration, seg.end + BUFFER_SEC),
    }))
    .sort((a, b) => a.start - b.start);

  const mergedDelete = [];
  for (const seg of expandedDelete) {
    if (mergedDelete.length === 0 || seg.start > mergedDelete[mergedDelete.length - 1].end + GAP_THRESHOLD) {
      mergedDelete.push({ ...seg });
    } else {
      mergedDelete[mergedDelete.length - 1].end = Math.max(mergedDelete[mergedDelete.length - 1].end, seg.end);
    }
  }

  const keepSegments = [];
  let cursor = 0;
  for (const del of mergedDelete) {
    if (del.start > cursor) keepSegments.push({ start: cursor, end: del.start });
    cursor = del.end;
  }
  if (cursor < duration) keepSegments.push({ start: cursor, end: duration });
  const { normalized: normalizedKeepSegments } = normalizeKeepSegments(keepSegments, duration, fps);

  const title = path.basename(videoPath, path.extname(videoPath));
  const reelName = title.substring(0, 8).toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  const sourceTcStartFrames = getSourceTimecodeStart(videoPath, fps);

  let edl = `TITLE: ${title}\nFCM: NON-DROP FRAME\n\n`;
  let recordFrames = 0;
  normalizedKeepSegments.forEach((seg, i) => {
    const eventNum = String(i + 1).padStart(3, '0');
    const srcIn = framesToTimecode(sourceTcStartFrames + seg.startFrame, fps);
    const srcOut = framesToTimecode(sourceTcStartFrames + seg.endFrame, fps);
    const recIn = framesToTimecode(recordFrames, fps);
    recordFrames += seg.endFrame - seg.startFrame;
    const recOut = framesToTimecode(recordFrames, fps);
    edl += `${eventNum}  ${reelName.padEnd(8)}  V     C        ${srcIn} ${srcOut} ${recIn} ${recOut}\n`;
  });

  fs.writeFileSync(outputFile, edl);
  return {
    mode: 'plain',
    fps,
    keepSegments: normalizedKeepSegments.length,
    deletedSegments: mergedDelete.length,
    keptDuration: (recordFrames / fps).toFixed(2),
    deletedDuration: (duration - (recordFrames / fps)).toFixed(2),
  };
}

function normalizeSmartPayload(payload) {
  if (Array.isArray(payload)) {
    return {
      deleteSegments: payload,
      optimizeKeep: true,
    };
  }
  return payload;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  ensureDir(options.reviewDir, '审核目录');

  const videoPath = findSourceVideo(options.reviewDir);
  const defaultInput = options.smart ? 'delete_segments.json' : 'delete_segments.json';
  const inputFile = path.resolve(options.reviewDir, options.inputFile || defaultInput);
  ensureFile(inputFile, '切分数据文件');

  const title = path.basename(videoPath, path.extname(videoPath));
  const outputFile = path.resolve(
    options.reviewDir,
    options.outputFile || `${title}${options.smart ? '_cut_smart.edl' : '_cut.edl'}`
  );

  let summary;
  if (options.smart) {
    const smartPayload = normalizeSmartPayload(JSON.parse(fs.readFileSync(inputFile, 'utf8')));
    const smartInputFile = path.resolve(options.reviewDir, '.smart_edl_input.json');
    fs.writeFileSync(smartInputFile, JSON.stringify(smartPayload, null, 2));

    execFileSync('python3', [
      SMART_EDL_SCRIPT,
      videoPath,
      smartInputFile,
      outputFile,
      '--search-ms',
      '50',
    ], {
      cwd: options.reviewDir,
      stdio: 'inherit',
    });
    summary = { mode: 'smart' };
    try {
      fs.unlinkSync(smartInputFile);
    } catch (_) {
      // Ignore cleanup errors.
    }
  } else {
    const payload = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
    if (!Array.isArray(payload)) {
      throw new Error(`普通 EDL 仅支持 delete_segments.json 数组输入: ${inputFile}`);
    }
    summary = generatePlainEdl(videoPath, payload, outputFile);
  }

  console.log(JSON.stringify({
    success: true,
    videoPath,
    inputFile,
    outputFile,
    ...summary,
  }, null, 2));
}

main();
