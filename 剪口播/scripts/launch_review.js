#!/usr/bin/env node
/**
 * 启动或恢复审核流程。
 *
 * 用法:
 *   node launch_review.js <video_path|review_dir|base_dir> [port]
 *
 * 作用:
 * 1. 自动定位 `3_审核/` 目录
 * 2. 检查并按需重新生成 `review.html`
 * 3. 启动审核服务器，继续使用已保存的 `selected.json`
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SKILL_DIR = '/Users/xiaoshan/.claude/skills/剪口播';
const GENERATE_REVIEW_SCRIPT = path.join(SKILL_DIR, 'scripts', 'generate_review.js');
const REVIEW_SERVER_SCRIPT = path.join(SKILL_DIR, 'scripts', 'review_server.js');

const inputArg = process.argv[2];
const port = process.argv[3] || '8899';

if (!inputArg) {
  console.error('❌ 用法: node launch_review.js <video_path|review_dir|base_dir> [port]');
  process.exit(1);
}

function resolveExistingPath(inputPath) {
  const absolutePath = path.resolve(inputPath);
  if (fs.existsSync(absolutePath)) {
    return absolutePath;
  }
  throw new Error(`路径不存在: ${absolutePath}`);
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

function findReviewDirFromVideo(videoPath) {
  const videoName = path.basename(videoPath, path.extname(videoPath));
  const searchRoots = [
    process.cwd(),
    path.dirname(videoPath),
    path.resolve(process.cwd(), 'output'),
    path.resolve(path.dirname(videoPath), 'output'),
  ];

  const candidates = [];
  const relativeSuffix = path.join('剪口播', '3_审核');

  for (const root of searchRoots) {
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      continue;
    }

    const directCandidate = path.join(root, relativeSuffix);
    if (fs.existsSync(directCandidate)) {
      candidates.push(directCandidate);
    }

    const outputDir = path.basename(root) === 'output' ? root : path.join(root, 'output');
    if (!fs.existsSync(outputDir) || !fs.statSync(outputDir).isDirectory()) {
      continue;
    }

    for (const entry of fs.readdirSync(outputDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.endsWith(`_${videoName}`)) continue;

      const reviewDir = path.join(outputDir, entry.name, relativeSuffix);
      if (fs.existsSync(reviewDir)) {
        candidates.push(reviewDir);
      }
    }
  }

  const uniqueCandidates = [...new Set(candidates)];
  if (uniqueCandidates.length === 1) {
    return uniqueCandidates[0];
  }

  if (uniqueCandidates.length > 1) {
    uniqueCandidates.sort((a, b) => {
      const aMtime = fs.statSync(a).mtimeMs;
      const bMtime = fs.statSync(b).mtimeMs;
      return bMtime - aMtime;
    });
    return uniqueCandidates[0];
  }

  throw new Error(`找不到视频对应的审核目录，请确认已完成过一次剪口播流程: ${videoPath}`);
}

function resolveReviewDir(inputPath) {
  const stat = fs.statSync(inputPath);

  if (stat.isFile()) {
    if (!isVideoFile(inputPath)) {
      throw new Error(`不支持的文件类型: ${inputPath}`);
    }
    return { reviewDir: findReviewDirFromVideo(inputPath), videoPath: inputPath };
  }

  const baseName = path.basename(inputPath);
  if (baseName === '3_审核') {
    return { reviewDir: inputPath, videoPath: null };
  }

  const nestedReviewDir = path.join(inputPath, '3_审核');
  if (fs.existsSync(nestedReviewDir) && fs.statSync(nestedReviewDir).isDirectory()) {
    return { reviewDir: nestedReviewDir, videoPath: null };
  }

  throw new Error(`无法从该路径推断审核目录: ${inputPath}`);
}

function inferVideoPath(reviewDir, explicitVideoPath) {
  if (explicitVideoPath) {
    return explicitVideoPath;
  }

  const clipDir = path.resolve(reviewDir, '..');
  const projectDir = path.resolve(clipDir, '..', '..');
  const projectBaseName = path.basename(projectDir);
  const videoName = projectBaseName.replace(/^\d{4}-\d{2}-\d{2}_/, '');
  const parentDir = path.dirname(projectDir);
  const searchDirs = [
    parentDir,
    path.dirname(clipDir),
    clipDir,
    path.resolve(reviewDir, '..', '..', '..'),
  ];

  if (/^\d{4}-\d{2}-\d{2}_/.test(projectBaseName) && fs.existsSync(parentDir)) {
    const entries = fs.readdirSync(parentDir, { withFileTypes: true });
    const matchedVideo = entries.find((entry) => {
      if (!entry.isFile()) return false;
      const fullPath = path.join(parentDir, entry.name);
      return path.basename(entry.name, path.extname(entry.name)) === videoName && isVideoFile(fullPath);
    });

    if (matchedVideo) {
      return path.join(parentDir, matchedVideo.name);
    }
  }

  const candidates = [];
  for (const dirPath of searchDirs) {
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
      continue;
    }
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const fullPath = path.join(dirPath, entry.name);
      if (isVideoFile(fullPath)) {
        candidates.push(fullPath);
      }
    }
  }

  const uniqueCandidates = [...new Set(candidates)];
  if (uniqueCandidates.length === 1) {
    return uniqueCandidates[0];
  }

  if (uniqueCandidates.length > 1) {
    throw new Error(`自动找到多个原视频，请直接传入视频路径: ${uniqueCandidates.join(', ')}`);
  }

  throw new Error('无法自动找到原视频，请直接传入视频路径');
}

function shouldRegenerateReview(outputFile, dependencyFiles) {
  if (!fs.existsSync(outputFile)) {
    return true;
  }

  const outputMtime = fs.statSync(outputFile).mtimeMs;
  return dependencyFiles.some((filePath) => fs.existsSync(filePath) && fs.statSync(filePath).mtimeMs > outputMtime);
}

function main() {
  const resolvedInput = resolveExistingPath(inputArg);
  const { reviewDir, videoPath: explicitVideoPath } = resolveReviewDir(resolvedInput);
  ensureDir(reviewDir, '审核目录');

  const subtitlesFile = path.resolve(reviewDir, '../1_转录/subtitles_words.json');
  const audioFile = path.resolve(reviewDir, '../1_转录/audio.mp3');
  const autoSelectedFile = path.resolve(reviewDir, '../2_分析/auto_selected.json');
  const reviewFile = path.join(reviewDir, 'review.html');

  ensureFile(subtitlesFile, '字幕文件');
  ensureFile(audioFile, '音频文件');
  ensureFile(autoSelectedFile, 'AI 预选文件');

  const videoPath = inferVideoPath(reviewDir, explicitVideoPath);
  ensureFile(videoPath, '原视频');

  const dependencies = [subtitlesFile, autoSelectedFile, audioFile];
  const regenerate = shouldRegenerateReview(reviewFile, dependencies);

  if (regenerate) {
    console.log('🛠️ 重新生成 review.html...');
    const generator = spawn(process.execPath, [
      GENERATE_REVIEW_SCRIPT,
      subtitlesFile,
      autoSelectedFile,
      audioFile,
      videoPath,
    ], {
      cwd: reviewDir,
      stdio: 'inherit',
    });

    generator.on('exit', (code) => {
      if (code !== 0) {
        process.exit(code || 1);
      }
      startServer(reviewDir, videoPath);
    });
    return;
  }

  console.log('♻️ 复用已有 review.html 和 selected.json，直接继续审核');
  startServer(reviewDir, videoPath);
}

function startServer(reviewDir, videoPath) {
  console.log(`📂 审核目录: ${reviewDir}`);
  console.log(`📹 原视频: ${videoPath}`);

  const server = spawn(process.execPath, [REVIEW_SERVER_SCRIPT, port, videoPath], {
    cwd: reviewDir,
    stdio: 'inherit',
  });

  server.on('exit', (code) => {
    process.exit(code || 0);
  });
}

main();
