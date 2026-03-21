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
    waveColor: '#d6d3d1',
    progressColor: '#78716C',
    cursorColor: '#4D7C0F',
    height: 40,
    barWidth: 2,
    barGap: 1,
    barRadius: 2,
    normalize: true,
    url: audioFile || 'audio.mp3'
  });

  const currentTimeEl = document.getElementById('currentTime');
  const totalTimeEl = document.getElementById('totalTime');
  const content = document.getElementById('content');
  const statsDiv = document.getElementById('stats');
  const sidebar = document.getElementById('sidebar');
  const main = document.getElementById('mainWrapper');
  const controls = document.querySelector('.controls');
  const sidebarToggle = document.getElementById('sidebarToggle');
  const sidebarBackdrop = document.getElementById('sidebarBackdrop');
  const mobileQuery = window.matchMedia('(max-width: 860px)');
  let elements = [];
  let isSelecting = false;
  let selectStart = -1;
  let selectMode = 'add'; // 'add' or 'remove'
  let pendingShiftDragStart = -1;
  let pendingShiftDragPoint = null;
  let pendingClickTimer = null; // 延迟执行的单击回调，用于区分单击/双击
  let sidebarCollapsedDesktop = false;
  let sidebarOpenMobile = false;
  const expandedGapGroups = new Set();
  let shiftRangeAnchor = null;

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

  // 更新播放器标题（成品时长、删除百分比和 AI 预选有效度）
  function updatePlayerTitle(currentTime, totalDuration) {
    const playerTitle = document.getElementById('playerTitle');
    if (!playerTitle || !totalDuration) return;

    // 计算已删除的时长（基于选中片段）
    let deletedDuration = 0;
    const sortedSelected = Array.from(selected).sort((a, b) => a - b);
    for (const i of sortedSelected) {
      const w = words[i];
      if (w && w.end > w.start) {
        deletedDuration += (w.end - w.start);
      }
    }

    const keptDuration = totalDuration - deletedDuration;
    const savedPercent = totalDuration > 0 ? Math.round((keptDuration / totalDuration) * 100) : 0;
    const deletedPercent = 100 - savedPercent;

    // 格式化成品时长
    const keptM = Math.floor(keptDuration / 60);
    const keptS = (keptDuration % 60).toFixed(1);
    const keptTimeStr = keptM > 0 ? `${keptM}分${keptS}秒` : `${keptS}秒`;

    const keptAutoSelectedCount = Array.from(selected).filter(i => autoSelected.has(i)).length;
    const manuallyAddedCount = Array.from(selected).filter(i => !autoSelected.has(i)).length;
    const effectivenessDenominator = autoSelected.size + manuallyAddedCount;
    const effectiveness = effectivenessDenominator > 0
      ? Math.round((keptAutoSelectedCount / effectivenessDenominator) * 100)
      : 0;

    playerTitle.textContent = `成品时长 ${keptTimeStr}，已删除${deletedPercent}%，AI预选有效度${effectiveness}%`;
  }

  // 更新播放/暂停图标
  function updatePlayPauseIcon(isPlaying) {
    const playIcon = document.getElementById('playIcon');
    if (!playIcon) return;

    if (isPlaying) {
      // 暂停图标（两条竖线）
      playIcon.innerHTML = `
        <rect x="4" y="2" width="3" height="12" rx="0.5" fill="currentColor"/>
        <rect x="9" y="2" width="3" height="12" rx="0.5" fill="currentColor"/>
      `;
    } else {
      // 播放图标（三角形）
      playIcon.innerHTML = `<path d="M4 2L14 8L4 14V2Z" fill="currentColor"/>`;
    }
  }

  function syncSidebarUI() {
    if (!sidebar || !main) return;

    const isMobile = mobileQuery.matches;
    sidebar.classList.toggle('collapsed', !isMobile && sidebarCollapsedDesktop);
    sidebar.classList.toggle('mobile-open', isMobile && sidebarOpenMobile);
    sidebar.classList.toggle('mobile-hidden', isMobile && !sidebarOpenMobile);
    main.classList.toggle('sidebar-collapsed', !isMobile && sidebarCollapsedDesktop);

    if (sidebarBackdrop) {
      sidebarBackdrop.classList.toggle('visible', isMobile && sidebarOpenMobile);
    }

    document.body.classList.toggle('sidebar-open-mobile', isMobile && sidebarOpenMobile);

    if (sidebarToggle) {
      const label = isMobile
        ? (sidebarOpenMobile ? '关闭侧边栏' : '打开侧边栏')
        : (sidebarCollapsedDesktop ? '展开侧边栏' : '收起侧边栏');
      sidebarToggle.setAttribute('aria-label', label);
    }

    requestAnimationFrame(updateControlsOffset);
  }

  function updateControlsOffset() {
    if (!controls) return;
    const height = Math.ceil(controls.getBoundingClientRect().height);
    document.documentElement.style.setProperty('--controls-offset', `${height}px`);
  }

  function positionExpandedGapButtons() {
    if (!content) return;

    const contentRect = content.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const expandedGroups = content.querySelectorAll('.gap-group.expanded');

    expandedGroups.forEach((group) => {
      const button = group.querySelector('.gap-group-collapse');
      if (!button) return;

      const groupRect = group.getBoundingClientRect();
      const firstWord = group.querySelector('.word');
      const anchorRect = firstWord ? firstWord.getBoundingClientRect() : groupRect;
      const buttonWidth = Math.ceil(button.getBoundingClientRect().width) || 44;
      const leftCandidate = contentRect.left - buttonWidth - 12;
      const rightCandidate = contentRect.right + 12;
      const canPlaceRight = rightCandidate + buttonWidth <= viewportWidth - 8;
      const x = leftCandidate >= 8 || !canPlaceRight
        ? Math.max(8, leftCandidate)
        : rightCandidate;

      button.style.left = `${Math.round(x)}px`;
      button.style.top = `${Math.round(anchorRect.top + anchorRect.height / 2)}px`;
    });
  }

  // 侧边栏展开/收起
  function toggleSidebar(forceOpen) {
    if (mobileQuery.matches) {
      sidebarOpenMobile = typeof forceOpen === 'boolean' ? forceOpen : !sidebarOpenMobile;
    } else {
      sidebarCollapsedDesktop = typeof forceOpen === 'boolean' ? !forceOpen : !sidebarCollapsedDesktop;
    }
    syncSidebarUI();
  }

  function getGapGroupKey(start, end) {
    return `${start}-${end}`;
  }

  function findSelectedGapGroup(index) {
    const word = words[index];
    if (!word || !word.isGap || !selected.has(index)) return null;

    let start = index;
    let end = index;

    while (start > 0 && words[start - 1].isGap && selected.has(start - 1)) {
      start--;
    }
    while (end < words.length - 1 && words[end + 1].isGap && selected.has(end + 1)) {
      end++;
    }

    return { start, end, key: getGapGroupKey(start, end), length: end - start + 1 };
  }

  function getCollapsibleGapGroupAt(index) {
    const group = findSelectedGapGroup(index);
    if (!group || group.start !== index || group.length <= 3) return null;
    return group;
  }

  function createWordElement(i) {
    const word = words[i];
    const span = document.createElement('span');
    span.className = 'word';
    span.dataset.index = i;
    const isWhitespaceToken = !word.isGap && /^\s+$/.test(word.text || '');

    if (word.isGap) {
      span.classList.add('gap');
      span.textContent = `[${(word.end - word.start).toFixed(1)}s]`;
    } else {
      span.textContent = isWhitespaceToken ? '' : word.text;
    }

    if (isWhitespaceToken) {
      span.classList.add('whitespace-token');
    }

    if (autoSelected.has(i)) {
      span.classList.add('auto-selected');
    }
    if (selected.has(i)) {
      span.classList.add('selected');
    }

    // 单击跳转播放；Shift+单击用于区间选择
    span.onclick = (e) => {
      if (isSelecting) return;
      if (e.shiftKey) {
        if (shiftRangeAnchor === null) {
          shiftRangeAnchor = i;
        } else {
          applyRangeSelection(shiftRangeAnchor, i);
          shiftRangeAnchor = null;
        }
        return;
      }

      shiftRangeAnchor = null;
      if (pendingClickTimer) return;
      pendingClickTimer = setTimeout(() => {
        pendingClickTimer = null;
        wavesurfer.setTime(word.start);
      }, 250);
    };

    // 双击选中/取消（立即执行，并取消待处理的单击）
    span.ondblclick = (e) => {
      e.preventDefault();
      if (pendingClickTimer) {
        clearTimeout(pendingClickTimer);
        pendingClickTimer = null;
      }

      shiftRangeAnchor = null;
      toggle(i);
    };

    // Shift+拖动选择/取消
    span.onmousedown = (e) => {
      if (e.shiftKey) {
        pendingShiftDragStart = i;
        pendingShiftDragPoint = { x: e.clientX, y: e.clientY };
      }
    };

    elements[i] = span;
    return span;
  }

  function createCollapsedGapPlaceholder(group) {
    const hiddenDuration = words
      .slice(group.start + 1, group.end)
      .reduce((sum, word) => sum + (word.end - word.start), 0);
    const hiddenIndexes = Array.from(
      { length: Math.max(0, group.end - group.start - 1) },
      (_, offset) => group.start + 1 + offset
    );
    const isAutoSelectedGroup = hiddenIndexes.length > 0 && hiddenIndexes.every(index => autoSelected.has(index));

    const placeholder = document.createElement('span');
    placeholder.className = 'word gap gap-collapsed-toggle selected selected-start selected-end';
    if (isAutoSelectedGroup) {
      placeholder.classList.add('auto-selected');
    }
    placeholder.textContent = `...[${hiddenDuration.toFixed(1)}s]`;
    placeholder.title = '点击展开中间静音片段';
    placeholder.onclick = (e) => {
      e.stopPropagation();
      expandedGapGroups.add(group.key);
      render();
    };
    return placeholder;
  }

  function createGapGroupContainer(group) {
    const container = document.createElement('span');
    container.className = 'gap-group';
    container.dataset.groupKey = group.key;

    const collapseButton = document.createElement('button');
    collapseButton.type = 'button';
    collapseButton.className = 'gap-group-collapse btn-tooltip';
    collapseButton.dataset.tooltip = '折叠连续静音片段';
    collapseButton.innerHTML = `
      <span class="gap-group-collapse-label">折叠</span>
      <svg class="gap-group-collapse-icon" width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path d="M10 2.5V7.5M10 7.5L12.5 5M10 7.5L7.5 5M10 17.5V12.5M10 12.5L12.5 15M10 12.5L7.5 15M3.33333 10H4.16667M7.5 10H8.33333M11.6667 10H12.5M15.8333 10H16.6667" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `;
    collapseButton.onmouseenter = () => {
      container.classList.add('button-hover');
    };
    collapseButton.onmouseleave = () => {
      container.classList.remove('button-hover');
    };
    collapseButton.onfocus = () => {
      container.classList.add('button-hover');
    };
    collapseButton.onblur = () => {
      container.classList.remove('button-hover');
    };
    collapseButton.onclick = (e) => {
      e.stopPropagation();
      expandedGapGroups.delete(group.key);
      render();
    };

    container.appendChild(collapseButton);
    return container;
  }

  // 渲染内容
  function render() {
    content.innerHTML = '';
    elements = new Array(words.length).fill(null);

    for (let i = 0; i < words.length; i++) {
      const group = getCollapsibleGapGroupAt(i);
      if (group) {
        const isExpanded = expandedGapGroups.has(group.key);
        const container = createGapGroupContainer(group);

        if (isExpanded) {
          container.classList.add('expanded');
          for (let j = group.start; j <= group.end; j++) {
            container.appendChild(createWordElement(j));
          }
        } else {
          container.classList.add('collapsed');
          container.appendChild(createWordElement(group.start));
          container.appendChild(createCollapsedGapPlaceholder(group));
          container.appendChild(createWordElement(group.end));
        }

        content.appendChild(container);
        i = group.end;
        continue;
      }

      content.appendChild(createWordElement(i));
    }

    // 计算连续选中状态，添加 selected-start/selected-end 类
    updateSelectedBorderRadius();
    updateStats();
    requestAnimationFrame(positionExpandedGapButtons);
  }

  // 更新选中片段的圆角（让连续选中看起来连在一起）
  function updateSelectedBorderRadius() {
    elements.forEach((el, i) => {
      if (!el) return;
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

  function applyRangeSelection(startIndex, endIndex) {
    const min = Math.min(startIndex, endIndex);
    const max = Math.max(startIndex, endIndex);
    let shouldRemoveRange = true;

    for (let j = min; j <= max; j++) {
      if (!selected.has(j)) {
        shouldRemoveRange = false;
        break;
      }
    }

    for (let j = min; j <= max; j++) {
      if (shouldRemoveRange) {
        selected.delete(j);
      } else {
        selected.add(j);
      }
    }

    expandedGapGroups.clear();
    render();
  }

  // 切换选中状态
  function toggle(i) {
    const group = findSelectedGapGroup(i);
    if (selected.has(i)) {
      selected.delete(i);
    } else {
      selected.add(i);
    }

    if (group) {
      expandedGapGroups.delete(group.key);
    }
    render();
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

    updatePlayerTitle(wavesurfer.getCurrentTime(), totalDuration);
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
    const duration = wavesurfer.getDuration();
    currentTimeEl.textContent = formatTime(0);
    totalTimeEl.textContent = formatTime(duration);
    updatePlayerTitle(0, duration);
    updatePlayPauseIcon(false);
  });

  // wavesurfer 播放/暂停状态变化
  wavesurfer.on('play', () => updatePlayPauseIcon(true));
  wavesurfer.on('pause', () => updatePlayPauseIcon(false));

  // wavesurfer 点击波形图跳转
  wavesurfer.on('interaction', (t) => {
    // 高亮当前词
    elements.forEach((el, i) => {
      if (!el) return;
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
    currentTimeEl.textContent = formatTime(t);
    updatePlayerTitle(t, wavesurfer.getDuration());
  });

  // wavesurfer 错误处理
  wavesurfer.on('error', (err) => {
    console.error('wavesurfer error:', err);
    // 音频加载失败时也渲染文字内容
    render();
    currentTimeEl.textContent = '--:--';
    totalTimeEl.textContent = '--:--';
  });

  // 备用：DOM 就绪后也尝试渲染（防止 wavesurfer 事件不触发）
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(render, 100);
  } else {
    document.addEventListener('DOMContentLoaded', () => setTimeout(render, 100));
  }

  syncSidebarUI();
  updateControlsOffset();

  if (window.ResizeObserver && controls) {
    const controlsResizeObserver = new ResizeObserver(() => updateControlsOffset());
    controlsResizeObserver.observe(controls);
  }

  window.addEventListener('resize', updateControlsOffset);
  window.addEventListener('resize', positionExpandedGapButtons);
  window.addEventListener('scroll', positionExpandedGapButtons, { passive: true });
  mobileQuery.addEventListener('change', () => {
    if (!mobileQuery.matches) {
      sidebarOpenMobile = false;
    }
    syncSidebarUI();
    requestAnimationFrame(positionExpandedGapButtons);
  });

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

    currentTimeEl.textContent = formatTime(t);
    totalTimeEl.textContent = formatTime(wavesurfer.getDuration());
    updatePlayerTitle(t, wavesurfer.getDuration());

    // 高亮当前词
    elements.forEach((el, i) => {
      if (!el) return;
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
    const target = e.target.closest('[data-index]');
    if (!target) {
      return;
    }

    if (!isSelecting) {
      if (pendingShiftDragStart === -1) {
        return;
      }

      const movedEnough = !pendingShiftDragPoint
        || Math.abs(e.clientX - pendingShiftDragPoint.x) > 4
        || Math.abs(e.clientY - pendingShiftDragPoint.y) > 4;
      if (!movedEnough) {
        return;
      }

      const i = parseInt(target.dataset.index);
      if (i === pendingShiftDragStart) {
        return;
      }

      isSelecting = true;
      selectStart = pendingShiftDragStart;
      selectMode = selected.has(selectStart) ? 'remove' : 'add';
    }

    const i = parseInt(target.dataset.index);
    const min = Math.min(selectStart, i);
    const max = Math.max(selectStart, i);

    for (let j = min; j <= max; j++) {
      if (selectMode === 'add') {
        selected.add(j);
        if (elements[j]) elements[j].classList.add('selected');
      } else {
        selected.delete(j);
        if (elements[j]) elements[j].classList.remove('selected');
      }
    }
    updateSelectedBorderRadius();
    updateStats();
  });

  // 鼠标释放结束选择
  content.addEventListener('mouseup', () => {
    pendingShiftDragStart = -1;
    pendingShiftDragPoint = null;
    if (!isSelecting) {
      return;
    }

    isSelecting = false;
    shiftRangeAnchor = null;
    render();
  });

  document.addEventListener('keyup', e => {
    if (e.key === 'Shift' && !isSelecting) {
      shiftRangeAnchor = null;
    }
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
    if (e.code === 'Escape' && mobileQuery.matches && sidebarOpenMobile) {
      e.preventDefault();
      toggleSidebar(false);
      return;
    }

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
  window.wavesurfer = wavesurfer;
}
