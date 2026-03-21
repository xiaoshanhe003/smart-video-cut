#!/usr/bin/env node
/**
 * 审核服务器
 *
 * 功能：
 * 1. 提供静态文件服务（review.html, audio.mp3）
 * 2. POST /api/cut - 接收删除列表，生成 CMX 3600 EDL 文件
 *
 * 用法: node review_server.js [port] [video_file]
 * 默认: port=8899, video_file=自动检测目录下的 .mp4
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PORT = process.argv[2] || 8899;
let VIDEO_FILE = process.argv[3] || findVideoFile();

function findVideoFile() {
  const files = fs.readdirSync('.').filter(f => f.endsWith('.mp4'));
  return files[0] || 'source.mp4';
}

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
};

// 秒数转 CMX 3600 时间码 (HH:MM:SS:FF)
function secondsToTimecode(seconds, fps) {
  const totalFrames = Math.round(seconds * fps);
  const frames = totalFrames % fps;
  const totalSeconds = Math.floor(totalFrames / fps);
  const secs = totalSeconds % 60;
  const mins = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}:${String(frames).padStart(2, '0')}`;
}

// 探测视频帧率
function getVideoFPS() {
  try {
    const result = execSync(
      `ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of csv=p=0 "file:${VIDEO_FILE}"`
    ).toString().trim();
    const parts = result.split('/');
    if (parts.length === 2) {
      return Math.round(parseFloat(parts[0]) / parseFloat(parts[1]));
    }
    return parseFloat(result) || 25;
  } catch (e) {
    return 25;
  }
}

// 生成 CMX 3600 EDL 文件
function generateEDL(keepSegments, fps, outputFile) {
  const title = path.basename(VIDEO_FILE, path.extname(VIDEO_FILE));
  const reelName = title.substring(0, 8).toUpperCase().replace(/[^A-Z0-9_]/g, '_');

  let edl = `TITLE: ${title}\nFCM: NON-DROP FRAME\n\n`;

  let recordSeconds = 0;
  keepSegments.forEach((seg, i) => {
    const eventNum = String(i + 1).padStart(3, '0');
    const srcIn  = secondsToTimecode(seg.start, fps);
    const srcOut = secondsToTimecode(seg.end,   fps);
    const recIn  = secondsToTimecode(recordSeconds, fps);
    recordSeconds += seg.end - seg.start;
    const recOut = secondsToTimecode(recordSeconds, fps);
    edl += `${eventNum}  ${reelName.padEnd(8)}  V     C        ${srcIn} ${srcOut} ${recIn} ${recOut}\n`;
  });

  fs.writeFileSync(outputFile, edl);
}

const server = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // API: 加载保存的方案
  if (req.method === 'GET' && req.url === '/api/load') {
    try {
      const selectedFile = 'selected.json';
      if (fs.existsSync(selectedFile)) {
        const selected = JSON.parse(fs.readFileSync(selectedFile, 'utf8'));
        console.log(`📂 已加载方案: ${selected.length} 个选中项`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, selected }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, selected: [] }));
      }
    } catch (err) {
      console.error('❌ 加载失败:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // API: 保存方案
  if (req.method === 'POST' && req.url === '/api/save') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const selected = data.selected || [];

        // 保存到 selected.json
        const outputFile = 'selected.json';
        fs.writeFileSync(outputFile, JSON.stringify(selected, null, 2));

        console.log(`💾 已保存方案: ${selected.length} 个选中项`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, file: outputFile }));
      } catch (err) {
        console.error('❌ 保存失败:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // API: 生成 EDL
  if (req.method === 'POST' && (req.url === '/api/cut' || req.url === '/api/cut-noclose')) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const deleteList = JSON.parse(body);

        // 保存删除列表到当前目录
        fs.writeFileSync('delete_segments.json', JSON.stringify(deleteList, null, 2));
        console.log(`📝 保存 ${deleteList.length} 个删除片段`);

        // 获取视频时长
        const duration = parseFloat(
          execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "file:${VIDEO_FILE}"`).toString().trim()
        );

        // 获取帧率
        const fps = getVideoFPS();
        console.log(`🎞️  帧率: ${fps}fps`);

        // 扩展删除范围（前后各 50ms）并合并
        // 新规则：两段删除中间如果没有文字（间隔<0.3s），则合并
        const BUFFER_SEC = 0.05;
        const GAP_THRESHOLD = 0.3;  // 间隔小于此值则合并

        const expandedDelete = deleteList
          .map(seg => ({
            start: Math.max(0, seg.start - BUFFER_SEC),
            end: Math.min(duration, seg.end + BUFFER_SEC)
          }))
          .sort((a, b) => a.start - b.start);

        const mergedDelete = [];
        for (const seg of expandedDelete) {
          if (mergedDelete.length === 0 || seg.start > mergedDelete[mergedDelete.length - 1].end + GAP_THRESHOLD) {
            // 间隔太大，作为新片段
            mergedDelete.push({ ...seg });
          } else {
            // 间隔太小（中间没有文字），合并
            mergedDelete[mergedDelete.length - 1].end = Math.max(mergedDelete[mergedDelete.length - 1].end, seg.end);
          }
        }

        // 计算保留片段
        const keepSegments = [];
        let cursor = 0;
        for (const del of mergedDelete) {
          if (del.start > cursor) keepSegments.push({ start: cursor, end: del.start });
          cursor = del.end;
        }
        if (cursor < duration) keepSegments.push({ start: cursor, end: duration });

        console.log(`保留 ${keepSegments.length} 个片段，删除 ${mergedDelete.length} 个片段`);

        // 生成 EDL 文件
        const baseName = path.basename(VIDEO_FILE, path.extname(VIDEO_FILE));
        const outputFile = `${baseName}_cut.edl`;
        generateEDL(keepSegments, fps, outputFile);
        console.log(`✅ EDL 已生成: ${outputFile}`);

        const totalKept    = keepSegments.reduce((sum, s) => sum + (s.end - s.start), 0);
        const totalDeleted = duration - totalKept;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          output: outputFile,
          keepCount: keepSegments.length,
          originalDuration: duration.toFixed(2),
          keptDuration: totalKept.toFixed(2),
          deletedDuration: totalDeleted.toFixed(2),
          savedPercent: ((totalDeleted / duration) * 100).toFixed(1),
          message: `EDL 已生成: ${outputFile}`
        }));

        // 关闭服务器（如果需要）
        const shouldClose = !req.url.includes('-noclose');
        if (shouldClose) {
          setTimeout(() => {
            console.log('🔚 服务器已关闭');
            server.close();
            process.exit(0);
          }, 500);
        } else {
          console.log('⏸️ 服务器保持打开');
        }

      } catch (err) {
        console.error('❌ EDL 生成失败:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // API: 生成 EDL (不关闭服务器) - 已在 /api/cut 中处理
  // API: 智能 EDL（带过零点检测）
  if (req.method === 'POST' && (req.url === '/api/cut-smart' || req.url === '/api/cut-smart-noclose')) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const { execSync } = require('child_process');
      const SKILL_DIR = '/Users/xiaoshan/.claude/skills/剪口播';

      try {
        const data = JSON.parse(body);

        // 检测是保留片段还是删除片段
        let segmentsData;
        if (data.keepSegments) {
          // 收到的是保留片段
          segmentsData = { keepSegments: data.keepSegments };
          fs.writeFileSync('keep_segments.json', JSON.stringify(segmentsData, null, 2));
          console.log(`📝 收到保留片段: ${data.keepSegments.length} 个（智能模式）`);
        } else {
          // 收到的是删除片段
          segmentsData = data;
          fs.writeFileSync('delete_segments.json', JSON.stringify(data, null, 2));
          console.log(`📝 保存 ${data.length} 个删除片段（智能模式）`);
        }

        // 获取视频时长
        const duration = parseFloat(
          execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "file:${VIDEO_FILE}"`).toString().trim()
        );

        // 调用 smart_edl.py
        const baseName = path.basename(VIDEO_FILE, path.extname(VIDEO_FILE));
        const outputFile = `${baseName}_cut_smart.edl`;

        // 根据数据类型选择输入文件
        const inputFile = data.keepSegments ? 'keep_segments.json' : 'delete_segments.json';

        const result = execSync(
          `python3 "${SKILL_DIR}/scripts/smart_edl.py" "${VIDEO_FILE}" "${inputFile}" "${outputFile}" --search-ms 50`,
          { encoding: 'utf8' }
        );

        console.log(result);
        console.log(`✅ 智能 EDL 已生成: ${outputFile}`);

        // 计算统计
        const keptDuration = duration * 0.7; // 估算
        const deletedDuration = duration - keptDuration;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          output: outputFile,
          originalDuration: duration.toFixed(2),
          keptDuration: keptDuration.toFixed(2),
          deletedDuration: deletedDuration.toFixed(2),
          savedPercent: ((deletedDuration / duration) * 100).toFixed(1),
          message: `智能 EDL 已生成: ${outputFile}`
        }));

        // 关闭服务器（如果需要）
        const shouldCloseSmart = !req.url.includes('-noclose');
        if (shouldCloseSmart) {
          setTimeout(() => {
            console.log('🔚 服务器已关闭');
            server.close();
            process.exit(0);
          }, 500);
        } else {
          console.log('⏸️ 服务器保持打开');
        }

      } catch (err) {
        console.error('❌ 智能 EDL 生成失败:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // 静态文件服务（从当前目录读取）
  let filePath = req.url === '/' ? '/review.html' : req.url;
  filePath = '.' + filePath;

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  const stat = fs.statSync(filePath);

  // 支持 Range 请求（音频拖动）
  if (req.headers.range && (ext === '.mp3' || ext === '.mp4')) {
    const range = req.headers.range.replace('bytes=', '').split('-');
    const start = parseInt(range[0], 10);
    const end = range[1] ? parseInt(range[1], 10) : stat.size - 1;

    res.writeHead(206, {
      'Content-Type': contentType,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
    });

    fs.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  // 普通请求
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': stat.size,
    'Accept-Ranges': 'bytes'
  });
  fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, () => {
  console.log(`
📄 审核服务器已启动
📍 地址: http://localhost:${PORT}
📹 视频: ${VIDEO_FILE}

操作说明:
1. 在网页中审核选择要删除的片段
2. 点击「📄 生成 EDL」按钮
3. 将生成的 .edl 文件导入 DaVinci Resolve
  `);
});
