#!/usr/bin/env node
/**
 * 生成审核网页 - 模块化版本
 *
 * 用法: node generate_review.js <subtitles_words.json> [auto_selected.json] [audio_file]
 * 输出: review.html, audio.mp3（复制到当前目录）
 *
 * 依赖文件:
 *   src/styles.css   - 样式文件
 *   src/icons.js     - SVG 图标
 *   src/app.js       - 前端逻辑
 */

const fs = require('fs');
const path = require('path');

const SKILL_DIR = '/Users/xiaoshan/.claude/skills/剪口播';
const SRC_DIR = path.join(SKILL_DIR, 'src');

const subtitlesFile = process.argv[2] || 'subtitles_words.json';
const autoSelectedFile = process.argv[3] || 'auto_selected.json';
const audioFile = process.argv[4] || 'audio.mp3';
const videoFile = process.argv[5] || null;  // 可选：视频文件，用于计算过零点

// 复制音频文件到当前目录（避免相对路径问题）
const audioBaseName = 'audio.mp3';
if (audioFile !== audioBaseName && fs.existsSync(audioFile)) {
  fs.copyFileSync(audioFile, audioBaseName);
  console.log('📁 已复制音频到当前目录:', audioBaseName);
}

if (!fs.existsSync(subtitlesFile)) {
  console.error('❌ 找不到字幕文件:', subtitlesFile);
  process.exit(1);
}

const words = JSON.parse(fs.readFileSync(subtitlesFile, 'utf8'));
let autoSelected = [];

if (fs.existsSync(autoSelectedFile)) {
  autoSelected = JSON.parse(fs.readFileSync(autoSelectedFile, 'utf8'));
  console.log('AI 预选:', autoSelected.length, '个元素');
}

// 预计算过零点偏移
let zeroCrossingOffsets = {};

if (videoFile && fs.existsSync(videoFile) && autoSelected.length > 0) {
  console.log('⏱️ 预计算过零点偏移...');

  const boundaryPoints = [];
  const sortedSelected = autoSelected.sort((a, b) => a - b);

  // 合并连续的选中片段，确定删除段
  const deleteSegments = [];
  let segStart = -1, segEnd = -1;

  for (const idx of sortedSelected) {
    const word = words[idx];
    if (segStart === -1) {
      segStart = word.start;
      segEnd = word.end;
    } else if (word.start <= segEnd + 0.1) {
      segEnd = Math.max(segEnd, word.end);
    } else {
      deleteSegments.push({ start: segStart, end: segEnd });
      segStart = word.start;
      segEnd = word.end;
    }
  }
  if (segStart !== -1) {
    deleteSegments.push({ start: segStart, end: segEnd });
  }

  console.log(`📍 需要计算 ${deleteSegments.length} 个删除段的边界点`);

  for (const seg of deleteSegments) {
    boundaryPoints.push({ time: seg.start, type: 'delete_start' });
    boundaryPoints.push({ time: seg.end, type: 'delete_end' });
  }

  console.log(`📍 共 ${boundaryPoints.length} 个边界点`);

  const tempFile = '/tmp/boundary_points.json';
  fs.writeFileSync(tempFile, JSON.stringify(boundaryPoints, null, 2));

  try {
    const { execSync } = require('child_process');
    const result = execSync(
      `python3 "${SKILL_DIR}/scripts/calc_zero_crossing.py" "${videoFile}" "${tempFile}"`,
      { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }
    );
    const offsets = JSON.parse(result);
    zeroCrossingOffsets = offsets;
    console.log(`✅ 过零点计算完成: ${Object.keys(offsets).length} 个偏移量`);
  } catch (err) {
    console.error('⚠️ 过零点计算失败:', err.message);
  }
}

// 读取外部文件
const cssContent = fs.readFileSync(path.join(SRC_DIR, 'styles.css'), 'utf8');
const iconsContent = fs.readFileSync(path.join(SRC_DIR, 'icons.js'), 'utf8');
const appContent = fs.readFileSync(path.join(SRC_DIR, 'app.js'), 'utf8');

