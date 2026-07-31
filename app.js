// ========== Mastery 三态（必须在 state 之前定义，否则 TDZ） ==========
// 'none' → 'partial' → 'mastered' → 'none' → ...
const MASTERY_STATES = ['none', 'partial', 'mastered'];
const MASTERY_META = {
  none:     { label: '⚪ 未掌握',  cls: '' },
  partial:  { label: '🟡 大致掌握', cls: 'partial' },
  mastered: { label: '🟢 完全掌握', cls: 'mastered' },
};

// ========== Utils（function 声明会自动 hoist，但 const 不行） ==========
function loadJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); }
  catch { return fallback; }
}
function saveJSON(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}
function migrateSeen(seen) {
  // 兼容老数据 { mastered: true/false } → 新格式 { mastery: 'none'/'partial'/'mastered' }
  const out = {};
  for (const w in seen) {
    const e = seen[w] || {};
    if (e.mastery && MASTERY_META[e.mastery]) {
      out[w] = e;
    } else if (e.mastered === true) {
      out[w] = { count: e.count || 0, mastery: 'mastered', masteredAt: e.masteredAt };
    } else {
      out[w] = { count: e.count || 0, mastery: 'none' };
    }
  }
  return out;
}

// ========== State ==========
const state = {
  words: [],
  fuse: null,
  letters: [],
  currentLetter: null,
  currentWord: null,
  searchTimer: null,
  fuseReady: false,
  view: 'list',            // 'list' | 'detail'
  // 学习数据
  favorites: loadJSON("cet4_favorites", []),                  // 单词本
  seen: migrateSeen(loadJSON("cet4_seen", {})),              // { w: { count, mastery } }
  // 学习会话（运行时；持久化在 cet4_session）
  session: null,            // { words:[w,..], idx, current, editedMastery }
  // 单词本页当前过滤的 mastery 分区（'none' | 'partial' | 'mastered'）
  vocabFilter: 'none',
};

function nextMastery(w) {
  const cur = state.seen[w]?.mastery || 'none';
  const idx = MASTERY_STATES.indexOf(cur);
  return MASTERY_STATES[(idx + 1) % 3];
}

// ========== Utils ==========
const $ = (id) => document.getElementById(id);
const escapeHTML = (s) => (s == null ? "" : String(s)).replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[c]));
const debounce = (fn, ms = 100) => {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
};

function isMobile() { return window.matchMedia("(max-width: 880px)").matches; }

// ========== Init ==========
function init() {
  state.words = (window.CET4_WORDS || []).map(normalize);
  if (!state.words.length) {
    $("stats").innerHTML = `❌ 词表加载失败<br/><small style="color:#a0a4b8">请检查 data.js 是否与 index.html 同目录</small>`;
    $("apiStatus").textContent = "● data.js 缺失";
    $("apiStatus").className = "err";
    return;
  }

  const letterSet = new Set(state.words.map((w) => w.w[0]));
  state.letters = [...letterSet].sort();
  const letterCounts = {};
  state.letters.forEach((l) => { letterCounts[l] = state.words.filter((w) => w.w[0] === l).length; });

  try {
    if (typeof Fuse === "undefined") throw new Error("Fuse 未定义");
    state.fuse = new Fuse(state.words, {
      keys: [
        { name: "w", weight: 0.7 },
        { name: "cnJoined", weight: 0.3 },
      ],
      threshold: 0.4,
      ignoreLocation: true,
      includeScore: true,
      minMatchCharLength: 1,
    });
    state.fuseReady = true;
  } catch (e) {
    console.error("Fuse 初始化失败：", e);
    $("apiStatus").textContent = "● 模糊搜索不可用";
    $("apiStatus").className = "err";
  }

  updateStats();
  refreshVocabCount();

  if (state.fuseReady) {
    $("apiStatus").textContent = "● 离线就绪";
    $("apiStatus").className = "ok";
  }

  renderAlphabet(letterCounts);
  renderFavBar();
  bindEvents();

  // 根据初始 hash 决定显示：#vocabulary / #word=xxx / 默认
  routeFromHash();

  // 默认：永远显示空白主页（不自动选第一个词）
  if (!getHashParts().word && !getHashParts().view) {
    renderEmptyState();
  }
}

function updateStats() {
  const masteredCount = Object.values(state.seen).filter(e => e.mastery === 'mastered').length;
  const partialCount = Object.values(state.seen).filter(e => e.mastery === 'partial').length;
  $("stats").textContent = `词表 ${state.words.length} 词 · 单词本 ${state.favorites.length} · 已掌握 ${masteredCount}/${state.favorites.length || 0}`;
}

function normalize(w) {
  return { ...w, cnJoined: (w.cn || []).join(" ") };
}

