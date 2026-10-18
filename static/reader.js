/**
 * 遥卷 (Yaojuan) - 高性能沉浸式阅读引擎
 * - 智能多模态字符编码嗅探（自适应 UTF-8 / GB18030 / GBK / UTF-16，杜绝任何乱码）
 * - 按章节轻量化虚拟视口渲染（从全量 60,000 节点优化至几十个节点，彻底根治大文件浏览器崩溃）
 * - 深度兼容 generate.py 双层分幕与常规百万字单层网文
 * - 百章智能折叠目录与秒级实时目录筛选
 * - 局域网 WebSocket 无线遥控手柄联动
 */

(function () {
  'use strict';

  // 防御性编程安全阈值
  const SAFETY = {
    MAX_FILE_SIZE: 80 * 1024 * 1024,   // 80MB 前端内存防御上限
    MAX_PARAS_PER_CHAPTER: 180,        // 单章段落数超过 180 自动分部，保证 DOM 挂载节点数永不超过 200
    MAX_LINE_CHAR_LIMIT: 2500,         // 单行长文本切分上限（防止无换行大段排版卡死）
    REGEX_LINE_LEN_LIMIT: 80,          // 标题正则前置门禁（>80 字符跳过正则，彻底免疫 ReDoS 攻击）
    SEARCH_TIME_LIMIT_MS: 120,         // 全文检索单次循环熔断上限 (120ms)
    DEBOUNCE_PROGRESS_MS: 400,         // 进度存储防抖 (400ms)
  };

  // 全局运行时防崩溃捕获器
  window.addEventListener('error', (e) => {
    console.error('[Reader Runtime Guard Error]', e.error || e.message);
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.warn('[Reader Unhandled Rejection]', e.reason);
  });

  // 全局核心状态
  const state = {
    book: null,             // { name, path, content, size }
    isDualLevel: false,     // 是否为 generate.py 双层分幕结构（章 -> 幕）
    chapters: [],           // 章节数组 [ { index, title, paragraphs, scenes, hasScenes, wordCount } ]
    flatScenes: [],         // 若为双层结构，扁平化分幕列表
    currentChapIndex: 0,    // 当前正在阅读的章节索引 (0 ~ N-1)
    currentSceneId: '',     // 当前分幕 ID（双层模式）
    readingKey: '',         // 本地进度存储 Key
    legacyReadingKey: '',   // 旧版本进度存储 Key，用于兼容迁移
    currentBookPath: '',    // 当前正在阅读的书库条目
    shelfBooks: [],         // 当前书架上可见的预置书籍
    hiddenBookPaths: new Set(), // 仅在本机隐藏书架条目，不删除文件
    settings: {
      theme: 'parchment',
      fontFamily: "'Source Han Serif SC', 'Noto Serif CJK SC', 'SimSun', serif",
      fontSize: 20,
      lineHeight: 1.8,
      contentWidth: 860,
    },
    remote: {
      ws: null,
      pin: '',
      maxControllers: 1,
      controllers: [],
      allIps: [],
      selectedIp: '',
      port: 8765,
    },
    qrCodeInstance: null,
  };

  const THEMES = ['parchment', 'greentea', 'cleanwhite', 'darkgray', 'pureblack'];
  const THEME_NAMES = {
    parchment: '暖黄羊皮纸',
    greentea: '豆沙淡绿',
    cleanwhite: '极简水墨',
    darkgray: '夜间雅灰',
    pureblack: '深邃纯黑',
  };

  // DOM 元素缓存
  const el = {
    topNav: document.getElementById('topNav'),
    btnToggleSidebar: document.getElementById('btnToggleSidebar'),
    sidebar: document.getElementById('sidebar'),
    btnCloseSidebar: document.getElementById('btnCloseSidebar'),
    bookTitle: document.getElementById('bookTitle'),
    currentChapterPill: document.getElementById('currentChapterPill'),
    articleContent: document.getElementById('articleContent'),
    novelMainTitle: document.getElementById('novelMainTitle'),
    novelMetaInfo: document.getElementById('novelMetaInfo'),
    bookCoverHeader: document.getElementById('bookCoverHeader'),
    tocTree: document.getElementById('tocTree'),
    tocStats: document.getElementById('tocStats'),
    tocFilterInput: document.getElementById('tocFilterInput'),
    btnExpandAll: document.getElementById('btnExpandAll'),
    btnCollapseAll: document.getElementById('btnCollapseAll'),
    btnLocateCurrent: document.getElementById('btnLocateCurrent'),
    btnSearch: document.getElementById('btnSearch'),
    searchInput: document.getElementById('searchInput'),
    btnExecSearch: document.getElementById('btnExecSearch'),
    searchSummary: document.getElementById('searchSummary'),
    searchResultsList: document.getElementById('searchResultsList'),
    presetBookList: document.getElementById('presetBookList'),
    btnRestoreHiddenBooks: document.getElementById('btnRestoreHiddenBooks'),
    filePicker: document.getElementById('filePicker'),
    dropZone: document.getElementById('dropZone'),
    btnSettings: document.getElementById('btnSettings'),
    settingsModal: document.getElementById('settingsModal'),
    btnCloseSettingsModal: document.getElementById('btnCloseSettingsModal'),
    btnThemeCycle: document.getElementById('btnThemeCycle'),
    btnFullscreen: document.getElementById('btnFullscreen'),
    btnOpenRemoteModal: document.getElementById('btnOpenRemoteModal'),
    remoteModal: document.getElementById('remoteModal'),
    btnCloseRemoteModal: document.getElementById('btnCloseRemoteModal'),
    remoteStatusDot: document.getElementById('remoteStatusDot'),
    remoteStatusText: document.getElementById('remoteStatusText'),
    pinDisplay: document.getElementById('pinDisplay'),
    btnRefreshPin: document.getElementById('btnRefreshPin'),
    btnDecMaxDevices: document.getElementById('btnDecMaxDevices'),
    btnIncMaxDevices: document.getElementById('btnIncMaxDevices'),
    maxDevicesValue: document.getElementById('maxDevicesValue'),
    deviceListContainer: document.getElementById('deviceListContainer'),
    connectedCount: document.getElementById('connectedCount'),
    lanIpSelect: document.getElementById('lanIpSelect'),
    remoteUrlInput: document.getElementById('remoteUrlInput'),
    btnCopyRemoteUrl: document.getElementById('btnCopyRemoteUrl'),
    qrCodeContainer: document.getElementById('qrCodeContainer'),
    statusBar: document.getElementById('statusBar'),
    statusSceneTitle: document.getElementById('statusSceneTitle'),
    statusProgressPercent: document.getElementById('statusProgressPercent'),
    progressBarFill: document.getElementById('progressBarFill'),
    statusWordCount: document.getElementById('statusWordCount'),
    btnFloatPrev: document.getElementById('btnFloatPrev'),
    btnFloatNext: document.getElementById('btnFloatNext'),
    remoteHud: document.getElementById('remoteHud'),
    hudText: document.getElementById('hudText'),
    fontSizeSlider: document.getElementById('fontSizeSlider'),
    fontSizeVal: document.getElementById('fontSizeVal'),
    btnDecFontSize: document.getElementById('btnDecFontSize'),
    btnIncFontSize: document.getElementById('btnIncFontSize'),
    lineHeightSlider: document.getElementById('lineHeightSlider'),
    lineHeightVal: document.getElementById('lineHeightVal'),
    btnDecLineHeight: document.getElementById('btnDecLineHeight'),
    btnIncLineHeight: document.getElementById('btnIncLineHeight'),
    contentWidthSlider: document.getElementById('contentWidthSlider'),
    contentWidthVal: document.getElementById('contentWidthVal'),
    fontFamilySelect: document.getElementById('fontFamilySelect'),
  };

  // ==========================================
  // 1. 初始化入口
  // ==========================================
  async function init() {
    loadSavedSettings();
    applySettings();
    initUIEventListeners();
    initKeyboardShortcuts();
    initDragAndDrop();
    await fetchServerStatus();
    initReaderWebSocket();
    await loadPresetBooks();
  }

  // ==========================================
  // 2. 智能编码检测解码器 (彻底杜绝乱码)
  // ==========================================
  function decodeTextBuffer(buffer) {
    const uint8 = new Uint8Array(buffer);

    // 1. 检测 BOM 标头
    if (uint8.length >= 3 && uint8[0] === 0xEF && uint8[1] === 0xBB && uint8[2] === 0xBF) {
      return new TextDecoder('utf-8').decode(uint8.subarray(3));
    }
    if (uint8.length >= 2 && uint8[0] === 0xFF && uint8[1] === 0xFE) {
      return new TextDecoder('utf-16le').decode(uint8.subarray(2));
    }
    if (uint8.length >= 2 && uint8[0] === 0xFE && uint8[1] === 0xFF) {
      return new TextDecoder('utf-16be').decode(uint8.subarray(2));
    }

    // 2. 严格测试 UTF-8 校验 (全量缓冲解码，杜绝 128KB 切片切断中文字符导致的乱码回退)
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(uint8);
    } catch (e) {
      // 存在非法 UTF-8 字节，则中文文本 99.9% 属于 GB18030 / GBK
    }

    // 3. 使用 GB18030 / GBK 解码
    try {
      return new TextDecoder('gb18030').decode(uint8);
    } catch (e) {
      try {
        return new TextDecoder('gbk').decode(uint8);
      } catch (err2) {
        return new TextDecoder('utf-8', { fatal: false }).decode(uint8);
      }
    }
  }

  // ==========================================
  // 3. 极速章节结构分析引擎与防御性切片
  // ==========================================
  function splitLongLine(line) {
    if (line.length <= SAFETY.MAX_LINE_CHAR_LIMIT) return [line];
    const chunks = [];
    for (let i = 0; i < line.length; i += SAFETY.MAX_LINE_CHAR_LIMIT) {
      chunks.push(line.slice(i, i + SAFETY.MAX_LINE_CHAR_LIMIT));
    }
    return chunks;
  }

  function parseNovelStructure(rawText, filename) {
    const lines = rawText.split(/\r?\n/);
    const chapters = [];
    const flatScenes = [];

    // 正则模式
    // 一级章节：支持 # 第X章、第X章、第X卷、第X回、第X节、Chapter X、序章等
    const reChapter = /^(?:#\s*)?(第[0-9一二三四五六七八九十百千万]+[章卷回节篇部]|Chapter\s*\d+|序章|尾声|番外)(.*)$/i;
    // 二级分幕：## 分幕 X-Y · 标题
    const reScene = /^(?:##\s*)?(分幕\s*\d+-\d+.*?)$/;

    // 首先快速扫描全文是否包含“分幕”标记
    let hasSceneMarkers = false;
    for (let i = 0; i < Math.min(lines.length, 300); i++) {
      const tr = lines[i].trim();
      if (tr.length <= SAFETY.REGEX_LINE_LEN_LIMIT && reScene.test(tr)) {
        hasSceneMarkers = true;
        break;
      }
    }

    let curChap = null;
    let curScene = null;
    let chapCounter = 0;
    let sceneCounter = 0;
    let subPartIdx = 0;
    let subSceneIdx = 0;

    function flushCurrentScene() {
      if (curScene) {
        const textStr = curScene.paragraphs.join('\n\n');
        curScene.wordCount = textStr.replace(/\s+/g, '').length;
        flatScenes.push(curScene);
        curScene = null;
      }
    }

    function flushCurrentChapter() {
      flushCurrentScene();
      if (curChap) {
        let words = 0;
        if (curChap.hasScenes) {
          curChap.scenes.forEach((s) => (words += s.wordCount));
        } else {
          const t = curChap.paragraphs.join('\n\n');
          words = t.replace(/\s+/g, '').length;
        }
        curChap.wordCount = words;
        chapters.push(curChap);
        curChap = null;
      }
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      // 正则防 ReDoS 门禁：行长超过 SAFETY.REGEX_LINE_LEN_LIMIT 不可能是章节名，绝不执行复杂正则
      const canBeTitle = line.length <= SAFETY.REGEX_LINE_LEN_LIMIT;
      const mChap = canBeTitle ? line.match(reChapter) : null;
      const mScene = (hasSceneMarkers && canBeTitle) ? line.match(reScene) : null;

      if (mChap && !line.includes('分幕')) {
        flushCurrentChapter();
        chapCounter++;
        subPartIdx = 0;
        subSceneIdx = 0;
        curChap = {
          index: chapCounter - 1,
          title: line.replace(/^#+\s*/, '').trim(),
          hasScenes: hasSceneMarkers,
          scenes: [],
          paragraphs: [],
          wordCount: 0,
        };
      } else if (mScene && curChap) {
        flushCurrentScene();
        sceneCounter++;
        subSceneIdx = 0;
        curScene = {
          id: `scene_${chapCounter}_${curChap.scenes.length + 1}`,
          title: mScene[1].trim(),
          chapterIndex: curChap.index,
          sceneIndex: curChap.scenes.length,
          paragraphs: [],
          wordCount: 0,
        };
        curChap.scenes.push(curScene);
      } else {
        // 普通段落
        if (!curChap) {
          chapCounter++;
          curChap = {
            index: 0,
            title: filename || '正文',
            hasScenes: hasSceneMarkers,
            scenes: [],
            paragraphs: [],
            wordCount: 0,
          };
        }

        const chunks = splitLongLine(line);
        for (let c = 0; c < chunks.length; c++) {
          const chunk = chunks[c];
          if (hasSceneMarkers) {
            if (!curScene) {
              sceneCounter++;
              curScene = {
                id: `scene_${chapCounter}_${curChap.scenes.length + 1}`,
                title: `分幕 ${curChap.index + 1}-1`,
                chapterIndex: curChap.index,
                sceneIndex: curChap.scenes.length,
                paragraphs: [],
                wordCount: 0,
              };
              curChap.scenes.push(curScene);
            }
            curScene.paragraphs.push(chunk);

            // 分幕段落数安全熔断：单幕超过上限自动分部
            if (curScene.paragraphs.length >= SAFETY.MAX_PARAS_PER_CHAPTER) {
              const origTitle = curScene.title.replace(/\s*\(续.*?\)$/, '');
              subSceneIdx++;
              flushCurrentScene();
              sceneCounter++;
              curScene = {
                id: `scene_${chapCounter}_${curChap.scenes.length + 1}`,
                title: `${origTitle} (续 ${subSceneIdx})`,
                chapterIndex: curChap.index,
                sceneIndex: curChap.scenes.length,
                paragraphs: [],
                wordCount: 0,
              };
              curChap.scenes.push(curScene);
            }
          } else {
            curChap.paragraphs.push(chunk);

            // 单章段落数安全熔断：单章超过上限自动分部（彻底根治无章节超大文件把几万段塞入同一章卡崩 DOM）
            if (curChap.paragraphs.length >= SAFETY.MAX_PARAS_PER_CHAPTER) {
              const origTitle = curChap.title.replace(/\s*\(续.*?\)$/, '');
              subPartIdx++;
              flushCurrentChapter();
              chapCounter++;
              curChap = {
                index: chapCounter - 1,
                title: `${origTitle} (续 ${subPartIdx})`,
                hasScenes: false,
                scenes: [],
                paragraphs: [],
                wordCount: 0,
              };
            }
          }
        }
      }
    }
    flushCurrentChapter();

    // 容错兜底：若未识别到任何明确章节（无标题短文），自动按每 3500 字分章
    if (chapters.length === 0) {
      let tempParas = [];
      let tempLen = 0;
      let partIdx = 1;
      for (let line of lines) {
        const tr = line.trim();
        if (!tr) continue;
        tempParas.push(tr);
        tempLen += tr.length;
        if (tempLen >= 3500) {
          chapters.push({
            index: partIdx - 1,
            title: `第 ${partIdx} 节`,
            hasScenes: false,
            scenes: [],
            paragraphs: tempParas,
            wordCount: tempLen,
          });
          tempParas = [];
          tempLen = 0;
          partIdx++;
        }
      }
      if (tempParas.length > 0) {
        chapters.push({
          index: partIdx - 1,
          title: `第 ${partIdx} 节`,
          hasScenes: false,
          scenes: [],
          paragraphs: tempParas,
          wordCount: tempLen,
        });
      }
    }

    return {
      isDualLevel: hasSceneMarkers,
      chapters,
      flatScenes,
    };
  }

  // ==========================================
  // 4. 小说载入与章节虚拟化轻量渲染 (解决卡崩)
  // ==========================================
  function renderBook(bookData) {
    state.book = bookData;
    state.currentBookPath = bookData.path || '';
    state.readingKey = `yaojuan_pos_${encodeURIComponent(bookData.name)}`;
    state.legacyReadingKey = `comfort_reader_pos_${encodeURIComponent(bookData.name)}`;

    console.time('parse_novel');
    const { isDualLevel, chapters, flatScenes } = parseNovelStructure(bookData.content, bookData.name);
    console.timeEnd('parse_novel');

    state.isDualLevel = isDualLevel;
    state.chapters = chapters;
    state.flatScenes = flatScenes;

    // 计算全书总字数
    let totalWords = 0;
    chapters.forEach((c) => (totalWords += c.wordCount));

    // 更新标题与统计
    const cleanTitle = bookData.name.replace(/\.(md|txt)$/i, '');
    el.bookTitle.textContent = cleanTitle;
    el.novelMainTitle.textContent = cleanTitle;
    el.novelMetaInfo.textContent = isDualLevel
      ? `共 ${chapters.length} 章 · ${flatScenes.length} 幕 · 合计 ${totalWords.toLocaleString()} 字`
      : `共 ${chapters.length} 章 · 合计 ${totalWords.toLocaleString()} 字`;
    el.tocStats.textContent = isDualLevel
      ? `${chapters.length} 章 · ${flatScenes.length} 幕`
      : `全书共 ${chapters.length} 章`;
    el.statusWordCount.textContent = `全书共计 ${totalWords.toLocaleString()} 字`;

    // 渲染侧边栏树形目录（支持百章折叠）
    renderTocTree();
    updateShelfCurrent();

    // 恢复历史进度或默认从第 1 章开始
    restoreReadingProgress();
  }

  /**
   * 核心虚拟化渲染器：每次仅向 DOM 中渲染当前章节内容
   * 页面 DOM 节点数瞬间从 60,000 锐减至几十个，彻底杜绝内存爆炸与卡死！
   */
  function renderCurrentChapter(chapIndex, options = {}) {
    if (chapIndex < 0 || chapIndex >= state.chapters.length) return;
    state.currentChapIndex = chapIndex;
    const chap = state.chapters[chapIndex];

    const frag = document.createDocumentFragment();

    // 1. 章节大标题
    const headerDiv = document.createElement('div');
    headerDiv.className = 'chapter-divider';
    headerDiv.style.marginTop = '20px';
    headerDiv.innerHTML = `<h2 class="chapter-title">${escapeHtml(chap.title)}</h2>`;
    frag.appendChild(headerDiv);

    // 2. 正文渲染（支持双层分幕与单层段落）
    if (chap.hasScenes && chap.scenes.length > 0) {
      chap.scenes.forEach((sc) => {
        const scBlock = document.createElement('section');
        scBlock.className = 'scene-block';
        scBlock.id = sc.id;

        let paragraphsHtml = '';
        sc.paragraphs.forEach((p, pIdx) => {
          paragraphsHtml += `<p id="${sc.id}_p_${pIdx}">${escapeHtml(p)}</p>`;
        });

        scBlock.innerHTML = `
          <div class="scene-title">
            <span>${escapeHtml(sc.title)}</span>
            <span class="scene-title-badge">${sc.wordCount.toLocaleString()} 字</span>
          </div>
          <div class="scene-body">${paragraphsHtml}</div>
        `;
        frag.appendChild(scBlock);
      });
    } else {
      const contentBlock = document.createElement('div');
      contentBlock.className = 'scene-block';
      let paragraphsHtml = '';
      chap.paragraphs.forEach((p, pIdx) => {
        paragraphsHtml += `<p id="p_${chapIndex}_${pIdx}">${escapeHtml(p)}</p>`;
      });
      contentBlock.innerHTML = `<div class="scene-body">${paragraphsHtml}</div>`;
      frag.appendChild(contentBlock);
    }

    // 3. 章节底部翻页大导航条
    const navBottom = document.createElement('div');
    navBottom.className = 'chapter-nav-bottom';

    const prevBtn = document.createElement('button');
    prevBtn.className = 'nav-chapter-btn';
    prevBtn.textContent = '← 上一章';
    prevBtn.disabled = chapIndex === 0;
    prevBtn.addEventListener('click', () => prevChapter());

    const navInfo = document.createElement('span');
    navInfo.className = 'nav-chapter-info';
    const percent = ((chapIndex + 1) / state.chapters.length) * 100;
    navInfo.textContent = `第 ${chapIndex + 1} / ${state.chapters.length} 章 · 全书进度 ${percent.toFixed(1)}%`;

    const nextBtn = document.createElement('button');
    nextBtn.className = 'nav-chapter-btn';
    nextBtn.textContent = '下一章 →';
    nextBtn.disabled = chapIndex === state.chapters.length - 1;
    nextBtn.addEventListener('click', () => nextChapter());

    navBottom.appendChild(prevBtn);
    navBottom.appendChild(navInfo);
    navBottom.appendChild(nextBtn);
    frag.appendChild(navBottom);

    // 一次性挂载到 DOM
    el.articleContent.innerHTML = '';
    el.articleContent.appendChild(frag);

    // 更新顶栏与底栏
    el.currentChapterPill.textContent = chap.title;
    el.statusSceneTitle.textContent = chap.title;
    el.statusProgressPercent.textContent = `${percent.toFixed(1)}%`;
    el.progressBarFill.style.width = `${percent}%`;

    // 视口定位
    if (options.targetSceneId) {
      setTimeout(() => {
        const scEl = document.getElementById(options.targetSceneId);
        if (scEl) {
          scEl.scrollIntoView({ behavior: options.smooth ? 'smooth' : 'auto' });
        }
      }, 50);
    } else if (options.targetParagraphId) {
      setTimeout(() => {
        const pEl = document.getElementById(options.targetParagraphId);
        if (pEl) {
          pEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          pEl.style.backgroundColor = 'rgba(255, 235, 59, 0.35)';
        }
      }, 50);
    } else if (options.scrollToBottom) {
      requestAnimationFrame(() => {
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' });
      });
    } else if (!options.keepScroll) {
      window.scrollTo({ top: 0, behavior: options.smooth ? 'smooth' : 'auto' });
    }

    // 侧边栏高亮定位
    highlightCurrentToc();

    // 保存进度
    saveReadingProgress();
  }

  function nextChapter(smooth = true) {
    if (state.currentChapIndex < state.chapters.length - 1) {
      renderCurrentChapter(state.currentChapIndex + 1, { smooth: false });
      window.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'auto' });
      showRemoteHud(`📖 进入下一章：${state.chapters[state.currentChapIndex].title}`);
    } else {
      showRemoteHud('🏁 已经是全书最后一章啦！');
    }
  }

  function prevChapter(smooth = true, scrollToBottom = false) {
    if (state.currentChapIndex > 0) {
      renderCurrentChapter(state.currentChapIndex - 1, { smooth: false, scrollToBottom: scrollToBottom });
      if (!scrollToBottom) {
        window.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'auto' });
      }
      showRemoteHud(`📖 返回上一章：${state.chapters[state.currentChapIndex].title}`);
    } else {
      showRemoteHud('📌 已经是第一章啦！');
    }
  }

  function navigateToNextScene() {
    const chap = state.chapters[state.currentChapIndex];
    if (chap && chap.scenes && chap.scenes.length > 1) {
      const sceneBlocks = Array.from(el.articleContent.querySelectorAll('.scene-block'));
      const headerOffset = 70;
      const currentScrollY = window.scrollY;

      let nextBlock = null;
      for (const block of sceneBlocks) {
        const top = block.getBoundingClientRect().top + window.scrollY;
        if (top > currentScrollY + headerOffset + 10) {
          nextBlock = block;
          break;
        }
      }
      if (nextBlock) {
        nextBlock.scrollIntoView({ behavior: 'smooth' });
        const titleEl = nextBlock.querySelector('.scene-title span');
        const titleText = titleEl ? titleEl.textContent : '下一幕';
        showRemoteHud(`🎬 切换至：${titleText}`);
        return;
      }
    }
    nextChapter();
  }

  function navigateToPrevScene() {
    const chap = state.chapters[state.currentChapIndex];
    if (chap && chap.scenes && chap.scenes.length > 1) {
      const sceneBlocks = Array.from(el.articleContent.querySelectorAll('.scene-block'));
      const currentScrollY = window.scrollY;

      let prevBlock = null;
      for (let i = sceneBlocks.length - 1; i >= 0; i--) {
        const block = sceneBlocks[i];
        const top = block.getBoundingClientRect().top + window.scrollY;
        if (top < currentScrollY - 20) {
          prevBlock = block;
          break;
        }
      }
      if (prevBlock) {
        prevBlock.scrollIntoView({ behavior: 'smooth' });
        const titleEl = prevBlock.querySelector('.scene-title span');
        const titleText = titleEl ? titleEl.textContent : '上一幕';
        showRemoteHud(`🎬 切换至：${titleText}`);
        return;
      }
    }
    if (state.currentChapIndex > 0) {
      const prevChap = state.chapters[state.currentChapIndex - 1];
      if (prevChap && prevChap.scenes && prevChap.scenes.length > 1) {
        const lastScene = prevChap.scenes[prevChap.scenes.length - 1];
        renderCurrentChapter(state.currentChapIndex - 1, { targetSceneId: lastScene.id, smooth: false });
        showRemoteHud(`📖 返回上一章末尾：${prevChap.title}`);
      } else {
        prevChapter(true, true);
      }
    } else {
      showRemoteHud('📌 已经是第一章啦！');
    }
  }

  // ==========================================
  // 5. 百章智能分组侧边栏与实时筛选
  // ==========================================
  function renderTocTree() {
    el.tocTree.innerHTML = '';
    const total = state.chapters.length;

    // 当章节超过 60 章时启用百章卷分组，避免侧边栏一次渲染上千个 DOM
    if (total > 60 && !state.isDualLevel) {
      renderVolumeGroupedToc(total);
    } else {
      renderFlatOrDualToc();
    }
  }

  function renderVolumeGroupedToc(total) {
    const groupSize = 100;
    const numGroups = Math.ceil(total / groupSize);
    const frag = document.createDocumentFragment();

    for (let g = 0; g < numGroups; g++) {
      const start = g * groupSize;
      const end = Math.min(total, (g + 1) * groupSize);
      const isCurGroup = state.currentChapIndex >= start && state.currentChapIndex < end;

      const groupDiv = document.createElement('div');
      groupDiv.className = `toc-volume-group ${isCurGroup ? '' : 'collapsed'}`;
      groupDiv.id = `vol_group_${g}`;

      const titleDiv = document.createElement('div');
      titleDiv.className = 'toc-volume-title';
      titleDiv.innerHTML = `
        <span>📚 第 ${start + 1} ~ ${end} 章</span>
        <span class="chapter-arrow">▼</span>
      `;

      const itemsDiv = document.createElement('div');
      itemsDiv.className = 'toc-volume-items';

      function ensureVolumeItems() {
        if (groupDiv._populated) return;
        const subFrag = document.createDocumentFragment();
        for (let i = start; i < end; i++) {
          const chap = state.chapters[i];
          const scItem = document.createElement('div');
          scItem.className = `toc-scene-item ${i === state.currentChapIndex ? 'active' : ''}`;
          scItem.dataset.chapIndex = i;
          scItem.innerHTML = `
            <span class="scene-item-title">${escapeHtml(chap.title)}</span>
            <span class="scene-word-tag">${(chap.wordCount / 1000).toFixed(1)}k</span>
          `;
          scItem.addEventListener('click', () => {
            renderCurrentChapter(i);
            if (window.innerWidth < 800) el.sidebar.classList.remove('open');
          });
          subFrag.appendChild(scItem);
        }
        itemsDiv.appendChild(subFrag);
        groupDiv._populated = true;
      }

      groupDiv._ensureItems = ensureVolumeItems;

      titleDiv.addEventListener('click', () => {
        if (groupDiv.classList.contains('collapsed')) {
          ensureVolumeItems();
          groupDiv.classList.remove('collapsed');
        } else {
          groupDiv.classList.add('collapsed');
        }
      });

      groupDiv.appendChild(titleDiv);
      groupDiv.appendChild(itemsDiv);

      // 仅当当前阅读章节属于本卷时，初始即填充 DOM；其他卷折叠并延后懒加载（防止上千章节初始 DOM 挂载卡顿）
      if (isCurGroup) {
        ensureVolumeItems();
      }

      frag.appendChild(groupDiv);
    }

    el.tocTree.appendChild(frag);
  }

  function renderFlatOrDualToc() {
    const frag = document.createDocumentFragment();

    state.chapters.forEach((chap) => {
      const chapItem = document.createElement('div');
      chapItem.className = 'toc-chapter-item';
      chapItem.id = `toc_chap_${chap.index}`;

      const chapHeader = document.createElement('div');
      chapHeader.className = `toc-chapter-header ${chap.index === state.currentChapIndex ? 'active' : ''}`;
      chapHeader.innerHTML = `
        <span>${escapeHtml(chap.title)}</span>
        <span class="chapter-arrow">${chap.hasScenes ? '▼' : ''}</span>
      `;

      if (chap.hasScenes) {
        chapHeader.addEventListener('click', () => {
          chapItem.classList.toggle('collapsed');
        });

        const scenesContainer = document.createElement('div');
        scenesContainer.className = 'toc-scenes-container';

        chap.scenes.forEach((sc) => {
          const scItem = document.createElement('div');
          scItem.className = 'toc-scene-item';
          scItem.dataset.targetId = sc.id;
          scItem.dataset.chapIndex = chap.index;
          scItem.innerHTML = `
            <span class="scene-item-title">${escapeHtml(sc.title)}</span>
            <span class="scene-word-tag">${(sc.wordCount / 1000).toFixed(1)}k</span>
          `;
          scItem.addEventListener('click', () => {
            renderCurrentChapter(chap.index, { targetSceneId: sc.id });
            if (window.innerWidth < 800) el.sidebar.classList.remove('open');
          });
          scenesContainer.appendChild(scItem);
        });

        chapItem.appendChild(chapHeader);
        chapItem.appendChild(scenesContainer);
      } else {
        chapHeader.addEventListener('click', () => {
          renderCurrentChapter(chap.index);
          if (window.innerWidth < 800) el.sidebar.classList.remove('open');
        });
        chapItem.appendChild(chapHeader);
      }

      frag.appendChild(chapItem);
    });

    el.tocTree.appendChild(frag);
  }

  function highlightCurrentToc() {
    // 确保当前章节所在的分卷已经懒加载挂载 DOM
    const currentGroupIdx = Math.floor(state.currentChapIndex / 100);
    const vol = document.getElementById(`vol_group_${currentGroupIdx}`);
    if (vol && typeof vol._ensureItems === 'function') {
      vol._ensureItems();
      vol.classList.remove('collapsed');
    }

    document.querySelectorAll('.toc-scene-item, .toc-chapter-header').forEach((elem) => {
      const idx = parseInt(elem.dataset.chapIndex);
      if (idx === state.currentChapIndex) {
        elem.classList.add('active');
      } else {
        elem.classList.remove('active');
      }
    });
  }

  // 目录实时筛选输入框响应
  function filterTocChapters(keyword) {
    keyword = (keyword || '').trim().toLowerCase();
    // 搜索时若有关键词，先确保所有卷都已经展开加载了节点
    if (keyword) {
      document.querySelectorAll('.toc-volume-group').forEach((vg) => {
        if (typeof vg._ensureItems === 'function') vg._ensureItems();
      });
    }
    const items = el.tocTree.querySelectorAll('.toc-scene-item, .toc-chapter-item');
    if (!keyword) {
      items.forEach((item) => (item.style.display = ''));
      return;
    }
    items.forEach((item) => {
      const text = item.textContent.toLowerCase();
      item.style.display = text.includes(keyword) ? '' : 'none';
      if (text.includes(keyword)) {
        const vol = item.closest('.toc-volume-group');
        if (vol) vol.classList.remove('collapsed');
      }
    });
  }

  // ==========================================
  // 6. 滚动追踪与阅读进度持久化（带防抖防卡）
  // ==========================================
  let progressSaveTimer = null;
  function debouncedSaveReadingProgress() {
    clearTimeout(progressSaveTimer);
    progressSaveTimer = setTimeout(saveReadingProgress, SAFETY.DEBOUNCE_PROGRESS_MS);
  }

  function saveReadingProgress() {
    if (!state.readingKey || state.chapters.length === 0) return;
    try {
      const percent = ((state.currentChapIndex + 1) / state.chapters.length) * 100;
      localStorage.setItem(
        state.readingKey,
        JSON.stringify({
          chapterIndex: state.currentChapIndex,
          scrollY: window.scrollY,
          percent: percent,
          updatedAt: Date.now(),
        })
      );
    } catch (e) {
      console.warn('Save reading progress error:', e);
    }
  }

  function restoreReadingProgress() {
    if (!state.readingKey || state.chapters.length === 0) {
      renderCurrentChapter(0);
      return;
    }
    try {
      const raw = localStorage.getItem(state.readingKey) || localStorage.getItem(state.legacyReadingKey);
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved && saved.chapterIndex >= 0 && saved.chapterIndex < state.chapters.length) {
          renderCurrentChapter(saved.chapterIndex, { keepScroll: true });
          setTimeout(() => {
            window.scrollTo({ top: saved.scrollY || 0, behavior: 'auto' });
            const pctStr = (typeof saved.percent === 'number' && !isNaN(saved.percent))
              ? ` (${saved.percent.toFixed(1)}%)`
              : '';
            showRemoteHud(`📖 已自动为您续读至第 ${saved.chapterIndex + 1} 章${pctStr}`);
          }, 60);
          return;
        }
      }
    } catch (e) {}

    renderCurrentChapter(0);
  }

  // ==========================================
  // 7. WebSocket 手机无线遥控接收器
  // ==========================================
  let pcWsReconnectAttempts = 0;
  let pcWsReconnectTimer = null;

  function initReaderWebSocket() {
    clearTimeout(pcWsReconnectTimer);
    if (state.remote.ws && (state.remote.ws.readyState === WebSocket.OPEN || state.remote.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}/ws/reader`;

    state.remote.ws = new WebSocket(wsUrl);

    state.remote.ws.onopen = () => {
      console.log('[Remote] PC Reader WebSocket 已连接');
      pcWsReconnectAttempts = 0;
      updateRemoteBadge();
    };

    state.remote.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleRemoteMessage(data);
      } catch (err) {
        console.error('Remote message parse error:', err);
      }
    };

    state.remote.ws.onclose = () => {
      state.remote.controllers = [];
      updateRemoteBadge();

      // 指数退避重连（最小 2s，最大 30s）
      const delay = Math.min(30000, 2000 * Math.pow(1.5, pcWsReconnectAttempts));
      pcWsReconnectAttempts++;
      const finalDelay = document.hidden ? Math.max(delay, 15000) : delay;
      clearTimeout(pcWsReconnectTimer);
      pcWsReconnectTimer = setTimeout(initReaderWebSocket, finalDelay);
    };

    state.remote.ws.onerror = () => {
      // 触发 onclose 统一调度重连
    };
  }

  // 页面切回前台时唤醒检查连接状态
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      if (!state.remote.ws || state.remote.ws.readyState === WebSocket.CLOSED) {
        pcWsReconnectAttempts = 0;
        initReaderWebSocket();
      }
    }
  });

  // 手机遥控平滑滚动合并调度器 (对齐浏览器垂直同步刷新率)
  let pendingRemoteDelta = 0;
  let rafRemoteScrollId = null;

  function scheduleRemoteScroll(delta) {
    pendingRemoteDelta += delta;
    if (!rafRemoteScrollId) {
      rafRemoteScrollId = requestAnimationFrame(() => {
        window.scrollBy({ top: pendingRemoteDelta, behavior: 'auto' });
        pendingRemoteDelta = 0;
        rafRemoteScrollId = null;
      });
    }
  }

  function handleRemoteMessage(msg) {
    if (msg.type === 'init' || msg.type === 'devices_update') {
      state.remote.pin = msg.pin;
      state.remote.maxControllers = msg.max_controllers;
      state.remote.controllers = msg.controllers || [];
      updateRemoteModalUI();
      updateRemoteBadge();
      return;
    }

    // 处理来自手机遥控端的指令
    switch (msg.action) {
      case 'page_down': {
        const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
        if (window.scrollY >= maxScroll - 30) {
          // 已到底部，自动翻至下一章
          nextChapter();
        } else {
          window.scrollBy({ top: window.innerHeight * 0.78, behavior: 'smooth' });
          showRemoteHud('📱 手机遥控 · 下翻页');
        }
        break;
      }

      case 'page_up': {
        if (window.scrollY <= 30) {
          // 已在顶部，返回上一章
          prevChapter();
        } else {
          window.scrollBy({ top: -window.innerHeight * 0.78, behavior: 'smooth' });
          showRemoteHud('📱 手机遥控 · 上翻页');
        }
        break;
      }

      case 'scroll_by':
        // 虚拟滑板毫秒级跟手滚动 (RAF 调度防卡顿)
        scheduleRemoteScroll(msg.delta || 0);
        break;

      case 'next_scene':
        navigateToNextScene();
        break;

      case 'prev_scene':
        navigateToPrevScene();
        break;

      case 'zoom':
        if (msg.dir === 'in') {
          adjustFontSize(1);
          showRemoteHud(`🔍 放大字号 (${state.settings.fontSize}px)`);
        } else if (msg.dir === 'out') {
          adjustFontSize(-1);
          showRemoteHud(`🔍 缩小字号 (${state.settings.fontSize}px)`);
        }
        break;

      case 'toggle_theme':
        cycleTheme();
        showRemoteHud(`🎨 切换主题 (${THEME_NAMES[state.settings.theme]})`);
        break;

      case 'toggle_fullscreen':
        toggleFullscreen().then((mode) => {
          const text = mode.startsWith('immersive')
            ? (mode === 'immersive-on' ? '沉浸模式已开启' : '沉浸模式已关闭')
            : (mode === 'fullscreen-on' ? '已进入浏览器全屏' : '已退出浏览器全屏');
          showRemoteHud(`⛶ ${text}`);
        });
        break;

      case 'scroll_top':
        window.scrollTo({ top: 0, behavior: 'smooth' });
        showRemoteHud('⬆ 回到顶部');
        break;

      case 'scroll_bottom':
        window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
        showRemoteHud('⬇ 滚到底部');
        break;

      case 'toggle_toc':
        el.sidebar.classList.toggle('open');
        showRemoteHud('📑 切换目录栏');
        break;

      default:
        break;
    }
  }

  let hudTimer = null;
  function showRemoteHud(text) {
    el.hudText.textContent = text;
    el.remoteHud.classList.add('show');
    clearTimeout(hudTimer);
    hudTimer = setTimeout(() => {
      el.remoteHud.classList.remove('show');
    }, 1800);
  }

  function updateRemoteBadge() {
    const count = state.remote.controllers.length;
    if (count > 0) {
      el.remoteStatusDot.className = 'status-dot connected';
      el.remoteStatusText.textContent = `遥控中 (${count}台)`;
    } else {
      el.remoteStatusDot.className = 'status-dot disconnected';
      el.remoteStatusText.textContent = '手机遥控';
    }
  }

  // ==========================================
  // 8. 遥控弹窗与 PIN 码、设备上限管理
  // ==========================================
  async function fetchServerStatus() {
    try {
      const resp = await fetch('/api/status');
      const data = await resp.json();
      state.remote.pin = data.pin;
      state.remote.maxControllers = data.max_controllers;
      state.remote.controllers = data.controllers || [];
      state.remote.allIps = data.all_ips || ['127.0.0.1'];
      state.remote.selectedIp = data.primary_ip || '127.0.0.1';
      state.remote.port = data.port || 8765;

      populateIpSelect();
      updateRemoteModalUI();
      updateRemoteBadge();
    } catch (e) {
      console.warn('Fetch server status error:', e);
    }
  }

  function populateIpSelect() {
    el.lanIpSelect.innerHTML = '';
    state.remote.allIps.forEach((ip) => {
      const opt = document.createElement('option');
      opt.value = ip;
      let label = `${ip} (局域网)`;
      if (ip.startsWith('192.168.137.')) {
        label = `${ip} (★ 电脑移动热点)`;
      } else if (ip.startsWith('192.168.')) {
        label = `${ip} (局域网 Wi-Fi)`;
      } else if (ip.startsWith('172.')) {
        label = `${ip} (上级外网 WLAN)`;
      }
      opt.textContent = label;
      if (ip === state.remote.selectedIp) opt.selected = true;
      el.lanIpSelect.appendChild(opt);
    });
    updateRemoteUrlAndQr();
  }

  function updateRemoteUrlAndQr() {
    const ip = el.lanIpSelect.value || state.remote.selectedIp;
    const protocol = location.protocol || 'http:';
    const pinQuery = state.remote.pin ? `?pin=${encodeURIComponent(state.remote.pin)}` : '';
    const url = `${protocol}//${ip}:${state.remote.port}/remote${pinQuery}`;
    el.remoteUrlInput.value = url;

    // 渲染二维码
    if (window.QRCode && el.qrCodeContainer) {
      if (!state.qrCodeInstance) {
        state.qrCodeInstance = new QRCode(el.qrCodeContainer, {
          text: url,
          width: 180,
          height: 180,
          colorDark: '#000000',
          colorLight: '#ffffff',
        });
      } else {
        state.qrCodeInstance.makeCode(url);
      }
    }
  }

  function updateRemoteModalUI() {
    const pin = state.remote.pin || '--------';
    const formatted = pin.length === 8 ? `${pin.slice(0, 4)}-${pin.slice(4)}` : pin;
    el.pinDisplay.textContent = formatted;
    el.maxDevicesValue.textContent = `${state.remote.maxControllers} 台`;
    el.connectedCount.textContent = state.remote.controllers.length;
    el.deviceListContainer.innerHTML = '';

    if (state.remote.controllers.length === 0) {
      el.deviceListContainer.innerHTML = '<div class="empty-device-hint">暂无手机接入，扫码或打开上方链接即可配对。</div>';
    } else {
      state.remote.controllers.forEach((c) => {
        const item = document.createElement('div');
        item.className = 'device-item';
        item.innerHTML = `
          <div class="device-details">
            <span class="device-name">📱 ${escapeHtml(c.user_agent || '手机')}</span>
            <span class="device-ip">IP: ${escapeHtml(c.ip || '')} · 连入时间: ${escapeHtml(c.connected_at || '')}</span>
          </div>
          <button class="kick-btn" data-id="${escapeHtml(c.id || '')}">断开</button>
        `;
        item.querySelector('.kick-btn').addEventListener('click', () => {
          sendWsAction({ action: 'kick', id: c.id });
        });
        el.deviceListContainer.appendChild(item);
      });
    }
  }

  function sendWsAction(payload) {
    if (state.remote.ws && state.remote.ws.readyState === WebSocket.OPEN) {
      state.remote.ws.send(JSON.stringify(payload));
    }
  }

  // ==========================================
  // 9. 本地书库加载与文件拖拽读取 (ArrayBuffer 解码)
  // ==========================================
  const HIDDEN_BOOKS_KEY = 'yaojuan_hidden_books';
  const LEGACY_HIDDEN_BOOKS_KEY = 'comfort_reader_hidden_books';

  function loadHiddenBookPaths() {
    try {
      const raw = localStorage.getItem(HIDDEN_BOOKS_KEY) || localStorage.getItem(LEGACY_HIDDEN_BOOKS_KEY);
      const saved = raw ? JSON.parse(raw) : [];
      state.hiddenBookPaths = new Set(
        Array.isArray(saved) ? saved.filter((path) => typeof path === 'string') : []
      );
    } catch (e) {
      state.hiddenBookPaths = new Set();
    }
  }

  function saveHiddenBookPaths() {
    try {
      localStorage.setItem(HIDDEN_BOOKS_KEY, JSON.stringify([...state.hiddenBookPaths]));
    } catch (e) {
      console.warn('Save hidden books error:', e);
    }
  }

  function updateShelfRestoreButton() {
    const count = state.hiddenBookPaths.size;
    el.btnRestoreHiddenBooks.hidden = count === 0;
    el.btnRestoreHiddenBooks.textContent = `恢复已移除 (${count})`;
  }

  function updateShelfCurrent() {
    el.presetBookList.querySelectorAll('.book-card').forEach((card) => {
      card.classList.toggle('current', card.dataset.bookPath === state.currentBookPath);
    });
  }

  function removeBookFromShelf(book, card) {
    state.hiddenBookPaths.add(book.path);
    state.shelfBooks = state.shelfBooks.filter((item) => item.path !== book.path);
    saveHiddenBookPaths();
    card.remove();
    updateShelfRestoreButton();

    if (el.presetBookList.querySelectorAll('.book-card').length === 0) {
      el.presetBookList.innerHTML = '<div class="loading-hint">快捷书单为空，可从上方恢复已移除的书籍。</div>';
    }
    showRemoteHud(`已从书架移除《${book.name}》，原文件未删除`);
  }

  function renderEmptyShelfState() {
    el.bookTitle.textContent = '遥卷';
    el.novelMainTitle.textContent = '快捷书单为空';
    el.novelMetaInfo.textContent = '恢复已移除的书籍，或将 TXT / MD 文件拖入页面';
    el.articleContent.innerHTML = `
      <div class="empty-shelf-state">
        <h3>没有可阅读的文本</h3>
        <p>书架中的书籍仍在原位置，可从快捷书单恢复，也可以直接拖入本地文本。</p>
      </div>
    `;
    el.tocStats.textContent = '0 章';
    el.currentChapterPill.textContent = '尚无章节';
    el.statusSceneTitle.textContent = '等待选择文本';
    el.statusProgressPercent.textContent = '0.0%';
    el.progressBarFill.style.width = '0%';
    el.statusWordCount.textContent = '全书共计 0 字';
  }

  async function loadPresetBooks(options = {}) {
    const shouldAutoLoad = options.autoLoad !== false;
    try {
      const resp = await fetch('/api/books');
      const data = await resp.json();
      loadHiddenBookPaths();
      el.presetBookList.innerHTML = '';
      updateShelfRestoreButton();

      state.shelfBooks = (data.books || []).filter((book) => !state.hiddenBookPaths.has(book.path));
      if (state.shelfBooks.length > 0) {
        state.shelfBooks.forEach((b) => {
          const card = document.createElement('div');
          card.className = 'book-card';
          card.dataset.bookPath = b.path;
          card.innerHTML = `
            <div class="book-card-name">${escapeHtml(b.name)}</div>
            <div class="book-card-meta">
              <span>${b.size_mb} MB</span>
              <span>${b.updated_at}</span>
            </div>
          `;
          const removeBtn = document.createElement('button');
          removeBtn.type = 'button';
          removeBtn.className = 'shelf-remove-btn';
          removeBtn.title = '从书架移除，不会删除原文件';
          removeBtn.setAttribute('aria-label', `从书架移除 ${b.name}`);
          removeBtn.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <circle cx="12" cy="12" r="9"></circle>
              <path d="M8 12h8"></path>
            </svg>
          `;
          removeBtn.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            removeBookFromShelf(b, card);
          });
          card.addEventListener('click', () => {
            loadBookFromPath(b.path);
            if (window.innerWidth < 800) el.sidebar.classList.remove('open');
          });
          card.appendChild(removeBtn);
          el.presetBookList.appendChild(card);
        });

        // 默认自动加载第一本
        const first = state.shelfBooks[0];
        if (shouldAutoLoad && first) {
          loadBookFromPath(first.path);
        } else {
          updateShelfCurrent();
        }
      } else {
        const message = data.books && data.books.length > 0
          ? '快捷书单已全部移除，可点击上方按钮恢复；原文件仍然保留。'
          : '未扫描到预置小说，请拖拽导入文本。';
        el.presetBookList.innerHTML = `<div class="loading-hint">${message}</div>`;
        renderEmptyShelfState();
      }
    } catch (e) {
      console.warn('Load preset books error:', e);
    }
  }

  async function loadBookFromPath(path) {
    el.articleContent.innerHTML = '<div class="loading-spinner">正在从本地极速加载文本并解析分卷结构...</div>';
    try {
      const resp = await fetch(`/api/book/content?path=${encodeURIComponent(path)}`);
      if (!resp.ok) {
        const errJson = await resp.json().catch(() => ({}));
        throw new Error(errJson.detail || `加载失败 (HTTP ${resp.status})`);
      }
      const bookData = await resp.json();
      renderBook(bookData);
    } catch (err) {
      el.articleContent.innerHTML = `<div class="loading-spinner" style="color:#ef4444;">加载失败: ${escapeHtml(err.message || '未知错误')}</div>`;
    }
  }

  function initDragAndDrop() {
    el.filePicker.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) readFile(file);
    });

    ['dragenter', 'dragover'].forEach((eventName) => {
      document.body.addEventListener(eventName, (e) => {
        e.preventDefault();
        el.dropZone.classList.add('dragover');
      });
    });

    document.body.addEventListener('dragleave', (e) => {
      e.preventDefault();
      el.dropZone.classList.remove('dragover');
    });

    document.body.addEventListener('drop', (e) => {
      e.preventDefault();
      el.dropZone.classList.remove('dragover');
      const files = e.dataTransfer.files;
      if (files.length > 0) {
        readFile(files[0]);
      }
    });
  }

  function readFile(file) {
    if (!file) return;

    // 1. 防御性文件大小检查 (保护浏览器免于超大文件内存溢出崩溃)
    if (file.size > SAFETY.MAX_FILE_SIZE) {
      alert(`[安全拦截] 文件体积为 ${(file.size / (1024 * 1024)).toFixed(1)}MB，超过 80MB 前端内存防御上限，已取消加载以防止浏览器标签页卡崩。`);
      return;
    }

    // 2. 格式扩展名校验
    const dotIdx = file.name.lastIndexOf('.');
    const ext = dotIdx !== -1 ? file.name.slice(dotIdx).toLowerCase() : '';
    if (ext && !['.txt', '.md', '.log', '.text'].includes(ext)) {
      alert('仅支持导入 .txt 或 .md 格式的纯文本小说！');
      return;
    }

    el.articleContent.innerHTML = '<div class="loading-spinner">正在以多模态编码自适应解析大文本...</div>';
    const reader = new FileReader();

    reader.onerror = () => {
      el.articleContent.innerHTML = '<div class="loading-spinner" style="color:#ef4444;">读取本地文件失败，请检查文件权限或是否被其他程序独占。</div>';
    };

    reader.onload = (e) => {
      try {
        const arrayBuffer = e.target.result;
        const text = decodeTextBuffer(arrayBuffer);
        renderBook({
          name: file.name,
          path: file.name,
          content: text,
          size: file.size,
        });
        el.sidebar.classList.remove('open');
      } catch (err) {
        console.error('File parse error:', err);
        el.articleContent.innerHTML = `<div class="loading-spinner" style="color:#ef4444;">文本解析异常: ${escapeHtml(err.message)}</div>`;
      }
    };
    // 关键升级：以二进制 ArrayBuffer 读取，彻底避开默认 UTF-8 导致的 GBK 乱码
    reader.readAsArrayBuffer(file);
  }

  // ==========================================
  // 10. 全文毫秒级检索 (带主线程时间熔断保护)
  // ==========================================
  function highlightMatches(text, keyword) {
    if (!keyword) return escapeHtml(text);
    const regex = new RegExp(escapeRegExp(keyword), 'gi');
    let result = '';
    let lastIndex = 0;
    let match;
    while ((match = regex.exec(text)) !== null) {
      result += escapeHtml(text.slice(lastIndex, match.index));
      result += `<mark>${escapeHtml(match[0])}</mark>`;
      lastIndex = regex.lastIndex;
    }
    result += escapeHtml(text.slice(lastIndex));
    return result;
  }

  function performSearch() {
    const kw = el.searchInput.value.trim();
    if (!kw) return;

    el.searchResultsList.innerHTML = '<div class="loading-spinner">正在全书极速检索...</div>';
    const results = [];
    const maxResults = 50;
    const lowerKw = kw.toLowerCase();
    const startTime = performance.now();
    let hitTimeout = false;

    for (let c = 0; c < state.chapters.length; c++) {
      // 防御性主线程时间熔断：单次检索循环超过 SAFETY.SEARCH_TIME_LIMIT_MS 毫秒强制跳出，杜绝百万字搜索冻结 UI
      if (performance.now() - startTime > SAFETY.SEARCH_TIME_LIMIT_MS) {
        hitTimeout = true;
        break;
      }

      const chap = state.chapters[c];
      if (chap.hasScenes && chap.scenes && chap.scenes.length > 0) {
        for (let s = 0; s < chap.scenes.length; s++) {
          const sc = chap.scenes[s];
          for (let pIdx = 0; pIdx < sc.paragraphs.length; pIdx++) {
            const pText = sc.paragraphs[pIdx];
            const lowerText = pText.toLowerCase();
            const idx = lowerText.indexOf(lowerKw);
            if (idx !== -1) {
              const start = Math.max(0, idx - 25);
              const end = Math.min(pText.length, idx + kw.length + 35);
              results.push({
                chapIndex: c,
                chapterTitle: `${chap.title} · ${sc.title}`,
                targetParagraphId: `${sc.id}_p_${pIdx}`,
                snippet: pText.substring(start, end),
                keyword: kw,
              });
              if (results.length >= maxResults) break;
            }
          }
          if (results.length >= maxResults) break;
        }
      } else {
        for (let pIdx = 0; pIdx < chap.paragraphs.length; pIdx++) {
          const pText = chap.paragraphs[pIdx];
          const lowerText = pText.toLowerCase();
          const idx = lowerText.indexOf(lowerKw);
          if (idx !== -1) {
            const start = Math.max(0, idx - 25);
            const end = Math.min(pText.length, idx + kw.length + 35);
            results.push({
              chapIndex: c,
              chapterTitle: chap.title,
              targetParagraphId: `p_${c}_${pIdx}`,
              snippet: pText.substring(start, end),
              keyword: kw,
            });
            if (results.length >= maxResults) break;
          }
        }
      }
      if (results.length >= maxResults) break;
    }

    if (hitTimeout) {
      el.searchSummary.textContent = `全书体量庞大，检索耗时达到 ${SAFETY.SEARCH_TIME_LIMIT_MS}ms 保护线已自动熔断，呈现已找到的 ${results.length} 处结果：`;
    } else {
      el.searchSummary.textContent = `在全书中找到 ${results.length} 处匹配（最多显示前 50 条）：`;
    }

    if (results.length === 0) {
      el.searchResultsList.innerHTML = '<div class="empty-device-hint">未找到包含此关键词的段落。</div>';
      return;
    }

    const frag = document.createDocumentFragment();
    results.forEach((r) => {
      const item = document.createElement('div');
      item.className = 'search-item';

      const highlightedSnippet = highlightMatches(r.snippet, r.keyword);

      item.innerHTML = `
        <div class="search-item-chapter">${escapeHtml(r.chapterTitle)}</div>
        <div class="search-item-snippet">...${highlightedSnippet}...</div>
      `;

      item.addEventListener('click', () => {
        renderCurrentChapter(r.chapIndex, {
          targetParagraphId: r.targetParagraphId,
        });
        if (window.innerWidth < 800) el.sidebar.classList.remove('open');
      });

      frag.appendChild(item);
    });

    el.searchResultsList.appendChild(frag);
  }

  // ==========================================
  // 11. 界面事件绑定
  // ==========================================
  function initUIEventListeners() {
    el.btnToggleSidebar.addEventListener('click', () => el.sidebar.classList.toggle('open'));
    el.btnCloseSidebar.addEventListener('click', () => el.sidebar.classList.remove('open'));

    // 目录折叠/展开/定位
    el.btnExpandAll.addEventListener('click', () => {
      document.querySelectorAll('.toc-volume-group, .toc-chapter-item').forEach((item) => {
        if (typeof item._ensureItems === 'function') item._ensureItems();
        item.classList.remove('collapsed');
      });
    });
    el.btnCollapseAll.addEventListener('click', () => {
      document.querySelectorAll('.toc-volume-group, .toc-chapter-item').forEach((item) => item.classList.add('collapsed'));
    });
    el.btnLocateCurrent.addEventListener('click', () => {
      const item = document.querySelector(`.toc-scene-item.active, .toc-chapter-header.active`);
      if (item) {
        item.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });

    // 目录实时筛选输入框
    if (el.tocFilterInput) {
      el.tocFilterInput.addEventListener('input', (e) => filterTocChapters(e.target.value));
    }

    // 侧边栏选项卡
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
        document.querySelectorAll('.tab-pane').forEach((p) => p.classList.remove('active'));
        btn.classList.add('active');
        const targetPane = document.getElementById(btn.dataset.tab);
        if (targetPane) targetPane.classList.add('active');
      });
    });

    // 搜索
    el.btnSearch.addEventListener('click', () => {
      el.sidebar.classList.add('open');
      document.querySelector('.tab-btn[data-tab="tab-search"]').click();
      el.searchInput.focus();
    });
    el.btnExecSearch.addEventListener('click', performSearch);
    el.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') performSearch();
    });

    // 搜索输入轻量防抖
    let searchDebounceTimer = null;
    el.searchInput.addEventListener('input', () => {
      clearTimeout(searchDebounceTimer);
      if (el.searchInput.value.trim().length >= 2) {
        searchDebounceTimer = setTimeout(performSearch, 350);
      }
    });

    // 滚动时进度保存防抖监听（使用 passive 确保 120fps 流畅）
    window.addEventListener('scroll', debouncedSaveReadingProgress, { passive: true });

    // 悬浮翻页按钮（上一章 / 下一章）
    el.btnFloatPrev.addEventListener('click', () => prevChapter());
    el.btnFloatNext.addEventListener('click', () => nextChapter());

    // 遥控弹窗
    el.btnOpenRemoteModal.addEventListener('click', () => {
      updateRemoteModalUI();
      updateRemoteUrlAndQr();
      el.remoteModal.classList.add('open');
    });
    el.btnRestoreHiddenBooks.addEventListener('click', () => {
      state.hiddenBookPaths.clear();
      saveHiddenBookPaths();
      loadPresetBooks({ autoLoad: !state.book });
      showRemoteHud('已恢复书架条目，文件未被移动或修改');
    });
    el.btnCloseRemoteModal.addEventListener('click', () => el.remoteModal.classList.remove('open'));
    el.btnRefreshPin.addEventListener('click', () => sendWsAction({ action: 'refresh_pin' }));
    el.btnDecMaxDevices.addEventListener('click', () => {
      if (state.remote.maxControllers > 1) {
        sendWsAction({ action: 'set_max_controllers', value: state.remote.maxControllers - 1 });
      }
    });
    el.btnIncMaxDevices.addEventListener('click', () => {
      if (state.remote.maxControllers < 10) {
        sendWsAction({ action: 'set_max_controllers', value: state.remote.maxControllers + 1 });
      }
    });
    el.lanIpSelect.addEventListener('change', updateRemoteUrlAndQr);
    el.btnCopyRemoteUrl.addEventListener('click', () => {
      const copyText = el.remoteUrlInput.value;
      function onCopySuccess() {
        showRemoteHud('📋 局域网遥控链接已复制到剪贴板！');
      }
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        navigator.clipboard.writeText(copyText).then(onCopySuccess).catch(() => {
          fallbackCopyText(copyText, onCopySuccess);
        });
      } else {
        fallbackCopyText(copyText, onCopySuccess);
      }
    });

    // 设置弹窗
    el.btnSettings.addEventListener('click', () => el.settingsModal.classList.add('open'));
    el.btnCloseSettingsModal.addEventListener('click', () => el.settingsModal.classList.remove('open'));

    // 主题切换
    document.querySelectorAll('.theme-chip').forEach((chip) => {
      chip.addEventListener('click', () => setTheme(chip.dataset.theme));
    });
    el.btnThemeCycle.addEventListener('click', cycleTheme);

    // 全屏
    el.btnFullscreen.addEventListener('click', toggleFullscreen);

    // 排版控制
    el.fontSizeSlider.addEventListener('input', (e) => setFontSize(parseInt(e.target.value)));
    el.btnDecFontSize.addEventListener('click', () => adjustFontSize(-1));
    el.btnIncFontSize.addEventListener('click', () => adjustFontSize(1));

    el.lineHeightSlider.addEventListener('input', (e) => setLineHeight(parseFloat(e.target.value)));
    el.btnDecLineHeight.addEventListener('click', () => adjustLineHeight(-0.1));
    el.btnIncLineHeight.addEventListener('click', () => adjustLineHeight(0.1));

    el.contentWidthSlider.addEventListener('input', (e) => setContentWidth(parseInt(e.target.value)));
    el.fontFamilySelect.addEventListener('change', (e) => setFontFamily(e.target.value));

    // 模态蒙层点击关闭
    [el.remoteModal, el.settingsModal].forEach((m) => {
      m.addEventListener('click', (e) => {
        if (e.target === m) m.classList.remove('open');
      });
    });
  }

  // ==========================================
  // 12. 排版控制
  // ==========================================
  function setTheme(theme) {
    if (!THEMES.includes(theme)) theme = 'parchment';
    state.settings.theme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    saveSettings();
  }

  function cycleTheme() {
    const idx = THEMES.indexOf(state.settings.theme);
    const nextTheme = THEMES[(idx + 1) % THEMES.length];
    setTheme(nextTheme);
  }

  function setFontSize(size) {
    size = Math.min(36, Math.max(14, size));
    state.settings.fontSize = size;
    document.documentElement.style.setProperty('--font-size', `${size}px`);
    el.fontSizeSlider.value = size;
    el.fontSizeVal.textContent = `${size}px`;
    saveSettings();
  }

  function adjustFontSize(delta) {
    setFontSize(state.settings.fontSize + delta);
  }

  function setLineHeight(val) {
    val = Math.min(2.6, Math.max(1.4, parseFloat(val.toFixed(1))));
    state.settings.lineHeight = val;
    document.documentElement.style.setProperty('--line-height', val);
    el.lineHeightSlider.value = val;
    el.lineHeightVal.textContent = val.toFixed(1);
    saveSettings();
  }

  function adjustLineHeight(delta) {
    setLineHeight(state.settings.lineHeight + delta);
  }

  function setContentWidth(w) {
    state.settings.contentWidth = w;
    document.documentElement.style.setProperty('--content-width', `${w}px`);
    el.contentWidthSlider.value = w;
    el.contentWidthVal.textContent = `${w}px`;
    saveSettings();
  }

  function setFontFamily(font) {
    state.settings.fontFamily = font;
    document.documentElement.style.setProperty('--font-family', font);
    el.fontFamilySelect.value = font;
    saveSettings();
  }

  async function toggleFullscreen() {
    if (document.fullscreenElement) {
      if (document.exitFullscreen) {
        await document.exitFullscreen().catch(() => {});
      }
      return 'fullscreen-off';
    }

    try {
      await document.documentElement.requestFullscreen();
      return 'fullscreen-on';
    } catch (e) {
      // 遥控指令通常没有浏览器要求的用户手势，此时退回隐藏界面栏的沉浸模式。
      const root = document.documentElement;
      root.classList.toggle('immersive-mode');
      return root.classList.contains('immersive-mode') ? 'immersive-on' : 'immersive-off';
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem('yaojuan_settings', JSON.stringify(state.settings));
    } catch (e) {}
  }

  function loadSavedSettings() {
    try {
      const raw = localStorage.getItem('yaojuan_settings') || localStorage.getItem('comfort_reader_settings');
      if (raw) {
        state.settings = Object.assign(state.settings, JSON.parse(raw));
      }
    } catch (e) {}
  }

  function applySettings() {
    setTheme(state.settings.theme);
    setFontSize(state.settings.fontSize);
    setLineHeight(state.settings.lineHeight);
    setContentWidth(state.settings.contentWidth);
    setFontFamily(state.settings.fontFamily);
  }

  // ==========================================
  // 13. 键盘快捷键 (翻页与翻章智能联动)
  // ==========================================
  function initKeyboardShortcuts() {
    window.addEventListener('keydown', (e) => {
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;

      switch (e.key) {
        case 'PageDown':
        case ' ': {
          e.preventDefault();
          const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
          if (window.scrollY >= maxScroll - 30) {
            nextChapter();
          } else {
            window.scrollBy({ top: window.innerHeight * 0.8, behavior: 'smooth' });
          }
          break;
        }
        case 'PageUp': {
          e.preventDefault();
          if (window.scrollY <= 30) {
            prevChapter();
          } else {
            window.scrollBy({ top: -window.innerHeight * 0.8, behavior: 'smooth' });
          }
          break;
        }
        case 'ArrowRight':
          e.preventDefault();
          nextChapter();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          prevChapter();
          break;
        case 'j':
        case 'J':
          window.scrollBy({ top: 120, behavior: 'smooth' });
          break;
        case 'k':
        case 'K':
          window.scrollBy({ top: -120, behavior: 'smooth' });
          break;
        case 'b':
        case 'B':
          el.sidebar.classList.toggle('open');
          break;
        case 's':
        case 'S':
          e.preventDefault();
          el.btnSearch.click();
          break;
        case 't':
        case 'T':
          cycleTheme();
          break;
        case 'f':
        case 'F':
          toggleFullscreen();
          break;
        case 'Escape':
          el.sidebar.classList.remove('open');
          el.remoteModal.classList.remove('open');
          el.settingsModal.classList.remove('open');
          break;
        default:
          break;
      }
    });
  }

  // 辅助函数
  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function fallbackCopyText(text, callback) {
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      const successful = document.execCommand('copy');
      document.body.removeChild(textarea);
      if (successful) {
        if (callback) callback();
      } else {
        prompt('自动复制失败，请按 Ctrl+C 手动复制链接：', text);
      }
    } catch (e) {
      prompt('请按 Ctrl+C 手动复制链接：', text);
    }
  }

  window.addEventListener('DOMContentLoaded', init);
})();