// 生成 HTML
const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>审核稿</title>
  <script src="https://unpkg.com/wavesurfer.js@7"></script>
  <style>
${cssContent.split('\n').map(line => '    ' + line).join('\n')}
  </style>
</head>

<body>

  <div class="loading-overlay" id="loadingOverlay">
    <div class="loading-text">📄 正在生成 EDL...</div>
  </div>

  <div class="sidebar-backdrop" id="sidebarBackdrop" onclick="toggleSidebar(false)"></div>

  <!-- 左侧侧边栏 -->
  <div class="sidebar" id="sidebar">
    <div class="sidebar-header">
      <button
        class="sidebar-toggle"
        id="sidebarToggle"
        type="button"
        onclick="toggleSidebar()"
        aria-label="收起侧边栏"
      >
        <svg class="sidebar-toggle-icon" width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path d="M7.5 3.33333V16.6667M3.33334 5C3.33334 4.55797 3.50893 4.13405 3.82149 3.82149C4.13405 3.50893 4.55798 3.33333 5 3.33333H15C15.442 3.33333 15.866 3.50893 16.1785 3.82149C16.4911 4.13405 16.6667 4.55797 16.6667 5V15C16.6667 15.442 16.4911 15.8659 16.1785 16.1785C15.866 16.4911 15.442 16.6667 15 16.6667H5C4.55798 16.6667 4.13405 16.4911 3.82149 16.1785C3.50893 15.8659 3.33334 15.442 3.33334 15V5Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    </div>

    <div class="sidebar-content">
      <div class="sidebar-group">
        <p class="sidebar-group-title">颜色说明</p>
        <div class="sidebar-list">
          <div class="sidebar-row">
            <span class="sidebar-label">AI预选（建议删除）</span>
            <span class="legend-swatch legend-swatch-auto" aria-hidden="true"></span>
          </div>
          <div class="sidebar-row">
            <span class="sidebar-label">标记删除</span>
            <span class="legend-swatch legend-swatch-selected" aria-hidden="true"></span>
          </div>
          <div class="sidebar-row">
            <span class="sidebar-label">当前播放</span>
            <span class="legend-swatch legend-swatch-current" aria-hidden="true"></span>
          </div>
        </div>
      </div>

      <div class="sidebar-group">
        <p class="sidebar-group-title">TIPS</p>
        <div class="sidebar-list">
          <div class="sidebar-row">
            <span class="sidebar-label">跳转播放</span>
            <span class="shortcut-pill">
              <span class="shortcut-icon">
                <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <path d="M7.5 7.5L11.6667 17.5L13.145 13.145L17.5 11.6667L7.5 7.5Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                  <path d="M13.3925 13.3925L16.9283 16.9283" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                  <path d="M5.99 1.86584L6.6375 4.28M4.28 6.6375L1.865 5.99M11.625 3.375L9.85667 5.14334M5.1425 9.85667L3.37583 11.625" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </span>
              <span>单击</span>
            </span>
          </div>
          <div class="sidebar-row">
            <span class="sidebar-label">选中/取消</span>
            <span class="shortcut-pill">
              <span class="shortcut-icon">
                <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <path d="M7.5 7.5L11.6667 17.5L13.145 13.145L17.5 11.6667L7.5 7.5Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                  <path d="M13.3925 13.3925L16.9283 16.9283" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                  <path d="M5.99 1.86584L6.6375 4.28M4.28 6.6375L1.865 5.99M11.625 3.375L9.85667 5.14334M5.1425 9.85667L3.37583 11.625" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </span>
              <span>双击</span>
            </span>
          </div>
          <div class="sidebar-row">
            <span class="sidebar-label">批量选中/取消</span>
            <span class="shortcut-combo">
              <span class="shortcut-pill shortcut-pill-text">Shift</span>
              <span class="shortcut-plus" aria-hidden="true">
                <svg width="14" height="14" viewBox="0 0 20 20" fill="none">
                  <path d="M10 4.16666V15.8333" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                  <path d="M4.16667 10H15.8333" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </span>
              <span class="shortcut-pill">
                <span class="shortcut-icon">
                  <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <path d="M2.5 2.5L8.39167 16.6417L10.4833 10.4833L16.6417 8.39167L2.5 2.5Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                    <path d="M10.8333 10.8333L15.8333 15.8333" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                </span>
                <span>拖动</span>
              </span>
            </span>
          </div>
          <div class="sidebar-row">
            <span class="sidebar-label">播放/暂停</span>
            <span class="shortcut-pill shortcut-pill-text">Space</span>
          </div>
          <div class="sidebar-row">
            <span class="sidebar-label">跳转1秒</span>
            <span class="shortcut-combo">
              <span class="shortcut-pill shortcut-pill-icon-only" aria-hidden="true">
                <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
                  <path d="M14 6.76938C14 6.40755 13.6276 6.16552 13.2969 6.31248L6.02804 9.54309C5.63213 9.71905 5.63213 10.2809 6.02804 10.4569L13.2969 13.6875C13.6276 13.8345 14 13.5924 14 13.2306V6.76938Z" fill="currentColor"/>
                </svg>
              </span>
              <span class="shortcut-or">或</span>
              <span class="shortcut-pill shortcut-pill-icon-only" aria-hidden="true">
                <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
                  <path d="M5 6.76938C5 6.40755 5.37243 6.16552 5.70307 6.31248L12.972 9.54309C13.3679 9.71905 13.3679 10.2809 12.972 10.4569L5.70307 13.6875C5.37243 13.8345 5 13.5924 5 13.2306V6.76938Z" fill="currentColor"/>
                </svg>
              </span>
            </span>
          </div>
          <div class="sidebar-row">
            <span class="sidebar-label">跳转5秒</span>
            <span class="shortcut-combo">
              <span class="shortcut-pill shortcut-pill-text">Shift</span>
              <span class="shortcut-plus" aria-hidden="true">
                <svg width="14" height="14" viewBox="0 0 20 20" fill="none">
                  <path d="M10 4.16666V15.8333" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                  <path d="M4.16667 10H15.8333" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </span>
              <span class="shortcut-pill shortcut-pill-icon-only" aria-hidden="true">
                <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
                  <path d="M14 6.76938C14 6.40755 13.6276 6.16552 13.2969 6.31248L6.02804 9.54309C5.63213 9.71905 5.63213 10.2809 6.02804 10.4569L13.2969 13.6875C13.6276 13.8345 14 13.5924 14 13.2306V6.76938Z" fill="currentColor"/>
                </svg>
              </span>
              <span class="shortcut-or">或</span>
              <span class="shortcut-pill shortcut-pill-icon-only" aria-hidden="true">
                <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
                  <path d="M5 6.76938C5 6.40755 5.37243 6.16552 5.70307 6.31248L12.972 9.54309C13.3679 9.71905 13.3679 10.2809 12.972 10.4569L5.70307 13.6875C5.37243 13.8345 5 13.5924 5 13.2306V6.76938Z" fill="currentColor"/>
                </svg>
              </span>
            </span>
          </div>
        </div>
      </div>

    </div>
  </div>

  <div class="main-wrapper" id="mainWrapper">

    <div class="controls">
      <div class="controls-topbar">
        <button class="mobile-sidebar-trigger" type="button" onclick="toggleSidebar()" aria-label="打开侧边栏">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M7.5 3.33333V16.6667M3.33334 5C3.33334 4.55797 3.50893 4.13405 3.82149 3.82149C4.13405 3.50893 4.55798 3.33333 5 3.33333H15C15.442 3.33333 15.866 3.50893 16.1785 3.82149C16.4911 4.13405 16.6667 4.55797 16.6667 5V15C16.6667 15.442 16.4911 15.8659 16.1785 16.1785C15.866 16.4911 15.442 16.6667 15 16.6667H5C4.55798 16.6667 4.13405 16.4911 3.82149 16.1785C3.50893 15.8659 3.33334 15.442 3.33334 15V5Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </div>
      <div class="buttons">
        <div class="buttons-left">
          <button class="btn-tertiary" onclick="saveSelection()">
            <span class="btn-icon">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <path d="M15.8333 17.5H4.16667C3.72464 17.5 3.30072 17.3244 2.98816 17.0118C2.67559 16.6993 2.5 16.2754 2.5 15.8333V4.16667C2.5 3.72464 2.67559 3.30072 2.98816 2.98816C3.30072 2.67559 3.72464 2.5 4.16667 2.5H13.3333L17.5 6.66667V15.8333C17.5 16.2754 17.3244 16.6993 17.0118 17.0118C16.6993 17.3244 16.2754 17.5 15.8333 17.5Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M14.1667 17.5V10.8333H5.83333V17.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M5.83333 2.5V6.66667H12.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </span>
            保存
          </button>
          <div class="divider"></div>
          <button class="btn-tertiary" onclick="copyDeleteList()">
            <span class="btn-icon">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <path d="M13.3333 6.66667V5C13.3333 4.55797 13.1577 4.13405 12.8452 3.82149C12.5326 3.50893 12.1087 3.33333 11.6667 3.33333H5C4.55797 3.33333 4.13405 3.50893 3.82149 3.82149C3.50893 4.13405 3.33333 4.55797 3.33333 5V11.6667C3.33333 12.1087 3.50893 12.5326 3.82149 12.8452C4.13405 13.1577 4.55797 13.3333 5 13.3333H6.66667M6.66667 8.33333C6.66667 7.8913 6.84226 7.46738 7.15482 7.15482C7.46738 6.84226 7.8913 6.66667 8.33333 6.66667H15C15.442 6.66667 15.8659 6.84226 16.1785 7.15482C16.4911 7.46738 16.6667 7.8913 16.6667 8.33333V15C16.6667 15.442 16.4911 15.8659 16.1785 16.1785C15.8659 16.4911 15.442 16.6667 15 16.6667H8.33333C7.8913 16.6667 7.46738 16.4911 7.15482 16.1785C6.84226 15.8659 6.66667 15.442 6.66667 15V8.33333Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </span>
            复制删除列表
          </button>
          <div class="divider"></div>
          <button class="btn-tertiary danger" onclick="clearAll()">
            <span class="btn-icon">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <path d="M3.66669 5.33333H17M8.66669 8.66667V13.6667M12 8.66667V13.6667M4.50002 5.33333L5.33335 15.3333C5.33335 15.7754 5.50895 16.1993 5.82151 16.5118C6.13407 16.8244 6.55799 17 7.00002 17H13.6667C14.1087 17 14.5326 16.8244 14.8452 16.5118C15.1578 16.1993 15.3334 15.7754 15.3334 15.3333L16.1667 5.33333M7.83335 5.33333V2.83333C7.83335 2.61232 7.92115 2.40036 8.07743 2.24408C8.23371 2.0878 8.44567 2 8.66669 2H12C12.221 2 12.433 2.0878 12.5893 2.24408C12.7456 2.40036 12.8334 2.61232 12.8334 2.83333V5.33333" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </span>
            清空选择
          </button>
        </div>
        <div class="buttons-right">
          <button class="btn-primary" onclick="executeCut()">
            <span class="btn-icon">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <path d="M11.6667 2.5V5.83333C11.6667 6.05435 11.7545 6.26631 11.9107 6.42259C12.067 6.57887 12.279 6.66667 12.5 6.66667H15.8333M11.6667 2.5H5.83333C5.3913 2.5 4.96738 2.67559 4.65482 2.98816C4.34226 3.30072 4.16666 3.72464 4.16666 4.16667V15.8333C4.16666 16.2754 4.34226 16.6993 4.65482 17.0118C4.96738 17.3244 5.3913 17.5 5.83333 17.5H14.1667C14.6087 17.5 15.0326 17.3244 15.3452 17.0118C15.6577 16.6993 15.8333 16.2754 15.8333 15.8333V6.66667M11.6667 2.5L15.8333 6.66667M10 14.1667V9.16667M10 14.1667L7.91666 12.0833M10 14.1667L12.0833 12.0833" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </span>
            生成EDL
          </button>
          <button class="btn-secondary btn-tooltip" onclick="executeSmartCut()" data-tooltip="自动过零点剪辑(防爆音)">
            <span class="btn-icon">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <path d="M13.3333 15C13.7754 15 14.1993 15.1756 14.5118 15.4882C14.8244 15.8007 15 16.2246 15 16.6667C15 16.2246 15.1756 15.8007 15.4882 15.4882C15.8007 15.1756 16.2246 15 16.6667 15C16.2246 15 15.8007 14.8244 15.4882 14.5118C15.1756 14.1993 15 13.7754 15 13.3333C15 13.7754 14.8244 14.1993 14.5118 14.5118C14.1993 14.8244 13.7754 15 13.3333 15ZM13.3333 5C13.7754 5 14.1993 5.17559 14.5118 5.48815C14.8244 5.80071 15 6.22464 15 6.66667C15 6.22464 15.1756 5.80071 15.4882 5.48815C15.8007 5.17559 16.2246 5 16.6667 5C16.2246 5 15.8007 4.8244 15.4882 4.51184C15.1756 4.19928 15 3.77536 15 3.33333C15 3.77536 14.8244 4.19928 14.5118 4.51184C14.1993 4.8244 13.7754 5 13.3333 5ZM7.5 15C7.5 13.6739 8.02678 12.4021 8.96447 11.4645C9.90215 10.5268 11.1739 10 12.5 10C11.1739 10 9.90215 9.47321 8.96447 8.53553C8.02678 7.59785 7.5 6.32608 7.5 5C7.5 6.32608 6.97322 7.59785 6.03553 8.53553C5.09785 9.47321 3.82608 10 2.5 10C3.82608 10 5.09785 10.5268 6.03553 11.4645C6.97322 12.4021 7.5 13.6739 7.5 15Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </span>
            智能EDL
          </button>
        </div>
      </div>
      <div class="player">
        <div class="player-top">
          <p class="player-title" id="playerTitle">计算中...</p>
          <div class="player-controls">
            <div class="speed-select" id="speedSelect">
              <select id="speed" onchange="wavesurfer.setPlaybackRate(parseFloat(this.value))">
                <option value="0.5">0.5x</option>
                <option value="0.75">0.75x</option>
                <option value="1" selected>1x</option>
                <option value="1.25">1.25x</option>
                <option value="1.5">1.5x</option>
                <option value="2">2x</option>
              </select>
              <span class="speed-chevron">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path d="M4 6L8 10L12 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </span>
            </div>
            <div class="play-controls">
              <button class="play-btn-main" onclick="wavesurfer.playPause()" id="playPauseBtn">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" id="playIcon">
                  <path d="M4 2L14 8L4 14V2Z" fill="currentColor"/>
                </svg>
              </button>
            </div>
          </div>
        </div>
        <div class="player-progress">
          <div id="waveform"></div>
          <div class="time-display">
            <span id="currentTime">00:00</span>
            <span id="totalTime">/ 00:00</span>
          </div>
        </div>
      </div>
    </div>

    <div class="content" id="content"></div>
    <div class="stats" id="stats"></div>
  </div>

  <script>
    // 数据注入
    const words = ${JSON.stringify(words)};
    const autoSelected = ${JSON.stringify(autoSelected)};
    const zeroCrossingOffsets = ${JSON.stringify(zeroCrossingOffsets)};
    const audioBaseName = '${audioBaseName}';
  </script>
  <script>
${appContent.split('\n').filter(line => !line.includes("import { icon } from './icons.js'")).map(line => '    ' + line).join('\n')}

    // 初始化应用
    initReviewPage(words, autoSelected, zeroCrossingOffsets, audioBaseName);
  </script>
</body>
</html>`;

fs.writeFileSync('review.html', html);
console.log('✅ 已生成 review.html');