// ========== Hash 路由 ==========
function getHashParts() {
  const h = location.hash;
  if (h.startsWith("#vocabulary")) return { view: "vocabulary" };
  if (h.startsWith("#study-done")) return { view: "study-done" };
  if (h.startsWith("#study-word=")) {
    const m = h.match(/^#study-word=(.+)$/);
    if (m) return { view: "study-word", word: decodeURIComponent(m[1]).toLowerCase() };
    return {};
  }
  if (h.startsWith("#study")) return { view: "study" };
  const m = h.match(/^#word=(.+)$/);
  if (m) return { view: "word", word: decodeURIComponent(m[1]).toLowerCase() };
  return {};
}

function setHashStudyWord(w) {
  const newHash = `#study-word=${encodeURIComponent(w)}`;
  if (location.hash !== newHash) location.hash = newHash;
}

function setHashView(view) {
  if (location.hash !== `#${view}`) location.hash = `#${view}`;
}

function setHashWord(w) {
  const newHash = `#word=${encodeURIComponent(w)}`;
  if (location.hash !== newHash) location.hash = newHash;
}

function clearHash() {
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  // 注意：replaceState 不触发 hashchange，需要调用方自行处理 UI 切换
}

function routeFromHash() {
  const parts = getHashParts();

  // 单词本视图
  if (parts.view === "vocabulary") {
    showVocabPage();
    return;
  }

  // 学习完成视图
  if (parts.view === "study-done") {
    showStudyDone();
    return;
  }

  // 学习卡片视图
  if (parts.view === "study") {
    // 若有未完成的 session 就恢复，否则回到主页
    const persisted = loadJSON("cet4_session", null);
    if (persisted && persisted.words && persisted.words.length) {
      state.session = persisted;
      // sessionDone 不持久化，从 0 重新统计（足够近似）
      if (!state.sessionDone) {
        state.sessionDone = {
          total: persisted.words.length,
          added: 0,
          mastered: 0,
        };
      }
      showStudyPage();
    } else {
      // 没会话可恢复，回到主页（hash 自动清掉）
      clearHash();
      showHome();
    }
    return;
  }

  // 学习中查看单词详情（独立二级页面）
  if (parts.view === "study-word") {
    if (!state.session || !parts.word) {
      // 没 session 就回到主页
      clearHash();
      showHome();
      return;
    }
    const entry = state.words.find((e) => e.w === parts.word);
    if (entry) {
      showStudyDetailPage(entry);
    } else {
      // 词无效，回到学习页
      setHashView("study");
    }
    return;
  }

  // 默认主页视图
  showHome();

  if (parts.word) {
    const entry = state.words.find((e) => e.w === parts.word);
    if (entry) {
      renderDetail(entry);
      state.currentWord = entry;
      // 同步列表高亮
      document.querySelectorAll(".result-item").forEach((el) => {
        el.classList.toggle("active", el.querySelector(".w")?.textContent === entry.w);
      });
      // 移动端：从 hash 进入单词详情时，切换到详情视图
      if (isMobile()) {
        $("mainGrid").classList.add("view-detail");
        state.view = 'detail';
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    }
  }
}

function showHome() {
  $("vocabPage").style.display = "none";
  $("studyPage").style.display = "none";
  $("studyDonePage").style.display = "none";
  $("studyDetailPage").style.display = "none";
  document.querySelector(".container > .search-section").style.display = "";
  document.querySelector(".container > .alphabet").style.display = "";
  $("favBar").style.display = "";
  $("mainGrid").style.display = "";
  $("vocabBtn").classList.remove("active");
  // 清空搜索框
  const searchInput = $("searchInput");
  if (searchInput) searchInput.value = "";
  $("searchHint").textContent = "提示：支持中英释义反查、拼写容错 · 收藏用 ★";
  // 清空字母索引高亮
  document.querySelectorAll(".alphabet button").forEach((b) => b.classList.remove("active"));
  // 清空当前选字母 + 当前词 + 主列表
  state.currentLetter = null;
  state.currentWord = null;
  state.view = 'list';
  $("mainGrid").classList.remove("view-detail");
  // 渲染空状态（左侧 CTA + 右侧引导）
  renderEmptyState();
  $("detailContent").innerHTML = `<div class="empty-tip">👈 在左侧选中一个词查看详情</div>`;
  window.scrollTo({ top: 0, behavior: "auto" });
}

function showVocabPage() {
  $("vocabPage").style.display = "block";
  $("studyPage").style.display = "none";
  $("studyDonePage").style.display = "none";
  $("studyDetailPage").style.display = "none";
  document.querySelector(".container > .search-section").style.display = "none";
  document.querySelector(".container > .alphabet").style.display = "none";
  $("favBar").style.display = "none";
  $("mainGrid").style.display = "none";
  $("vocabBtn").classList.add("active");
  renderVocabularyPage();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ========== 全局函数（HTML 内 onclick 调用） ==========
window.goBackToList = function() {
  // 优先用 history.back() 退回上一级（保持次级页面上下文，如 #study → #word=xxx → back 回到 #study）
  if (history.length > 1 && location.hash.startsWith("#word=")) {
    history.back();
    return;
  }
  // fallback：直接清 hash 回主页
  clearHash();
  state.view = 'list';
  $("mainGrid").classList.remove("view-detail");
  if (isMobile()) window.scrollTo({ top: 0, behavior: "smooth" });
};

window.goVocabulary = function() {
  if (getHashParts().view === "vocabulary") return;
  setHashView("vocabulary");
};

window.goHome = function() {
  clearHash();
  showHome();  // 修复：clearHash 用 replaceState 不触发 hashchange，需手动切 UI
};

// 从详情页返回学习页继续背单词
window.backToStudy = function() {
  if (!state.session) {
    // session 已结束，回到主页
    clearHash();
    showHome();
    return;
  }
  setHashView("study");
};

// ========== 学习功能 ==========
window.goStudy = function() {
  // 弹窗询问数量
  const persisted = loadJSON("cet4_session", null);
  if (persisted && persisted.words && persisted.words.length > 0) {
    // 有未完成的会话，询问继续还是重新开始
    showResumeModal(persisted);
  } else {
    showAskNModal();
  }
};

function showAskNModal() {
  $("askNInput").value = 10;
  $("askNModal").style.display = "flex";
  setTimeout(() => $("askNInput").focus(), 50);
}
window.cancelAskN = function() {
  $("askNModal").style.display = "none";
};
window.confirmAskN = function() {
  const n = parseInt($("askNInput").value, 10);
  if (!n || n < 1) { flash("请输入大于 0 的数量"); return; }
  $("askNModal").style.display = "none";
  startSession(n);
};

function showResumeModal(persisted) {
  const remaining = persisted.words.length - (persisted.idx || 0);
  const mask = document.createElement("div");
  mask.className = "modal-mask";
  mask.style.display = "flex";
  mask.innerHTML = `
    <div class="modal-box">
      <h3>🎯 有未完成的学习</h3>
      <p>上次学了 ${persisted.idx || 0} 个，还剩 ${remaining} 个。从中断处继续？</p>
      <div class="modal-actions">
        <button class="modal-btn cancel" data-act="new">重新开始</button>
        <button class="modal-btn primary" data-act="resume">继续上次</button>
      </div>
    </div>`;
  document.body.appendChild(mask);
  mask.addEventListener("click", (e) => {
    if (e.target.dataset.act === "new") {
      saveJSON("cet4_session", null);
      mask.remove();
      showAskNModal();
    } else if (e.target.dataset.act === "resume") {
      mask.remove();
      state.session = persisted;
      setHashView("study");
    } else if (e.target === mask) {
      mask.remove();
    }
  });
}

// 选词算法（核心）
function pickSession(N) {
  const unknown = [], partial = [], mastered = [];
  for (const w of state.words) {
    const m = state.seen[w.w]?.mastery || 'none';
    if (m === 'mastered') mastered.push(w.w);
    else if (m === 'partial') partial.push(w.w);
    else unknown.push(w.w);
  }
  // 随机洗牌 helper
  const shuffle = (arr) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const T = Math.ceil(N / 2);
  let pickUnknown = shuffle(unknown);
  let pickPartial = shuffle(partial);
  let pickMastered = shuffle(mastered);
  let result = [];
  if (pickPartial.length >= T) {
    // 50/50
    const nu = Math.floor(N / 2);
    const np = N - nu;
    result = pickUnknown.slice(0, nu).concat(pickPartial.slice(0, np));
  } else {
    // 全抽 unknown
    result = pickUnknown.slice(0, N);
  }
  // 不够则从 mastered 凑
  if (result.length < N) {
    const need = N - result.length;
    result = result.concat(pickMastered.slice(0, need));
  }
  // 仍然不够（理论上不可能）：返回能拿到的
  return shuffle(result);
}

function startSession(N) {
  const words = pickSession(N);
  if (words.length === 0) {
    flash("⚠️ 词表为空，无法开始");
    return;
  }
  state.session = {
    startedAt: Date.now(),
    words,
    idx: 0,
    current: words[0],
    editedMastery: null,        // 用户本会话内手动改过的状态
    initialMastery: state.seen[words[0]]?.mastery || 'none',
    initialFav: state.favorites.includes(words[0]),
  };
  // 初始化本次统计
  state.sessionDone = {
    total: words.length,
    added: 0,
    mastered: 0,
  };
  // 持久化（这样即使刷新/中断也能恢复）
  saveJSON("cet4_session", state.session);
  // 进入学习视图
  setHashView("study");
  // 实际渲染由 routeFromHash 处理
}

function showStudyPage() {
  if (!state.session) return;
  $("studyPage").style.display = "flex";
  $("studyDonePage").style.display = "none";
  $("vocabPage").style.display = "none";
  $("studyDetailPage").style.display = "none";
  document.querySelector(".container > .search-section").style.display = "none";
  document.querySelector(".container > .alphabet").style.display = "none";
  $("favBar").style.display = "none";
  $("mainGrid").style.display = "none";
  $("vocabBtn").classList.remove("active");
  renderStudyCard();
  window.scrollTo({ top: 0, behavior: "auto" });
}

// 学习中的单词详情（独立二级页面，与主页的 #word=xxx 详情不共用）
function showStudyDetailPage(word) {
  if (!state.session) return;
  $("studyPage").style.display = "none";
  $("studyDonePage").style.display = "none";
  $("vocabPage").style.display = "none";
  $("studyDetailPage").style.display = "block";
  document.querySelector(".container > .search-section").style.display = "none";
  document.querySelector(".container > .alphabet").style.display = "none";
  $("favBar").style.display = "none";
  $("mainGrid").style.display = "none";
  $("vocabBtn").classList.remove("active");
  renderStudyDetailContent(word);
  window.scrollTo({ top: 0, behavior: "auto" });
}

// 渲染学习详情内容（复用主页详情结构，但容器不同）
function renderStudyDetailContent(word) {
  const panel = $("studyDetailContent");
  if (!panel) return;
  panel.innerHTML = buildDetailHTML(word);
  state.currentWord = word;
  // 同步统计 + 顶栏 favorites 计数等
  updateStats();
  refreshFavBar();
  refreshVocabCount();
  // 注意：studyDetailContent 里的 favBtn / masteryBtn 也要同步显示状态
  updateFavBtn(word.w);
  updateMasteryBtn(word.w);
}

function renderStudyCard() {
  const s = state.session;
  if (!s) return;
  const w = s.current;
  const total = s.words.length;
  const done = s.idx;  // 已完成数（当前是第 idx+1 个，0-indexed）
  $("studyProgress").textContent = `${done + 1} / ${total}`;
  const pct = ((done + 1) / total) * 100;
  $("studyBarFill").style.width = `${pct}%`;
  $("studyWord").textContent = w;
  // 当前 mastery：edited 优先，否则初始
  const cur = s.editedMastery || s.initialMastery || 'none';
  document.querySelectorAll(".study-m-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.target === cur);
  });
  // 第一个词时禁用「上一个」
  const prevBtn = $("studyPrev");
  if (prevBtn) prevBtn.disabled = (s.idx === 0);
  $("studyHint").textContent = "💡 选掌握程度后自动进入下一个，可用「上一个」回退";
}

// 直接设置 mastery（点对应按钮触发，自动 commit + 推进）
window.setStudyMastery = function(target) {
  const s = state.session;
  if (!s) return;
  if (!["none", "partial", "mastered"].includes(target)) return;
  // 已选过相同状态：什么都不做（避免重复 commit）
  if (s.editedMastery === target) return;
  s.editedMastery = target;
  // 自动 commit + 推进到下一个（最后一张选完会跳完成页）
  nextWord();
};

window.studyViewDetail = function() {
  if (!state.session) return;
  // 跳到 #study-word=xxx 独立路由，区别于主页的 #word=xxx
  setHashStudyWord(state.session.current);
};

window.nextWord = function() {
  const s = state.session;
  if (!s) return;
  // 应用本词的副作用
  commitCurrentWord();
  // 推进
  s.idx = (s.idx || 0) + 1;
  if (s.idx >= s.words.length) {
    // 完成
    finishSession();
    return;
  }
  // 设置下一个词
  s.current = s.words[s.idx];
  s.editedMastery = null;
  s.initialMastery = state.seen[s.current]?.mastery || 'none';
  s.initialFav = state.favorites.includes(s.current);
  saveJSON("cet4_session", s);
  renderStudyCard();
};

// 回退到上一个词（不 commit，已 commit 的词保持原样）
window.prevWord = function() {
  const s = state.session;
  if (!s) return;
  if ((s.idx || 0) === 0) return;  // 第一个词，无法再退
  // 注意：当前词可能已被 setStudyMastery 自动 commit 过一次（如果用户点过按钮再回退）
  // 回退只是 UI 导航，不撤销 commit；用户回退后可以重选 mastery 再次 commit
  s.idx -= 1;
  s.current = s.words[s.idx];
  s.editedMastery = null;  // 让用户重新选
  s.initialMastery = state.seen[s.current]?.mastery || 'none';
  s.initialFav = state.favorites.includes(s.current);
  saveJSON("cet4_session", s);
  renderStudyCard();
};

function commitCurrentWord() {
  const s = state.session;
  if (!s) return;
  const w = s.current;
  // 1. 加入单词本（若不在）+ 统计
  if (!state.favorites.includes(w)) {
    state.favorites.push(w);
    saveJSON("cet4_favorites", state.favorites);
    if (state.sessionDone) state.sessionDone.added += 1;
  }
  // 2. mastery：用户改过 → 用用户的；未改 → 默认 partial
  const finalMastery = s.editedMastery || 'partial';
  const prev = state.seen[w] || { count: 0 };
  state.seen[w] = {
    count: (prev.count || 0) + 1,
    mastery: finalMastery,
    masteryAt: Date.now(),
  };
  saveJSON("cet4_seen", state.seen);
  // 3. 统计：本次设为 mastered 多少
  if (finalMastery === 'mastered' && prev.mastery !== 'mastered' && state.sessionDone) {
    state.sessionDone.mastered += 1;
  }
}

function finishSession() {
  // 完成：清 session，进入完成页
  state.session = null;
  saveJSON("cet4_session", null);
  setHashView("study-done");
}

function showStudyDone() {
  // 统计：本次背了几个、加入单词本几个、掌握多少
  // 数据从 state.session 在 finishSession 之前已 commit 到 seen/favorites
  // 但要看本次具体几个，需要在 finishSession 时记录
  // 简化：直接用当前 seen/favorites 增量（或存到 doneStats）
  $("studyPage").style.display = "none";
  $("vocabPage").style.display = "none";
  $("studyDetailPage").style.display = "none";
  $("studyDonePage").style.display = "block";
  document.querySelector(".container > .search-section").style.display = "none";
  document.querySelector(".container > .alphabet").style.display = "none";
  $("favBar").style.display = "none";
  $("mainGrid").style.display = "none";
  $("vocabBtn").classList.remove("active");
  renderDoneStats();
  window.scrollTo({ top: 0, behavior: "auto" });
}

// 渲染完成页统计
function renderDoneStats() {
  const total = state.sessionDone?.total || 0;
  const added = state.sessionDone?.added || 0;
  const mastered = state.sessionDone?.mastered || 0;
  const html = `
    <div class="done-stat">
      <span class="num">${total}</span>
      <span class="lbl">本次学习</span>
    </div>
    <div class="done-stat">
      <span class="num">${added}</span>
      <span class="lbl">新增入单词本</span>
    </div>
    <div class="done-stat">
      <span class="num">${mastered}</span>
      <span class="lbl">设为完全掌握</span>
    </div>`;
  $("doneStats").innerHTML = html;
}

// ========== 退出流程 ==========
window.quitSession = function() {
  if (!state.session) return;
  const s = state.session;
  const remaining = s.words.length - s.idx;
  $("quitHint").textContent = `已完成 ${s.idx} 个，还剩 ${remaining} 个。选择怎么处理本次进度：`;
  $("quitModal").style.display = "flex";
};
window.cancelQuit = function() {
  $("quitModal").style.display = "none";
};
window.quitSave = function() {
  // 保存当前进度，session 已经在每次 nextWord 都持久化了
  $("quitModal").style.display = "none";
  state.session = null;
  saveJSON("cet4_session", null);
  flash("💾 已保存进度，下次进入继续");
  clearHash();
  showHome();  // 修复：clearHash 用 replaceState 不触发 hashchange，需手动切 UI
};
window.quitDiscard = function() {
  // 放弃：清 session；但已经 commit 的词保留（单词本/掌握状态不变）
  $("quitModal").style.display = "none";
  state.session = null;
  saveJSON("cet4_session", null);
  flash("🗑 已放弃本次，已学过的词保留");
  clearHash();
  showHome();
};

// ========== Alphabet Bar ==========
function renderAlphabet(counts) {
  const bar = $("alphabet");
  bar.innerHTML = "";
  const allBtn = document.createElement("button");
  allBtn.textContent = "ALL";
  allBtn.dataset.letter = "#";
  allBtn.onclick = () => onLetterClick("#");
  bar.appendChild(allBtn);

  "abcdefghijklmnopqrstuvwxyz".split("").forEach((l) => {
    const btn = document.createElement("button");
    btn.dataset.letter = l;
    if (counts[l]) {
      btn.innerHTML = `${l.toUpperCase()}<span class="count">${counts[l]}</span>`;
      btn.onclick = () => onLetterClick(l);
    } else {
      btn.textContent = l.toUpperCase();
      btn.classList.add("disabled");
      btn.disabled = true;
    }
    bar.appendChild(btn);
  });
}

function onLetterClick(letter) {
  // 同步退出详情视图（不调用 goBackToList，避免 smooth scroll 与 renderList 抢资源）
  if (state.view === 'detail') {
    state.view = 'list';
    $("mainGrid").classList.remove("view-detail");
  }
  // 同步清掉 hash（避免 #word=xxx 与列表状态不一致）
  if (location.hash) {
    history.replaceState(null, "", location.pathname + location.search);
  }
  // 同步滚到顶部（用 auto 而非 smooth，避免异步）
  window.scrollTo({ top: 0, behavior: "auto" });

  document.querySelectorAll(".alphabet button").forEach((b) => b.classList.remove("active"));
  const btn = document.querySelector(`.alphabet button[data-letter="${letter}"]`);
  if (btn) btn.classList.add("active");
  state.currentLetter = letter;

  if (letter === "#") {
    $("searchInput").value = "";
    renderList(state.words.slice(0, 200).map((w, i) => ({ word: w, score: 0, match: "letter", rank: i })));
    $("searchHint").textContent = `全部字母 · ${state.words.length} 词（展示前 200）`;
    return;
  }
  const words = state.words.filter((w) => w.w[0] === letter);
  renderList(words.map((w, i) => ({ word: w, score: 0, match: "letter", rank: i })));
  $("searchHint").textContent = `字母 ${letter.toUpperCase()} · ${words.length} 词`;
}

// ========== Search ==========
// 用户点击"搜索"按钮 或 在输入框按 Enter 时才真正触发搜索
// 输入框 onInput 现在只用于移动端退出详情视图，不直接触发搜索
const onInput = debounce(() => {
  // 输入新查询时，如果当前在详情视图（移动端），先自动退出详情回到列表
  if (state.view === 'detail') {
    state.view = 'list';
    $("mainGrid").classList.remove("view-detail");
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  }
}, 80);

// 用户点击"搜索"按钮 或 按 Enter 时触发
function runSearch() {
  if (state.view === 'detail') {
    state.view = 'list';
    $("mainGrid").classList.remove("view-detail");
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  }
  const q = $("searchInput").value.trim();
  if (q) {
    document.querySelectorAll(".alphabet button").forEach((b) => b.classList.remove("active"));
    state.currentLetter = null;
  }
  doSearch(q);
}

function renderEmptyState() {
  // 主页空状态：显示"开始背单词"大按钮
  $("resultList").innerHTML = `
    <div class="empty-cta">
      <button class="big-btn" onclick="goStudy()">🎯 开始背单词</button>
      <div class="tip">或在搜索框输入单词 / 中文释义 / 拼写片段</div>
    </div>`;
}

function doSearch(q) {
  if (!q) {
    $("searchHint").textContent = "提示：支持中英释义反查、拼写容错 · 收藏用 ★";
    renderEmptyState();
    return;
  }
  const t0 = performance.now();
  let fuseResults = [];
  if (state.fuseReady) {
    fuseResults = state.fuse.search(q).slice(0, 30);
  }
  const hits = fuseResults.map((r) => ({
    word: r.item,
    score: Math.round((1 - r.score) * 100),
    match: r.matches && r.matches[0]?.key === "cnJoined" ? "释义" : "模糊",
  }));

  if (!hits.length) {
    $("resultList").innerHTML = `<div class="empty-tip">没有找到匹配的词 😢<br/><small>试试相近拼写或中文释义</small></div>`;
    $("searchHint").textContent = `0 个结果 · ${(performance.now() - t0).toFixed(1)}ms`;
    return;
  }
  renderList(hits);
  $("searchHint").textContent = `${hits.length} 个结果 · ${(performance.now() - t0).toFixed(1)}ms`;
  // 不再自动跳到详情；让用户点击列表项再进入
  // 但搜索完后清掉详情面板的旧内容，避免看到上次浏览的词
  $("detailContent").innerHTML = `<div class="empty-tip">👈 在左侧结果中选择一个词查看详情</div>`;
  state.currentWord = null;
}

function masteryBadge(w) {
  const m = state.seen[w]?.mastery || 'none';
  if (m === 'none') return "";
  const meta = MASTERY_META[m];
  return `<span class="badge mastery ${meta.cls}">${meta.label.replace(/^[^ ]+ /, '')}</span>`;
}

function renderList(hits) {
  const list = $("resultList");
  list.innerHTML = "";
  hits.forEach((h) => {
    const div = document.createElement("div");
    div.className = "result-item";
    if (state.currentWord && state.currentWord.w === h.word.w) div.classList.add("active");
    const cn = (h.word.cn || []).join("；") || h.word.en || "(无释义)";
    const badge = h.match || "字母";
    const favTag = state.favorites.includes(h.word.w) ? '<span class="badge fav">★</span>' : "";
    const masTag = masteryBadge(h.word.w);
    div.innerHTML = `
      <div class="left">
        <div class="w">${escapeHTML(h.word.w)}</div>
        <div class="cn">${escapeHTML(cn)}</div>
      </div>
      <div class="badges">
        ${favTag}${masTag}<span class="badge">${escapeHTML(badge)}</span>
      </div>
    `;
    div.onclick = () => {
      document.querySelectorAll(".result-item").forEach((el) => el.classList.remove("active"));
      div.classList.add("active");
      showDetail(h.word, { autoNav: true });
    };
    list.appendChild(div);
  });
}

// ========== Detail Panel ==========
function showDetail(word, opts = {}) {
  state.currentWord = word;
  // 标记为已学（递增计数）
  const ts = Date.now();
  const cur = state.seen[word.w] || { count: 0, mastery: 'none' };
  state.seen[word.w] = { ts, count: (cur.count || 0) + 1, mastery: cur.mastery || 'none' };
  saveJSON("cet4_seen", state.seen);

  // 同步列表高亮（如果有列表）
  document.querySelectorAll(".result-item").forEach((el) => {
    el.classList.toggle("active", el.querySelector(".w")?.textContent === word.w);
  });

  renderDetail(word);

  // 移动端自动跳转：更新 hash 触发 view 切换
  if (isMobile() && opts.autoNav) {
    setHashWord(word.w);
  }

  updateFavBtn(word.w);
  updateMasteryBtn(word.w);
  refreshFavBar();
  updateStats();
}

function renderDetail(word) {
  $("detailContent").innerHTML = buildDetailHTML(word);
}

// 抽出的详情 HTML 构建（主页详情 & 学习详情页都复用）
function buildDetailHTML(word) {
  const posTag = (pos) => `<span class="pos-tag">${escapeHTML(pos)}</span>`;
  const cnBlock = (cn) => `<div>${escapeHTML(cn)}</div>`;

  let posHTML = "";
  if (Array.isArray(word.pos) && word.pos.length && Array.isArray(word.cn) && word.cn.length === word.pos.length) {
    posHTML = `<div class="pos-list">` + word.pos.map((p, i) =>
      `<div class="pos">${posTag(p)}<div class="cn-list">${cnBlock(word.cn[i])}</div></div>`
    ).join("") + `</div>`;
  } else if (Array.isArray(word.cn) && word.cn.length) {
    posHTML = `<div class="pos-list"><div class="pos"><div class="cn-list">${
      word.cn.map(cnBlock).join("")
    }</div></div></div>`;
  } else {
    posHTML = `<div class="empty-tip">暂无中文释义</div>`;
  }

  const enDef = word.en ? `<div class="en-def">📘 ${escapeHTML(word.en)}</div>` : "";
  const examples = (word.ex && word.ex.length) ? `
    <div class="examples">
      <h4>EXAMPLES</h4>
      ${word.ex.map(e => `<div class="ex">${escapeHTML(e)}</div>`).join("")}
    </div>` : "";

  const seenCount = state.seen[word.w]?.count || 0;
  const mastery = state.seen[word.w]?.mastery || 'none';
  const masteryMeta = MASTERY_META[mastery];

  return `
    <div class="head">
      <div class="word">${escapeHTML(word.w)}</div>
      ${word.p ? `<div class="phonetic">${escapeHTML(word.p)}</div>` : ""}
      <div class="actions">
        <button class="icon-btn" id="favBtn" onclick="toggleFav('${escapeHTML(word.w)}')">${state.favorites.includes(word.w) ? '★ 已加入' : '☆ 加入单词本'}</button>
        <button class="icon-btn mastery-btn ${masteryMeta.cls}" id="masteryBtn" onclick="cycleMastery('${escapeHTML(word.w)}')" title="点击切换：未掌握 → 大致掌握 → 完全掌握">${masteryMeta.label}</button>
        <button class="icon-btn" onclick="speakWord('${escapeHTML(word.w)}')">🔊 发音</button>
      </div>
    </div>
    ${posHTML}
    ${enDef}
    ${examples}
    <div class="meta">已查看 ${seenCount} 次 · 学习进度已自动记录到本地</div>
  `;
}

// ========== Favorites / 单词本 ==========
function toggleFav(w) {
  const i = state.favorites.indexOf(w);
  if (i >= 0) state.favorites.splice(i, 1);
  else state.favorites.push(w);
  saveJSON("cet4_favorites", state.favorites);
  updateFavBtn(w);
  refreshFavBar();
  refreshVocabCount();
  updateStats();
  if (state.currentWord?.w === w) renderList(currentListSnapshot());
  // 如果在单词本页面，也要刷新
  if (getHashParts().view === "vocabulary") renderVocabularyPage();
}

function updateFavBtn(w) {
  const btn = $("favBtn");
  if (!btn) return;
  const fav = state.favorites.includes(w);
  btn.textContent = fav ? "★ 已加入" : "☆ 加入单词本";
  btn.classList.toggle("active", fav);
}

function refreshVocabCount() {
  const el = $("vocabCount");
  if (el) el.textContent = state.favorites.length;
}

function renderFavBar() { refreshFavBar(); }

function refreshFavBar() {
  const bar = $("favBar");
  if (!bar) return;
  if (!state.favorites.length) {
    bar.innerHTML = `<span class="fav-empty">还没有加入单词本的词 ☆ · 点击 <strong>📖 单词本</strong> 查看全部</span>`;
    return;
  }
  bar.innerHTML = state.favorites.slice(0, 30).map((w) => {
    const entry = state.words.find((e) => e.w === w);
    const cn = entry ? ((entry.cn || [])[0] || "") : "";
    return `<button class="fav-chip" data-w="${escapeHTML(w)}" title="${escapeHTML(cn)}">${escapeHTML(w)}</button>`;
  }).join("") + (state.favorites.length > 30 ? `<span class="fav-more">…共 ${state.favorites.length} 个</span>` : "");
  bar.querySelectorAll(".fav-chip").forEach((b) => {
    b.onclick = () => {
      const w = b.dataset.w;
      const entry = state.words.find((e) => e.w === w);
      if (entry) showDetail(entry, { autoNav: true });
    };
  });
}

// ========== 单词本独立页面 ==========

// 按 mastery 过滤单词本（返回该分区的词数组）
function filterFavoritesByMastery(filter) {
  return state.favorites.filter((w) => {
    const m = state.seen[w]?.mastery || 'none';
    return m === filter;
  });
}

// 设置当前 tab 并重新渲染列表
window.setVocabFilter = function(filter) {
  if (!["none", "partial", "mastered"].includes(filter)) return;
  state.vocabFilter = filter;
  renderVocabularyPage();
  // 切到空 tab 时给个轻提示
  const visible = filterFavoritesByMastery(filter);
  if (visible.length === 0 && state.favorites.length > 0) {
    flash(`${MASTERY_META[filter].label} 暂无`);
  }
};

function renderVocabularyPage() {
  const list = $("vocabList");
  if (!list) return;

  // 顶部统计
  const stats = $("vocabStats");
  const mastered = filterFavoritesByMastery("mastered").length;
  const partial = filterFavoritesByMastery("partial").length;
  const none = filterFavoritesByMastery("none").length;
  const total = state.favorites.length;
  if (stats) {
    stats.innerHTML = `共 <strong>${total}</strong> 词 · 未掌握 ${none} · 大致掌握 ${partial} · 完全掌握 ${mastered}`;
  }

  // 更新 tab 上的计数
  const setCnt = (id, n) => { const el = $(id); if (el) el.textContent = n; };
  setCnt("vocabCountNone", none);
  setCnt("vocabCountPartial", partial);
  setCnt("vocabCountMastered", mastered);

  // 更新 tab 的 active 状态
  document.querySelectorAll(".vocab-tab").forEach((b) => {
    b.classList.toggle("active", b.dataset.filter === state.vocabFilter);
  });

  // 空状态
  if (!total) {
    list.innerHTML = `<div class="empty-tip">单词本还是空的。<br/>去主页搜索词，点击 <strong>☆ 加入单词本</strong> 收藏吧 ✨</div>`;
    return;
  }

  // 按当前 filter 筛选
  const filtered = filterFavoritesByMastery(state.vocabFilter);
  if (!filtered.length) {
    const meta = MASTERY_META[state.vocabFilter];
    list.innerHTML = `<div class="empty-tip">${meta.label} 区暂无单词<br/><small>其他区有词，先去切换</small></div>`;
    return;
  }

  list.innerHTML = filtered.map((w) => {
    const entry = state.words.find((e) => e.w === w);
    if (!entry) return "";
    const cn = (entry.cn || []).join("；") || entry.en || "(无释义)";
    const mastery = state.seen[w]?.mastery || 'none';
    const meta = MASTERY_META[mastery];
    return `
      <div class="vocab-item" data-w="${escapeHTML(w)}">
        <div class="vocab-item-main" data-action="detail">
          <div class="vocab-w">
            ${escapeHTML(entry.w)}
            ${entry.p ? `<span class="vocab-phonetic">${escapeHTML(entry.p)}</span>` : ''}
          </div>
          <div class="vocab-cn">${escapeHTML(cn)}</div>
        </div>
        <div class="vocab-item-actions">
          <button class="vocab-ms-btn ${meta.cls}" data-action="mastery">${meta.label}</button>
          <button class="vocab-remove-btn" data-action="remove" title="从单词本移除">✕</button>
        </div>
      </div>
    `;
  }).join("");

  // 绑定事件
  list.querySelectorAll(".vocab-item").forEach((el) => {
    const w = el.dataset.w;
    const entry = state.words.find((e) => e.w === w);
    el.querySelector('[data-action="detail"]').onclick = () => {
      if (entry) {
        setHashWord(w);
        // 触发 detail 视图（不留在单词本页）
        showHome();
        showDetail(entry, { autoNav: false });
        if (isMobile()) {
          $("mainGrid").classList.add("view-detail");
        }
      }
    };
    el.querySelector('[data-action="mastery"]').onclick = (e) => {
      e.stopPropagation();
      cycleMastery(w);
    };
    el.querySelector('[data-action="remove"]').onclick = (e) => {
      e.stopPropagation();
      toggleFav(w);
    };
  });
}

// ========== Mastery 三态切换 ==========
window.cycleMastery = function(w) {
  const cur = state.seen[w] || { count: 0, mastery: 'none' };
  const next = nextMastery(w);
  state.seen[w] = { ...cur, mastery: next, masteryAt: Date.now() };
  saveJSON("cet4_seen", state.seen);
  flash(`切换为：${MASTERY_META[next].label}`);
  updateMasteryBtn(w);
  if (getHashParts().view === "vocabulary") renderVocabularyPage();
  updateStats();
};

function updateMasteryBtn(w) {
  const btn = $("masteryBtn");
  if (!btn) return;
  const mastery = state.seen[w]?.mastery || 'none';
  const meta = MASTERY_META[mastery];
  btn.textContent = meta.label;
  btn.className = `icon-btn mastery-btn ${meta.cls}`;
}

function flash(msg) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1500);
}

function currentListSnapshot() {
  const items = document.querySelectorAll(".result-item");
  return [...items].map((el) => {
    const w = el.querySelector(".w")?.textContent || "";
    const entry = state.words.find((e) => e.w === w);
    return entry ? { word: entry, score: 0, match: "letter" } : null;
  }).filter(Boolean);
}

// ========== Web Speech ==========
function speakWord(w) {
  if (!window.speechSynthesis) { flash("当前浏览器不支持 Web Speech API"); return; }
  const u = new SpeechSynthesisUtterance(w);
  u.lang = "en-US"; u.rate = 0.85;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

// ========== Events ==========
function bindEvents() {
  // 输入框：只监听"输入中"用于移动端退出详情，不直接搜索
  $("searchInput").addEventListener("input", onInput);
  // 输入框回车：触发搜索
  $("searchInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); runSearch(); }
  });
  // "搜索"按钮
  $("searchBtn").addEventListener("click", runSearch);

  window.addEventListener("hashchange", () => {
    routeFromHash();
  });

  let lastMobile = isMobile();
  window.addEventListener("resize", () => {
    const nowMobile = isMobile();
    if (nowMobile !== lastMobile) {
      lastMobile = nowMobile;
      if (state.view === 'detail') {
        $("mainGrid").classList.toggle("view-detail", nowMobile);
      }
    }
  });

  document.addEventListener("keydown", (e) => {
    // 弹窗打开时：Esc 关闭
    if (e.key === "Escape") {
      if ($("askNModal").style.display === "flex") { cancelAskN(); return; }
      if ($("quitModal").style.display === "flex") { cancelQuit(); return; }
      const v = getHashParts().view;
      if (v === "vocabulary" || v === "study-done") { goHome(); return; }
      if (v === "study") { quitSession(); return; }
      if (state.view === 'detail') { goBackToList(); return; }
    }
    // 询问数量弹窗打开时：Enter 确认
    if (e.key === "Enter" && $("askNModal").style.display === "flex" && document.activeElement === $("askNInput")) {
      e.preventDefault(); confirmAskN(); return;
    }
    if (e.key === "/" && document.activeElement !== $("searchInput") && !getHashParts().view) {
      e.preventDefault(); $("searchInput").focus();
    }
  });
}

// 启动：包一层 try/catch，任何异常都显示在 stats 里
function safeInit() {
  try {
    init();
  } catch (e) {
    console.error("Init failed:", e);
    const stats = document.getElementById("stats");
    if (stats) {
      stats.innerHTML = `❌ 初始化失败<br/><small style="color:#ef4444;font-family:monospace">${escapeHTML(String(e.message || e))}</small>`;
    }
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", safeInit);
} else {
  safeInit();
}