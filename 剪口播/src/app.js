/**
 * 审核页前端逻辑
 * @param {Array} wordsData - 词级字幕数据
 * @param {Array} autoSelectedData - AI预选的索引列表
 * @param {Object} zeroCrossingOffsetsData - 过零点偏移量
 * @param {string} audioFile - 音频文件路径
 */

// 直接内联到 HTML，不使用 ES module

function initReviewPage(wordsData, autoSelectedData, zeroCrossingOffsetsData, audioFile) {
  const words = wordsData;
  const autoSelected = new Set(autoSelectedData);
  let selected = new Set(autoSelected);

  // 过零点偏移量（预计算）
  const zeroCrossingOffsets = zeroCrossingOffsetsData || {};

  // 应用过零点偏移
  function applyZeroCrossing(time) {
    const key = time.toFixed(2);
    if (zeroCrossingOffsets[key] !== undefined) {
      return time + zeroCrossingOffsets[key];
    }
    return time;
  }

  // 初始化 wavesurfer
  const wavesurfer = WaveSurfer.create({
    container: '#waveform',
    waveColor: '#5a9fd4',
    progressColor: '#3a7bc8',
    cursorColor: '#1a1a2e',
    height: 80,
    barWidth: 2,
    barGap: 1,
    barRadius: 2,
    url: audioFile || 'audio.mp3'
  });

  const timeDisplay = document.getElementById('time');
  const content = document.getElementById('content');
  const statsDiv = document.getElementById('stats');
  let elements = [];
  let isSelecting = false;
  let selectStart = -1;
  let selectMode = 'add'; // 'add' or 'remove'

  // 页面加载时尝试加载保存的方案
  (async function loadSavedSelection() {
    try {
      const res = await fetch('/api/load');
      const data = await res.json();
      if (data.success && data.selected && data.selected.length > 0) {
        selected = new Set(data.selected);
        console.log('📂 已加载保存的方案:', data.selected.length, '个选中项');
      }
    } catch (err) {
      console.log('📂 无保存的方案，使用AI预选');
    }
  })();

  // 格式化时间 (用于播放器显示)
  function formatTime(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }

  // 格式化时长 (用于剪辑结果显示，带秒数)
  function formatDuration(sec) {
    const totalSec = parseFloat(sec);
    const m = Math.floor(totalSec / 60);
    const s = (totalSec % 60).toFixed(1);
    if (m > 0) {
      return `${m}分${s}秒 (${totalSec}s)`;
    }
    return `${s}秒`;
  }

  // 侧边栏展开/收起
  function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const main = document.getElementById('mainWrapper');
    const toggle = sidebar.querySelector('.sidebar-toggle');
    sidebar.classList.toggle('collapsed');
    main.classList.toggle('sidebar-collapsed');
    toggle.textContent = sidebar.classList.contains('collapsed') ? '▶' : '◀';
  }

  // 渲染内容
  function render() {
    content.innerHTML = '';
    elements = [];

    words.forEach((word, i) => {
      const span = document.createElement('span');
      span.className = 'word';
      span.dataset.index = i;

      if (word.isGap) {
        span.classList.add('gap');
        span.textContent = `[${(word.end - word.start).toFixed(1)}s]`;
      } else {
        span.textContent = word.text;
      }

      if (selected.has(i)) {
        span.classList.add('selected');
      } else if (autoSelected.has(i)) {
        span.classList.add('auto-selected');
      }

      // 单击跳转播放
      span.onclick = (e) => {
        if (!isSelecting) {
          wavesurfer.setTime(word.start);
        }
      };

      // 双击选中/取消
      span.ondblclick = () => toggle(i);

      // Shift+拖动选择/取消
      span.onmousedown = (e) => {
        if (e.shiftKey) {
          isSelecting = true;
          selectStart = i;
          selectMode = selected.has(i) ? 'remove' : 'add';
          e.preventDefault();
        }
      };

      content.appendChild(span);
      elements.push(span);
    });

    // 计算连续选中状态，添加 selected-start/selected-end 类
    updateSelectedBorderRadius();
    updateStats();
  }

  // 更新选中片段的圆角（让连续选中看起来连在一起）
  function updateSelectedBorderRadius() {
    elements.forEach((el, i) => {
      el.classList.remove('selected-start', 'selected-end');
      if (!selected.has(i)) return;

      const prevSelected = i > 0 && selected.has(i - 1);
      const nextSelected = i < words.length - 1 && selected.has(i + 1);

      if (!prevSelected && !nextSelected) {
        // 单个选中：左右都是圆角
        el.classList.add('selected-start', 'selected-end');
      } else if (!prevSelected) {
        // 连续片段开始：左圆角右尖角
        el.classList.add('selected-start');
      } else if (!nextSelected) {
        // 连续片段结束：左尖角右圆角
        el.classList.add('selected-end');
      }
      // 中间的片段不加任何类（都是尖角）
    });
  }

  // 切换选中状态
  function toggle(i) {
    if (selected.has(i)) {
      selected.delete(i);
      elements[i].classList.remove('selected');
      if (autoSelected.has(i)) elements[i].classList.add('auto-selected');
    } else {
      selected.add(i);
      elements[i].classList.add('selected');
      elements[i].classList.remove('auto-selected');
    }
    updateSelectedBorderRadius();
    updateStats();
  }

  // 更新统计
  function updateStats() {
    const totalDuration = wavesurfer.getDuration();
    let deleteDuration = 0;
    const deleteCount = selected.size;

    words.forEach((w, i) => {
      if (selected.has(i)) {
        deleteDuration += w.end - w.start;
      }
    });

    const keptDuration = totalDuration - deleteDuration;
    const savedPercent = totalDuration > 0 ? (deleteDuration / totalDuration * 100).toFixed(1) : 0;

    statsDiv.innerHTML = `
      <div>总时长: ${formatDuration(totalDuration)}</div>
      <div>保留: ${formatDuration(keptDuration)}</div>
      <div>删除: ${formatDuration(deleteDuration)} (${savedPercent}%)</div>
      <div>选中: ${deleteCount} 个</div>
    `;
  }

  // 复制删除列表
  function copyDeleteList() {
    const segments = [];
    const sortedSelected = Array.from(selected).sort((a, b) => a - b);
    sortedSelected.forEach(i => {
      const word = words[i];
      // 应用过零点偏移
      const start = applyZeroCrossing(word.start);
      const end = applyZeroCrossing(word.end);
      segments.push({ start: start.toFixed(3), end: end.toFixed(3) });
    });
    navigator.clipboard.writeText(JSON.stringify(segments, null, 2));
    alert('📋 删除列表已复制到剪贴板');
  }

  // 保存方案
  async function saveSelection() {
    const sortedSelected = Array.from(selected).sort((a, b) => a - b);
    try {
      const res = await fetch('/api/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selected: sortedSelected })
      });
      const data = await res.json();
      if (data.success) {
        alert('💾 方案已保存: ' + data.file);
      } else {
        alert('❌ 保存失败: ' + data.error);
      }
    } catch (err) {
      alert('❌ 保存失败: ' + err.message);
    }
  }

  // 清空选择
  function clearAll() {
    selected.clear();
    render();
  }

  // wavesurfer 就绪
  wavesurfer.on('ready', () => {
    render();
    timeDisplay.textContent = formatTime(0) + ' / ' + formatTime(wavesurfer.getDuration());
  });

  // wavesurfer 错误处理
  wavesurfer.on('error', (err) => {
    console.error('wavesurfer error:', err);
    // 音频加载失败时也渲染文字内容
    render();
    timeDisplay.textContent = '音频加载失败，仍可查看文字';
  });

  // 备用：DOM 就绪后也尝试渲染（防止 wavesurfer 事件不触发）
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(render, 100);
  } else {
    document.addEventListener('DOMContentLoaded', () => setTimeout(render, 100));
  }

  // 播放时间更新 - 跳过选中片段 + 高亮当前词
  wavesurfer.on('timeupdate', (t) => {
    // 播放时跳过选中片段
    if (wavesurfer.isPlaying()) {
      const sortedSelected = Array.from(selected).sort((a, b) => a - b);
      for (const i of sortedSelected) {
        const w = words[i];
        if (t >= w.start && t < w.end) {
          // 找到连续选中片段的末尾
          let endTime = w.end;
          let j = sortedSelected.indexOf(i) + 1;
          while (j < sortedSelected.length) {
            const nextIdx = sortedSelected[j];
            const nextW = words[nextIdx];
            if (nextW.start - endTime < 0.1) {
              endTime = nextW.end;
              j++;
            } else {
              break;
            }
          }
          wavesurfer.setTime(endTime);
          return;
        }
      }
    }

    timeDisplay.textContent = `${formatTime(t)} / ${formatTime(wavesurfer.getDuration())}`;

    // 高亮当前词
    elements.forEach((el, i) => {
      const word = words[i];
      if (t >= word.start && t < word.end) {
        if (!el.classList.contains('current')) {
          el.classList.add('current');
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      } else {
        el.classList.remove('current');
      }
    });
  });

  // Shift+拖动多选
  content.addEventListener('mousemove', e => {
    if (!isSelecting) return;
    const target = e.target.closest('[data-index]');
    if (!target) return;

    const i = parseInt(target.dataset.index);
    const min = Math.min(selectStart, i);
    const max = Math.max(selectStart, i);

    for (let j = min; j <= max; j++) {
      if (selectMode === 'add') {
        selected.add(j);
        elements[j].classList.add('selected');
        elements[j].classList.remove('auto-selected');
      } else {
        selected.delete(j);
        elements[j].classList.remove('selected');
        if (autoSelected.has(j)) {
          elements[j].classList.add('auto-selected');
        }
      }
    }
    updateSelectedBorderRadius();
    updateStats();
  });

  // 鼠标释放结束选择
  content.addEventListener('mouseup', () => {
    isSelecting = false;
  });

  // 生成 EDL
  async function executeCut() {
    const deleteCount = selected.size;
    const shouldClose = confirm(`确认生成 EDL 文件？\n\n已标记 ${deleteCount} 个元素待删除\n\n是否关闭服务器？\n\n点击"确定"=关闭\n点击"取消"=保持打开`);
    if (shouldClose === undefined) return; // 点击取消

    const segments = [];
    const sortedSelected = Array.from(selected).sort((a, b) => a - b);
    sortedSelected.forEach(i => {
      const word = words[i];
      // 应用过零点偏移
      segments.push({ start: applyZeroCrossing(word.start), end: applyZeroCrossing(word.end) });
    });

    const overlay = document.getElementById('loadingOverlay');
    overlay.classList.add('show');

    try {
      const res = await fetch('/api/cut' + (shouldClose ? '' : '-noclose'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(segments)
      });
      const data = await res.json();
      overlay.classList.remove('show');

      if (data.success) {
        alert(`✅ EDL 已生成！

📄 文件: ${data.output}

⏱️ 时间统计:
   原时长: ${formatDuration(data.originalDuration)}
   保留:   ${formatDuration(data.keptDuration)}（${data.keepCount} 个片段）
   删减:   ${formatDuration(data.deletedDuration)}（${data.savedPercent}%）

请将 .edl 文件导入 DaVinci Resolve${shouldClose ? '（服务器已关闭）' : ''}`);
        if (shouldClose) {
          window.close();
        }
      } else {
        alert('❌ EDL 生成失败: ' + data.error);
      }
    } catch (err) {
      overlay.classList.remove('show');
      if (err.message.includes('Failed to fetch') || err.message.includes('NetworkError') || err.message.includes('fetch')) {
        alert(`📄 EDL 可能已生成\n\n请检查视频所在目录下的 .edl 文件${shouldClose ? '（服务器已关闭）' : ''}`);
        if (shouldClose) window.close();
      } else {
        alert('❌ 请求失败: ' + err.message + '\n\n请确保使用 review_server.js 启动服务');
      }
    }
  }

  // 智能 EDL（带过零点检测）
  async function executeSmartCut() {
    const deleteCount = selected.size;
    const shouldClose = confirm(`确认生成智能 EDL（带过零点检测）？\n\n已标记 ${deleteCount} 个元素待删除\n\n切分点已优化到最近的过零点\n\n是否关闭服务器？\n\n点击"确定"=关闭\n点击"取消"=保持打开`);
    if (shouldClose === undefined) return;

    const segments = [];
    const sortedSelected = Array.from(selected).sort((a, b) => a - b);
    sortedSelected.forEach(i => {
      const word = words[i];
      segments.push({ start: word.start, end: word.end });
    });

    const overlay = document.getElementById('loadingOverlay');
    overlay.classList.add('show');
    overlay.querySelector('.loading-text').textContent = '⚡ 正在检测过零点...';

    try {
      const res = await fetch('/api/cut-smart' + (shouldClose ? '' : '-noclose'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deleteSegments: segments, optimizeKeep: true })
      });
      const data = await res.json();
      overlay.classList.remove('show');

      if (data.success) {
        alert(`✅ 智能 EDL 已生成！

📄 文件: ${data.output}

⏱️ 时间统计:
   原时长: ${formatDuration(data.originalDuration)}
   保留:   ${formatDuration(data.keptDuration)}
   删减:   ${formatDuration(data.deletedDuration)}

✨ 特点:
   - 切分点已优化到过零点
   - 减少音频爆音
   - 可导入 DaVinci 二次编辑
${shouldClose ? '（服务器已关闭）' : ''}`);
        if (shouldClose) {
          window.close();
        }
      } else {
        alert('❌ 智能 EDL 生成失败: ' + data.error);
      }
    } catch (err) {
      overlay.classList.remove('show');
      if (err.message.includes('Failed to fetch') || err.message.includes('NetworkError') || err.message.includes('fetch')) {
        alert(`📄 EDL 可能已生成\n\n请检查视频所在目录下的 .edl 文件${shouldClose ? '（服务器已关闭）' : ''}`);
        if (shouldClose) window.close();
      } else {
        alert('❌ 请求失败: ' + err.message);
      }
    }
  }

  // 键盘快捷键
  document.addEventListener('keydown', e => {
    if (e.code === 'Space') {
      e.preventDefault();
      wavesurfer.playPause();
    } else if (e.code === 'ArrowLeft') {
      wavesurfer.setTime(Math.max(0, wavesurfer.getCurrentTime() - (e.shiftKey ? 5 : 1)));
    } else if (e.code === 'ArrowRight') {
      wavesurfer.setTime(Math.min(wavesurfer.getDuration(), wavesurfer.getCurrentTime() + (e.shiftKey ? 5 : 1)));
    }
  });

  // 暴露给全局，以便 HTML onclick 调用
  window.toggleSidebar = toggleSidebar;
  window.saveSelection = saveSelection;
  window.copyDeleteList = copyDeleteList;
  window.clearAll = clearAll;
  window.executeCut = executeCut;
  window.executeSmartCut = executeSmartCut;
}
