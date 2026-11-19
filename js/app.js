/* app.js —— SPA 主程序：路由、向导录入、求解队列、结果页、台账、统计、牌谱库、备份 */
import { RANKS, SUITS, SUIT_SYM, cardStr, cardLabel, isRed, parseCardList, parseCard, presetMatrix, emptyMatrix, RANGE_PRESETS, classLabel } from './cards.js?v=1.18.2';
import {
  STREETS, POS6, POS9, ACTION_TYPES, BUILTIN_TAGS, ARCHETYPES, positionsFor, makeId, defaultHand,
  formatAction, parseHH, validateHand, deriveState, heroDecisionIndices, pendingHeroDecision, serializeHH, handClass, handProfitBB,
  parseActionText, normalizeActionAmounts, solveReadiness, firstToActPostflop,
  stageFromBoard, stageBoardCount, actionFlow
} from './hand.js?v=1.18.2';
import {
  initDB, state, commit, persist, saveDraft, clearDraft, upsertSession, removeSession, upsertHand, removeHand,
  bindHand, upsertJob, findCachedJob, jobCacheKey, escapeHtml,
  computeStats, sessionNet, sessionBuyin, exportJSON, importJSON, exportSessionsCSV, exportHandHH, downloadText
} from './db.js?v=1.18.2';
import { drawCurve, drawBars, renderHeatmapGrid, renderStrategyHeatmap, buildResultImage } from './charts.js?v=1.18.2';
import { solveCore, SOLVE_ITER, CONVERGENCE_TARGETS } from './solver-core.js?v=1.18.2';
import { solverSizeOptions } from './ui-sizes.js?v=1.18.2';
import { rangesForDecision } from './range-by-action.js?v=1.18.2';

const $ = s => document.querySelector(s);
const app = $('#app');
const esc = escapeHtml;
const fmt = (v, d = 2) => (Number(v) || 0).toFixed(d);
const signed = v => (Number(v) > 0 ? '+' : '') + fmt(v);
const pnlCls = v => Number(v) > 0 ? 'up' : Number(v) < 0 ? 'down' : '';
const money = v => (state().settings.currency || '¥') + fmt(v);
const today = () => new Date().toISOString().slice(0, 10);

let wizard = null;
let ui = { wizTab: 'wizard', resTab: null, period: 'all', filters: { sign: 'all', type: 'all', q: '' }, lib: { q: '', tag: '', fav: false }, act: { street: null, actor: null, bulk: false } };
let pendingPick = null;
let previewResult = null;
let toastTimer = null;
// 实时预览：纯内存态，不写入任何持久化数据。数据保护：只读 hand，绝不修改/删除已录入内容。
let livePreview = { key: '', status: 'idle', result: null, pct: 0, error: '' };
// 已受理的剥削画像指纹：切换模式/画像/强度后须点「确认并重新解算」才受理，其他参数仍自动重算
let liveProfilePart = '';
let livePreviewSeq = 0;
let livePreviewTimer = null;
let livePreviewWorker = null;

/* ---------------- 通用 UI ---------------- */
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}
function openModal(html) { $('#modalRoot').innerHTML = `<div class="modal" data-act="closeModalBg"><div class="panel" data-stop="1">${html}</div></div>`; }
function closeModal() { $('#modalRoot').innerHTML = ''; }
function confirmDialog(title, msg, onOk, okText = '确认') {
  openModal(`<h2>${esc(title)}</h2><p class="small muted">${esc(msg)}</p><div class="row end"><button class="btn" data-act="closeModal">取消</button><button class="btn danger" id="dlgOk">${esc(okText)}</button></div>`);
  $('#dlgOk').onclick = () => { closeModal(); onOk(); };
}
function showFatal(err) {
  const f = $('#fatal'); f.hidden = false;
  f.innerHTML = `<div style="max-width:720px;margin:0 auto"><b>运行时错误</b><pre style="white-space:pre-wrap;font-size:12px">${esc(err && err.message ? err.message : String(err))}</pre><p>请刷新页面；若持续出现，请导出备份后清理本地数据。点击任意处关闭此提示。</p></div>`;
  f.onclick = () => { f.hidden = true; };
}
window.addEventListener('error', e => showFatal(e.error || e.message));
window.addEventListener('unhandledrejection', e => showFatal(e.reason));

/* ---------------- 路由 ---------------- */
function routeInfo() {
  const h = (location.hash || '').replace(/^#\/?/, '');
  const [name, ...rest] = h.split('/');
  return { name: name || 'dashboard', id: rest.join('/') || '' };
}
function go(path) { location.hash = '#/' + path; render(); }
function render() {
  const { name, id } = routeInfo();
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('active', b.dataset.route === name));
  const pages = {
    dashboard: renderDashboard, new: renderNew, result: () => renderResult(id),
    sessions: renderSessions, session: () => renderSession(id), stats: renderStats,
    library: renderLibrary, backup: renderBackup
  };
  if (name !== 'new') stopLivePreview();
  const fn = pages[name] || renderDashboard;
  try { fn(); } catch (e) { showFatal(e); }
  postRender(name, id);
  if (name === 'new') scheduleLivePreview();
}
window.addEventListener('hashchange', render);

/* ---------------- 求解队列（PRD 4.2.2：同时仅 1 个任务） ---------------- */
class SolverQueue {
  constructor() { this.active = null; this.waiting = []; }
  submit(item) {
    if (this.active) { this.waiting.push(item); toast('求解任务已加入队列'); }
    else this.start(item);
  }
  start(item) {
    this.active = item;
    if (item.persist) upsertJob({ id: item.jobId, status: 'running', progress: 0.02, progressLabel: '求解任务已启动' });
    item.handlers.onProgress && item.handlers.onProgress(0.02, '求解任务已启动', null);
    const run = () => {
      if (typeof Worker === 'undefined') { this.fallback(item); return; }
      let w;
      try { w = new Worker(new URL('./solver.worker.js?v=1.18.2', import.meta.url), { type: 'module' }); }
      catch (e) { this.fallback(item); return; }
      item.worker = w;
      w.onerror = ev => this.fail(item, '求解线程异常：' + (ev.message || '未知错误'));
      w.onmessage = ev => {
        const m = ev.data || {};
        if (m.type === 'progress') {
          const conv = { exploitabilityMbb: m.exploitabilityMbb, targetMbb: m.targetMbb, converged: m.converged, iterations: m.iterations };
          if (item.persist) upsertJob({ id: item.jobId, progress: m.pct, progressLabel: m.label, etaMs: m.etaMs, ...conv });
          item.handlers.onProgress && item.handlers.onProgress(m.pct, m.label, m.etaMs, conv);
        } else if (m.type === 'result') {
          if (item.persist) upsertJob({ id: item.jobId, status: 'done', progress: 1, result: m.result });
          this.finish(item); item.handlers.onResult && item.handlers.onResult(m.result);
        } else if (m.type === 'previewResult') {
          this.finish(item); item.handlers.onPreview && item.handlers.onPreview(m.result);
        } else if (m.type === 'error') { this.fail(item, m.message); }
      };
      w.postMessage({ type: item.type, jobId: item.jobId, req: item.req, actionLabel: item.actionLabel });
    };
    setTimeout(run, 30);
  }
  fallback(item) {
    setTimeout(() => {
      try {
        toast('当前环境不支持 Web Worker，已切换为主线程慢速求解');
        const r = item.type === 'preview'
          ? (awaitPreview(item))
          : solveCore(item.req, (p, l, info) => { item.handlers.onProgress && item.handlers.onProgress(p, l, null, info); });
        if (item.type === 'preview') { this.finish(item); item.handlers.onPreview && item.handlers.onPreview(r); }
        else {
          if (item.persist) upsertJob({ id: item.jobId, status: 'done', progress: 1, result: r });
          this.finish(item); item.handlers.onResult && item.handlers.onResult(r);
        }
      } catch (e) { this.fail(item, e.message); }
    }, 40);
  }
  fail(item, msg) {
    if (item.persist) upsertJob({ id: item.jobId, status: 'failed', error: msg });
    this.finish(item);
    item.handlers.onError && item.handlers.onError(msg);
  }
  finish(item) {
    if (item.worker) { try { item.worker.terminate(); } catch (e) {} }
    this.active = null;
    const next = this.waiting.shift();
    if (next) setTimeout(() => this.start(next), 50);
  }
  cancel(jobId) {
    if (this.active && this.active.jobId === jobId) {
      const item = this.active;
      if (item.worker) { try { item.worker.terminate(); } catch (e) {} }
      this.active = null;
      if (item.persist) upsertJob({ id: jobId, status: 'failed', error: '已取消' });
      render();
      const next = this.waiting.shift();
      if (next) setTimeout(() => this.start(next), 50);
    } else this.waiting = this.waiting.filter(x => x.jobId !== jobId);
    toast('求解任务已取消');
  }
}
function awaitPreview(item) {
  // 主线程降级时的路线预览：直接调用核心（同步封装）
  return { available: false, reason: '主线程降级模式下不提供路线预览，请使用支持 Web Worker 的浏览器' };
}
const queue = new SolverQueue();

/* ---------------- 求解请求 ---------------- */
function buildSolveReq(h, decisionIndex) {
  const st = deriveState(h, decisionIndex);
  const act = (h.actions || [])[decisionIndex];
  const pot = h.potOverrideBB != null && Number.isFinite(Number(h.potOverrideBB)) ? Number(h.potOverrideBB) : st.pot;
  const stack = h.stackOverrideBB != null && Number.isFinite(Number(h.stackOverrideBB)) ? Number(h.stackOverrideBB) : st.stack;
  const stage = (wizard && wizard.stage) || stageFromBoard((h.board || []).length);
  const need = stageBoardCount(stage);
  const board = need === 0 ? [] : (h.board || []).filter(c => c != null).slice(0, need);
  // 行动一致范围（V1.15 绝对宽度口径）：对手翻前再加注后其真实范围远窄于位置预设，
  // 宽度由「位置对 × 画像风格 × 结构修正」共同决定（不写回已存数据）
  const effStack = Math.min(
    Number.isFinite(Number(st.rem?.hero)) ? Number(st.rem.hero) : Infinity,
    Number.isFinite(Number(st.rem?.villain)) ? Number(st.rem.villain) : Infinity
  );
  const ranges = rangesForDecision(h, decisionIndex, {
    mode: h.mode, archetype: h.archetype, intensity: h.intensity,
    stackBB: Number.isFinite(effStack) ? effStack : st.stack
  });
  // 决策点所在街与当前阶段不一致时，视为「新街起始局面」：无待跟注额，按位置决定谁先动
  const sameStreet = st.street === stage;
  const facingBet = sameStreet ? st.facingBet : (stage === 'PREFLOP' ? st.facingBet : 0);
  const oppChecked = sameStreet ? st.oppChecked : (stage === 'PREFLOP' ? false : !st.heroOOP);
  return {
    board, heroCards: h.heroCards || [], villainCards: h.villainCards || [], deadCards: h.deadCards || [],
    heroRange: ranges.hero, villainRange: ranges.villain, rangeNote: ranges.note,
    villainRangeLocked: ranges.villainLevel > 0,
    // 宽度已在派生层算好，求解器不再二次调整（否则松型画像会重复放大）
    villainRangePreNarrowed: ranges.widthInfo != null,
    rangeWidthInfo: ranges.widthInfo,
    pot, stack, facingBet, heroOOP: st.heroOOP, oppChecked,
    sizes: h.sizes, allowCheckRaise: h.allowCheckRaise, preset: h.preset,
    mode: h.mode, archetype: h.archetype, intensity: h.intensity,
    quality: h.quality || 'daily', targetMbb: h.targetMbb || null,
    userAction: act ? { type: act.type, amountBB: act.amountBB } : null,
    decisionNode: `${stage}|${h.positions.hero}|${facingBet > 0 ? 'vs_bet' : 'vs_check'}`,
    decisionIndex, stage
  };
}
function selectedDecisionIndex(h) {
  const stage = (wizard && wizard.stage) || stageFromBoard((h.board || []).length);
  const si = STREETS.indexOf(stage);
  const acts = h.actions || [];
  // 牌谱以对手下注结束、轮到 Hero 应对 → 默认复盘这个「还没录入的下一步」
  const pend = pendingHeroDecision(h);
  if (pend && (wizard == null || wizard.decisionIndex == null || wizard.decisionIndex === pend.index || wizard.decisionIndex >= acts.length)) return pend.index;
  const onStage = heroDecisionIndices(h).filter(i => STREETS.indexOf(String(acts[i].street).toUpperCase()) === si);
  if (!onStage.length) return acts.length; // 该街尚未行动 → 复盘「还没行动的这一步」
  return wizard && onStage.includes(wizard.decisionIndex) ? wizard.decisionIndex : onStage[onStage.length - 1];
}
function submitSolve(h, decisionIndex) {
  const rd = solveReadiness(h, wizard && wizard.stage);
  if (!rd.ready) { openReadiness(rd); return; }
  const v = validateHand(h);
  if (!v.ok) { openReadiness(rd); return; }
  if (!v.solveAllowed) { openReadiness(rd); return; }
  upsertHand(h);
  const req = buildSolveReq(h, decisionIndex);
  const params = { mode: h.mode, archetype: h.archetype, intensity: h.intensity, sizes: h.sizes, pot: req.pot, stack: req.stack, decisionIndex, preset: h.preset, quality: h.quality || 'daily', targetMbb: h.targetMbb || null };
  const key = jobCacheKey(h, params);
  const cached = findCachedJob(h, params);
  if (cached) { toast('命中求解缓存，直接打开结果'); go('result/' + cached.id); return; }
  const job = {
    id: makeId('job'), handId: h.id, mode: h.mode, archetype: h.archetype, intensity: h.intensity,
    params, cacheKey: key, req, status: 'queued', progress: 0, createdAt: new Date().toISOString()
  };
  upsertJob(job);
  if (wizard) { clearDraft(); wizard = null; }
  previewResult = null; ui.resTab = h.mode === 'exploit' ? 'exploit' : 'gto';
  go('result/' + job.id);
  queue.submit({
    jobId: job.id, req, type: 'solve', persist: true,
    handlers: {
      onProgress: (pct, label, eta, info) => { if (routeInfo().name === 'result') renderProgress(job.id, pct, label, eta, info); },
      onResult: () => { if (routeInfo().name === 'result') render(); },
      onError: msg => { toast('求解失败：' + msg); if (routeInfo().name === 'result') render(); }
    }
  });
}
/** 收敛信息块：可剥削度为主指标，迭代次数仅辅助；mbb 单位明确标注 */
function convHtml(info, pct, label, eta) {
  const m = info || {};
  const val = m.exploitabilityMbb, target = m.targetMbb;
  // 0 是近似模型的测量下限（BR 顺序偶发反转被 clamp），不得视为达标
  const invalid = val === 0;
  const reached = !!m.converged || (val > 0 && target != null && val <= target);
  const targetText = target != null ? (target < 1 ? fmt(target, 1) : String(Math.round(target))) : '—';
  const status = invalid
    ? '<span class="conv-run">≈0 为近似模型测量下限，无法可靠判定收敛</span>'
    : reached
      ? '<span class="conv-ok">✓ 已达到目标，可停止</span>'
      : val != null ? '<span class="conv-run">尚未达标，继续收敛中</span>' : '<span class="conv-run">正在计算可剥削度…</span>';
  return `<div class="conv-box">
    <div class="conv-main"><span class="conv-label">可剥削度 NashConv</span>
      <b class="conv-val" id="convVal">${val == null ? '计算中' : (invalid ? '≈0' : fmt(val, 1))}</b><span class="conv-unit">mbb/hand</span></div>
    <div class="conv-meta">目标 <b>&lt; ${targetText}</b> mbb/hand · mbb = 千分之一大盲 / 手 · 迭代 ${m.iterations != null ? Number(m.iterations).toLocaleString('en-US') : '—'}（辅助信息）</div>
    <div class="conv-status">${status}</div>
    <div class="row between" style="margin-top:7px"><span class="small">${esc(label || '求解中')}</span>
      <span class="small mono">${(pct * 100).toFixed(0)}%${eta ? ' · 预计剩余 ' + Math.ceil(eta / 1000) + 's' : ''}</span></div>
    <div class="progress" style="margin-top:6px"><i style="width:${Math.round(pct * 100)}%"></i></div>
  </div>`;
}
function renderProgress(jobId, pct, label, eta, info) {
  const box = $('#solveProgress');
  if (!box) { if (routeInfo().id === jobId) render(); return; }
  box.innerHTML = convHtml(info, pct, label, eta)
    + `<div class="row end" style="margin-top:8px"><button class="btn sm" data-act="cancelJob" data-id="${esc(jobId)}">取消任务</button></div>`;
}

/* ---------------- 工作台 ---------------- */
function renderDashboard() {
  const s = computeStats(ui.period);
  const recent = state().sessions.slice().sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 5);
  app.innerHTML = `
  <div class="page-head"><div><h1>工作台</h1><p class="sub">牌谱复盘与对局台账 · 数据仅保存在本机</p></div>
    <div class="chips">${[['7d', '7 天'], ['30d', '30 天'], ['quarter', '本季'], ['all', '全部']].map(([k, n]) => `<button class="chip ${ui.period === k ? 'on' : ''}" data-act="setPeriod" data-v="${k}">${n}</button>`).join('')}</div></div>
  <div class="grid g4" style="margin-bottom:12px">
    ${kpi('总场次', s.sessionCount + ' 场')}
    ${kpi('周期盈亏', money(s.totalNet), pnlCls(s.totalNet))}
    ${kpi('已录手牌', s.handCount + ' 手')}
    ${kpi('平均每手盈利', fmt(s.avgPerHandBB) + ' BB', pnlCls(s.avgPerHandBB))}
    ${kpi('总买入', money(s.totalBuyin))}
    ${kpi('bb/100', fmt(s.bbPer100) + ' bb', pnlCls(s.bbPer100))}
    ${kpi('胜 / 负局', s.wins + ' / ' + s.losses)}
    ${kpi('最大回撤', money(s.maxDrawdown))}
  </div>
  <div class="card"><div class="card-title"><h2>累计盈利曲线</h2><span class="tiny muted">红=盈利 绿=亏损</span></div><div class="canvas-box"><canvas id="dashCurve"></canvas></div></div>
  <div class="card"><div class="card-title"><h2>快捷入口</h2></div><div class="grid g2">
    <button class="btn primary" data-act="go" data-v="new">新建一手复盘</button>
    <button class="btn" data-act="go" data-v="session/new">新建对局</button>
    <button class="btn" data-act="go" data-v="sessions">历史对局</button>
    <button class="btn" data-act="go" data-v="library">收藏牌谱</button>
  </div></div>
  <div class="card"><div class="card-title"><h2>最近对局</h2><button class="btn sm" data-act="go" data-v="sessions">全部</button></div>
    ${recent.length ? `<div class="table-wrap"><table><thead><tr><th>日期</th><th>名称</th><th>盲注</th><th>净盈亏</th></tr></thead><tbody>${recent.map(x => `<tr><td>${esc(x.date)}</td><td>${esc(x.name)}</td><td>${esc(x.stakes?.sb)}/${esc(x.stakes?.bb)}</td><td class="${pnlCls(sessionNet(x))}">${signed(sessionNet(x))}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">还没有对局记录，先创建一场吧</div>'}
  </div>
  <div class="notice info">求解范围：<b>翻前近似</b>（无需公共牌）与<b>翻后单挑</b>（公共牌 3–5 张）；不支持 3 人及以上底池、ICM 与含抽水计算。结果为牌力分档抽象下的近似解。</div>`;
}
function kpi(label, value, cls = '') {
  return `<div class="kpi"><div class="label">${esc(label)}</div><div class="value ${cls}">${esc(value)}</div></div>`;
}

/* ---------------- 新建复盘（向导 / 粘贴） ---------------- */
function ensureWizard() {
  if (wizard) return wizard;
  const draft = state().draft;
  const hand = draft || defaultHand();
  wizard = {
    step: 1, hand, decisionIndex: null,
    stage: stageFromBoard((hand.board || []).length), paramsOpen: false,
    wizTab: ui.wizTab, pasteText: '', parseInfo: null
  };
  return wizard;
}
const HH_EXAMPLE = `# PokerGTO HH v1
Game: NLHE
Stakes: SB=1 BB=2
Table: 6max
Hero: BTN [AsKd]
Stacks: Hero=100 Villain=100 (BB)
Preflop: UTG fold, MP fold, CO fold, BTN raise 5, SB fold, BB call 5
Flop: [Kc7h2s]  BB check, BTN bet 3.3, BB call 3.3
Turn: [Kc7h2s5d]  BB check, BTN bet 11, BB fold
Result: Hero wins`;
function renderNew() {
  const w = ensureWizard();
  const h = w.hand;
  app.innerHTML = `
  <div class="page-head"><div><h1>新建一手复盘</h1><p class="sub">按街推进：默认翻前（无需公共牌）· 下一步翻后再选公共牌</p></div>
    <button class="btn sm" data-act="resetWizard">清空重填</button></div>
  <div class="tabs">
    <button class="${w.wizTab === 'wizard' ? 'on' : ''}" data-act="wizTab" data-v="wizard">分步向导</button>
    <button class="${w.wizTab === 'paste' ? 'on' : ''}" data-act="wizTab" data-v="paste">牌谱粘贴导入</button>
  </div>
  ${w.wizTab === 'paste' ? renderPaste(w) : renderWizard(w)}`;
}
function renderPaste(w) {
  return `<div class="card"><div class="card-title"><h2>粘贴 HH v1 牌谱</h2><button class="btn sm" data-act="loadExample">加载示例</button></div>
  <label class="field"><span>牌谱文本</span><textarea id="pasteText" rows="12" placeholder="${esc(HH_EXAMPLE.split('\n').slice(0, 3).join('\n'))}...">${esc(w.pasteText)}</textarea></label>
  <div class="small muted" style="margin-top:6px">格式：一行一街；<span class="mono">[...]</span> 为公共牌；动作后数值为 <b>BB 绝对值</b>；支持 <span class="mono">Pot=</span> 与百分比下注（需同时提供 Pot=）。解析失败会定位到行号。</div>
  <div class="row" style="margin-top:10px"><button class="btn primary" data-act="parsePaste">解析并预览</button><button class="btn" data-act="pasteToWizard">转为向导录入</button></div>
  ${w.parseInfo ? renderParseInfo(w.parseInfo) : ''}</div>
  <div class="notice">导入后仍可在向导中调整对手范围、下注尺度与求解模式。</div>`;
}
function renderParseInfo(info) {
  if (info.errors.length) return `<div class="notice danger" style="margin-top:12px"><b>解析失败（${info.errors.length} 处）</b><br>${info.errors.map(e => `第 ${e.line} 行：${esc(e.msg)}`).join('<br>')}<br><span class="tiny">可点击「转为向导录入」手动填写。</span></div>`;
  const h = info.hand;
  const v = validateHand(h);
  return `<div class="notice info" style="margin-top:12px"><b>解析成功</b>：${esc(h.positions.hero)} ${h.heroCards.map(cardStr).join('')} · 公共牌 ${h.board.map(cardStr).join(' ')} · ${h.actions.length} 条行动 · 校验${v.ok ? '通过' : '存在 ' + v.errors.length + ' 处错误'}</div>
  ${v.errors.length ? `<div class="notice danger" style="margin-top:8px"><b>该行动线不合逻辑，已拦截：</b><br>${v.errors.map(e => esc(e.path + '：' + e.msg)).join('<br>')}</div>` : ''}
  ${v.warnings.length ? `<div class="notice" style="margin-top:8px">${v.warnings.map(esc).join('<br>')}</div>` : ''}
  <div class="row" style="margin-top:10px"><button class="btn primary" data-act="useParsed" ${v.ok ? '' : 'disabled'}>使用此牌谱继续配置</button>${v.ok ? '' : '<button class="btn" data-act="useParsedForce">仍要载入并修正</button>'}</div>`;
}
function renderWizard(w) {
  const h = w.hand;
  const steps = ['牌局与手牌', '行动流与解算'];
  const v = validateHand(h);
  const di = selectedDecisionIndex(h);
  const rd = solveReadiness(h, w.stage);
  const body = w.step === 1 ? wizardStep1(h) : wizardStep2(h, di, v, rd);
  const stateTip = rd.ready
    ? '<span class="ready-ok">✓ 已满足解算条件</span>'
    : `<span class="ready-no">✕ 待补齐：${esc(firstBlocking(rd))}</span>`;
  return `<div class="card tight"><div class="stepper">${steps.map((s, i) => `${i ? '<span class="line"></span>' : ''}<span class="s ${w.step === i + 1 ? 'on' : ''}"><span class="n">${i + 1}</span>${s}</span>`).join('')}</div></div>
  ${body}
  <div class="wiz-foot">
    ${w.step > 1 ? '<button class="btn" data-act="wizStep" data-v="1">上一步</button>' : '<span></span>'}
    <div class="foot-state">${stateTip}<span class="tiny muted sep">·</span><span class="tiny muted">草稿自动保存</span></div>
    <div class="row">
      ${w.step < 2 ? '<button class="btn" data-act="wizStep" data-v="2">下一步：行动流 →</button>' : ''}
      <button class="btn primary" data-act="beginSolve">开始解算 →</button>
    </div>
  </div>`;
}
function cardSlot(c, kind, idx, pending) {
  const label = c != null ? cardLabel(c) : '+';
  return `<button class="card-slot ${c != null && isRed(c) ? 'red' : ''} ${pending ? 'pending' : ''}" data-act="pickCard" data-kind="${kind}" data-idx="${idx}" title="${pending ? '请按顺序先选择前面的牌' : '点击选择'}">${esc(label)}</button>`;
}
function cardRowHtml(cards, kind, n) {
  const arr = (cards || []).slice(0, n);
  const len = (cards || []).filter(c => c != null).length;
  return `<div class="card-row">${Array.from({ length: n }, (_, i) => cardSlot(arr[i], kind, i, arr[i] == null && i > len)).join('')}
    ${(cards || []).length ? `<button class="btn sm" data-act="clearCards" data-kind="${kind}">清空</button>` : ''}</div>`;
}
function wizardStep1(h) {
  const pos = positionsFor(h.tableSize);
  return `<div class="card"><h2>① 对局基础</h2><div class="grid g3">
    <label class="field"><span>小盲 SB</span><input type="number" step="0.5" min="0" data-bind="stakes.sb" value="${esc(h.stakes.sb)}"></label>
    <label class="field"><span>大盲 BB</span><input type="number" step="0.5" min="0.1" data-bind="stakes.bb" value="${esc(h.stakes.bb)}"></label>
    <label class="field"><span>有效后手 (BB)</span><input type="number" step="1" min="1" data-bind="stackBB" value="${esc(h.stackBB)}"></label>
    <label class="field"><span>桌型</span><select data-bind="tableSize" data-refresh="1"><option value="6" ${h.tableSize === 6 ? 'selected' : ''}>6 人桌</option><option value="9" ${h.tableSize === 9 ? 'selected' : ''}>9 人桌</option></select></label>
    <label class="field"><span>Hero 位置</span><select data-bind="positions.hero" data-refresh="1">${pos.map(p => `<option value="${p}" ${h.positions.hero === p ? 'selected' : ''}>${p}</option>`).join('')}</select></label>
    <label class="field"><span>对手位置</span><select data-bind="positions.villain">${pos.map(p => `<option value="${p}" ${h.positions.villain === p ? 'selected' : ''}>${p}</option>`).join('')}</select></label>
  </div><div class="tiny muted" style="margin-top:6px">游戏类型：NLHE（V1.0 固定）；BB 为求解基准单位。</div></div>
  <div class="card"><h2>② 手牌</h2>
    <div class="small muted">Hero 手牌（点击格子选择花色 + 牌点）</div>${cardRowHtml(h.heroCards, 'hero', 2)}
    <div class="small muted" style="margin-top:8px">对手手牌（可选，摊牌已知时填写）</div>${cardRowHtml(h.villainCards, 'villain', 2)}
    <label class="field" style="margin-top:8px"><span>死牌 Dead Cards（可选，如 As Kd）</span><input type="text" data-bind="deadText" value="${esc((h.deadCards || []).map(cardStr).join(' '))}" placeholder="已知弃牌，空格分隔"></label>
    <label class="field" style="margin-top:8px"><span>摊牌结果</span><select data-bind="result"><option value="" ${!h.result ? 'selected' : ''}>未录入</option><option value="hero" ${h.result === 'hero' ? 'selected' : ''}>我方赢</option><option value="villain" ${h.result === 'villain' ? 'selected' : ''}>对方赢</option><option value="split" ${h.result === 'split' ? 'selected' : ''}>平分底池</option></select></label>
  </div>
  <div class="notice info">默认从<b>翻前</b>开始：无需选公共牌，录完手牌与翻前行动即可解算。点第 2 步的「下一步：翻牌」后，才需要选择 3 张公共牌；转牌 / 河牌逐街追加。<br>已选定的 Hero 与对手位置即本手唯二参与行动的位置，<b>其余位置翻前默认弃牌</b>，行动页无需逐一录入；翻后仅支持这两家。</div>`;
}
/* ---------------- 行动流：可视化行动选择器 ---------------- */
const ACTION_LABEL = { FOLD: '弃牌', CHECK: '过牌', CALL: '跟注', BET: '下注', RAISE_TO: '加注至', ALLIN: '全下' };
const ACTION_ICON = { FOLD: '✕', CHECK: '＝', CALL: '＋', BET: '↑', RAISE_TO: '⇈', ALLIN: '★' };
const STREET_NAME = { PREFLOP: '翻前', FLOP: '翻牌', TURN: '转牌', RIVER: '河牌' };
const BULK_EXAMPLE = `Preflop: UTG fold, MP fold, CO fold, BTN raise 5, SB fold, BB call 5
Flop: BB check, BTN bet 3.3, BB call 3.3
Turn: BB check, BTN bet 11, BB fold`;

/** 把任意行动者（位置名 / HERO / VILLAIN）归一为座位键 */
function actorKey(h, a) {
  const u = String(a || '').toUpperCase();
  if (u === 'HERO' || u === String(h.positions.hero).toUpperCase()) return 'HERO';
  if (u === 'VILLAIN' || u === String(h.positions.villain).toUpperCase()) return 'VILLAIN';
  return u;
}
/** 当前选中的街：用户切换优先，否则继承最后一条动作 */
function actStreet(h) {
  if (wizard && wizard.stage) return wizard.stage;
  const acts = h.actions || [];
  return ui.act.street || (acts.length ? String(acts[acts.length - 1].street).toUpperCase() : 'PREFLOP');
}
/**
 * 下一位行动者：由纯逻辑 actionFlow 推导（仅 Hero 与对手两家，其它位置默认弃牌）。
 * 本街已结束时返回 null（座位不再亮起）；允许用「换人」手动覆盖。
 */
function nextActorFor(h, street) {
  const f = actionFlow(h, street);
  if (ui.act.actor) return ui.act.actor;
  return f.actor;
}
/** 当前街的下注局面：与状态机同源，供行动卡片生成金额与可用态 */
function liveFor(h, street) {
  const f = actionFlow(h, street);
  return {
    f,
    v: f.v,
    live: { pot: f.pot, toCall: f.toCall, highest: f.highest, lastRaise: f.lastRaise, street }
  };
}
function suggestedAmounts(h, live, eff = null, side = null) {
  const r1 = x => Math.round(x * 10) / 10;
  const rem = eff && side ? Math.max(0, (eff.rem && eff.rem[side]) || 0) : Math.max(0, Number(h.stackBB) || 100);
  const cur = eff && side ? ((eff.streetInv && eff.streetInv[side]) || 0) : 0;
  return {
    FOLD: null, CHECK: null,
    CALL: r1(Math.min(Number(live.toCall) || 0, rem)),
    BET: r1(Math.max(1, (Number(live.pot) || 1.5) * 0.67)),
    RAISE_TO: r1(Math.max(3, (Number(live.highest) || 0) + (Number(live.lastRaise) || 1) * 3)),
    ALLIN: r1(cur + rem)
  };
}
/** 下注尺度：按当前底池计算，最多 4 档，去重并裁到后手以内；展示以具体 BB 为主 */
function betSizes(live, stack) {
  const pot = Math.max(0.5, Number(live.pot) || 1);
  const cap = Math.max(0.5, Number(stack) || 100);
  const out = [], seen = new Set();
  const add = (amt, label) => {
    const a = Math.round(amt * 10) / 10;
    if (!(a > 0) || a > cap + 1e-9 || seen.has(a)) return;
    seen.add(a); out.push({ amt: a, label });
  };
  add(pot * 0.33, '33% 池'); add(pot * 0.5, '50% 池'); add(pot * 0.67, '67% 池'); add(pot, '满池');
  return out.slice(0, 4);
}
/** 加注尺度：按当前局面（已下注额 / 最小加注）计算「加注至」总额，展示具体 BB 数 */
function raiseSizes(live, stack) {
  const highest = Math.max(0, Number(live.highest) || 0);
  const lastRaise = Math.max(1, Number(live.lastRaise) || 1);
  const toCall = Math.max(0, Number(live.toCall) || 0);
  const minTo = Math.max(highest + lastRaise, toCall);
  const cap = Math.max(0.5, Number(stack) || 100);
  const out = [], seen = new Set();
  const add = (amt, label, must) => {
    const a = Math.round(amt * 10) / 10;
    if (must && a < minTo - 1e-9) return;
    if (!(a > 0) || a > cap + 1e-9 || seen.has(a)) return;
    seen.add(a); out.push({ amt: a, label });
  };
  add(minTo, '最小加注');
  add(Math.min(cap, minTo * 2), '2× 尺度');
  add(Math.min(cap, minTo * 3), '3× 尺度');
  add(cap, '全下');
  return out.slice(0, 4);
}

/* ---------- 座位图 ---------- */
function seatCoords(h) {
  const pos = positionsFor(h.tableSize);
  const i = pos.indexOf('BTN');
  const rot = i >= 0 ? [...pos.slice(i), ...pos.slice(0, i)] : pos;
  const step = 360 / rot.length;
  return rot.map((name, k) => {
    const rad = (90 + k * step) * Math.PI / 180;
    // 垂直半径收窄，避免底部座位被 sticky 底栏遮挡；水平保持原有间距
    return { name, left: 50 + 37 * Math.cos(rad), top: 50 + 28 * Math.sin(rad) };
  });
}
function tableHtml(h, street, actor, live) {
  const si = STREETS.indexOf(street);
  const folded = new Set(), inv = {};
  for (const a of h.actions || []) {
    const asi = STREETS.indexOf(String(a.street).toUpperCase());
    const k = actorKey(h, a.actor);
    if (a.type === 'FOLD' && asi <= si) folded.add(k);
    if (asi !== si) continue;
    const amt = a.amountBB == null ? 0 : Number(a.amountBB) || 0;
    const cur = inv[k] || 0;
    if (a.type === 'BET' || a.type === 'CALL') inv[k] = cur + amt;
    else if (a.type === 'RAISE_TO' || a.type === 'ALLIN') inv[k] = Math.max(cur, amt);
  }
  // 只有「轮到行动」的那个座位亮起；本街结束时 actor 为 null，全桌不亮
  const activeKey = actor ? actorKey(h, actor) : null;
  const seats = seatCoords(h).map(s => {
    const key = actorKey(h, s.name);
    const side = key === 'HERO' ? 'hero' : key === 'VILLAIN' ? 'villain' : 'other';
    const isLive = side !== 'other';
    // 其它位置翻前默认弃牌，无需逐一录入
    const isFolded = !isLive || folded.has(key);
    const active = !!activeKey && key === activeKey && !isFolded;
    const amt = inv[key] || 0;
    const tag = side === 'hero' ? 'HERO' : side === 'villain' ? '对手' : '默认弃牌';
    // 开局录入的起手牌直接显示在座位上（对手手牌仅在已知时显示）
    const hole = side === 'hero' ? (h.heroCards || []) : side === 'villain' ? (h.villainCards || []) : [];
    const holeHtml = hole.filter(c => c != null).length
      ? `<div class="seat-cards">${hole.filter(c => c != null).map(c => `<span class="mini-c ${isRed(c) ? 'red' : ''}">${esc(cardLabel(c))}</span>`).join('')}</div>`
      : '';
    return `<div class="seat ${side} ${isLive ? 'live' : 'other'} ${isFolded ? 'folded' : ''} ${active ? 'active' : ''}"
      ${isLive ? `data-act="setActorSeat" data-v="${esc(s.name)}" role="button" title="设为当前行动者：${esc(s.name)}"` : ''}
      style="left:${s.left.toFixed(1)}%;top:${s.top.toFixed(1)}%">
      <div class="seat-nm">${esc(s.name)}</div>
      ${holeHtml}
      <div class="seat-tag">${tag}${amt > 0 ? ' · ' + fmt(amt, 1) : ''}</div>
      ${active ? '<div class="seat-act">● 行动中</div>' : ''}
    </div>`;
  }).join('');
  const boardN = stageBoardCount(street);
  // 公共牌选择已并入牌桌中央：每个槽可点击选牌，前一街的牌自动保留。
  // 数据保护：仅通过 pickCard 局部写入 h.board[idx]，不触碰手牌/行动/范围/台账。
  const boardHtml = boardN === 0
    ? '<span class="tiny board-empty">翻前 · 无需公共牌</span>'
    : boardRowForTable(h, boardN);
  return `<div class="table-wrap-v">
    <div class="felt">${seats}
      <div class="felt-center">
        <div class="pot"><span>底池</span><b>${fmt(live.pot ?? 0, 1)}</b><span>BB</span></div>
        <div class="felt-board">${boardHtml}</div>
        <div class="felt-street">${STREET_NAME[street] || street}${boardN > 0 ? ' · 点击牌位选公共牌' : ''}</div>
      </div>
    </div>
    <div class="table-legend"><span><i class="dot hero"></i>Hero</span><span><i class="dot villain"></i>对手</span><span><i class="dot folded"></i>其它位置默认弃牌</span><span><i class="dot active"></i>当前行动者（唯一亮起）</span><span class="tiny">点 Hero / 对手座位可指定行动者 · 点牌桌中央牌位选公共牌</span></div>
  </div>`;
}
/** 牌桌中央的公共牌槽：复用选牌弹窗，按序填充；与独立公共牌卡片共用同一份 h.board 数据 */
function boardRowForTable(h, n) {
  const arr = (h.board || []).slice(0, n);
  const len = (h.board || []).filter(c => c != null).length;
  const filled = arr.filter(c => c != null).length;
  const slots = Array.from({ length: n }, (_, i) => {
    const c = arr[i];
    const pending = c == null && i > len;
    const label = c != null ? cardLabel(c) : '+';
    return `<button class="card-slot felt-slot ${c != null && isRed(c) ? 'red' : ''} ${pending ? 'pending' : ''} ${c != null ? 'filled' : ''}"
      data-act="pickCard" data-kind="board" data-idx="${i}" title="${pending ? '请先选前面的牌' : c != null ? '点击更换这张公共牌' : '点击选择公共牌'}">${esc(label)}</button>`;
  }).join('');
  const badge = filled >= n ? '<span class="board-done">✓ 已选齐</span>' : `<span class="board-need">${n - filled} 张待选</span>`;
  return `<div class="felt-board-row">${slots}<span class="board-badge">${badge}</span></div>`;
}

/* ---------- 实时求解动态展示（录入阶段随选择即时刷新，纯内存态） ---------- */
/**
 * 数据保护：本模块只读 wizard.hand 生成求解请求，结果仅存于内存 livePreview；
 * 不调用 upsertHand / upsertJob / persist，不写 IndexedDB / localStorage，不改任何已录入字段。
 */
/**
 * 实时预览的目标节点（V1.9）：随牌局状态、已录动作与当前决策动态切换，杜绝展示过期选项。
 *  - live    轮到 Hero 行动（含对手下注后的待应对）→ 解算「全部已录动作之后」的当前节点
 *  - review  用户在时间线上显式指定的历史决策点 → 复盘当时局面（标注「复盘」）
 *  - waiting 轮到对手行动 → 无 Hero 待决策，只展示等待态（不再显示上一节点的过牌等选项）
 *  - closed  本街 / 手牌已结束 → 提示收口，可点时间线复盘
 */
function liveTarget(h, street) {
  const acts = h.actions || [];
  const flow = actionFlow(h, street);
  const di = wizard ? wizard.decisionIndex : null;
  if (di != null && di >= 0 && di < acts.length && heroDecisionIndices(h).includes(di)) return { mode: 'review', di };
  if (flow.handOver) return { mode: 'closed', reason: '手牌已结束（有人弃牌或已摊牌）' };
  if (flow.closed && !ui.act.force) return { mode: 'closed', reason: flow.closedReason || '本街行动已结束' };
  const actor = nextActorFor(h, street) || flow.first;
  if (actorKey(h, actor) === 'HERO') return { mode: 'live', di: acts.length, actor };
  return { mode: 'waiting', actor };
}
function liveReqKey(h, street) {
  if (!h) return '';
  const bn = (h.board || []).filter(c => c != null).length;
  if (bn === 1 || bn === 2) return 'incomplete'; // 翻牌未选齐，无法求解
  const t = liveTarget(h, street);
  if (t.mode === 'waiting') return 'waiting';
  if (t.mode === 'closed') return 'closed';
  const need = stageBoardCount(street);
  const board = need === 0 ? [] : (h.board || []).filter(c => c != null).slice(0, need);
  return JSON.stringify({
    board, hero: h.heroCards, villain: h.villainCards, dead: h.deadCards,
    heroRange: h.rangePresets?.hero, villainRange: h.rangePresets?.villain,
    pot: h.potOverrideBB, stack: h.stackOverrideBB, stackBB: h.stackBB,
    sizes: h.sizes, mode: h.mode, archetype: h.archetype, intensity: h.intensity,
    di: t.di, review: t.mode === 'review', street, positions: h.positions, tableSize: h.tableSize, actions: (h.actions || []).length
  });
}
/** 实时策略建议的简要解释：推荐动作 + 主要判断依据（数据全部来自求解结果与当前局面） */
function liveWhyHtml(r, req, actsIn = null) {
  const acts = ((actsIn && actsIn.length ? actsIn : r.actions) || []).filter(a => a && a.label);
  if (!acts.length) return '';
  const rec = acts.slice().sort((a, b) => (b.freq - a.freq) || (b.ev - a.ev))[0];
  const byEV = acts.slice().sort((a, b) => b.ev - a.ev);
  const second = byEV.find(a => a !== rec);
  const lines = [];
  const pctText = f => f > 0 && f < 0.01 ? '<1%' : (f * 100).toFixed(0) + '%';
  const secondTag = second && second.ev > rec.ev ? 'EV 更高' : '次优';
  lines.push(`推荐「${esc(rec.label)}」（频率 ${pctText(rec.freq)}）：EV ${rec.ev >= 0 ? '+' : ''}${fmt(rec.ev)} BB${second ? `；${secondTag}「${esc(second.label)}」（频率 ${pctText(second.freq)}）EV ${second.ev >= 0 ? '+' : ''}${fmt(second.ev)} BB` : ''}。`);
  const toCall = Math.max(0, Number(req.facingBet) || 0);
  const pot = Math.max(0.1, Number(req.pot) || 0.1);
  const needPct = toCall > 0 ? toCall / (pot + toCall) : null;
  if (needPct != null) lines.push(`底池赔率：跟注 ${fmt(toCall, 1)} BB 可争夺 ${fmt(pot, 1)} BB 底池，所需权益约 ${(needPct * 100).toFixed(0)}%。`);
  if (r.focus && Number.isFinite(r.focus.equityVsVillainRange)) {
    const eq = r.focus.equityVsVillainRange * 100;
    const verdict = needPct != null
      ? (eq >= needPct * 100 ? '高于跟注门槛，权益支持继续' : '低于跟注门槛，权益不支持宽跟注')
      : (eq >= 50 ? '权益过半，具备下注 / 加注的价值基础' : '权益不足半，更宜过牌控制或小尺度施压');
    lines.push(`你的手牌 ${esc((r.focus.cards || []).join(' '))} 对对手范围权益约 ${eq.toFixed(1)}%，${verdict}。`);
  }
  // V1.16 范围条件化：区分「call 面对下注范围(含诈唬)」与「raise 被跟注面对纯价值范围」，
  // 并展示手牌级隐含赔率——这是 K4 顶对弱踢脚不该盲目造池的核心依据。
  const cond = r.focus && r.focus.conditional;
  if (cond) {
    lines.push(`范围条件化：call 面对对手下注范围（${cond.betCombos} 组合，含诈唬），你的权益 ${(cond.eqCall * 100).toFixed(1)}%；`
      + `raise 被跟注则只剩价值范围（${cond.contCombos} 组合），权益降到 ${(cond.eqCont * 100).toFixed(1)}%。`);
    // V1.17：行动卡 EV 是「范围平均」，手牌级条件 EV 才是你这手牌的真实收益。
    // 补一行手牌级对比，直接呈现「面对 TAG 加注负 EV / 面对 LAG 加注可盈利」的结论。
    const st = (r.focus && r.focus.strategy) || [];
    const evs = cond.evs || [];
    const callIdx = st.findIndex(a => a.type === 'CALL');
    const raiseIdx = st.map((a, i) => ({ a, i })).filter(x => x.a.type === 'RAISE' || x.a.type === 'ALLIN');
    if (callIdx >= 0 && raiseIdx.length) {
      const callEv = evs[callIdx];
      const raiseEvs = raiseIdx.map(x => evs[x.i]).filter(v => Number.isFinite(v));
      if (Number.isFinite(callEv) && raiseEvs.length) {
        const bestRaise = Math.max(...raiseEvs);
        const verdict = bestRaise < 0
          ? '：面对该画像加注是负 EV，造池不划算'
          : (callEv > bestRaise ? '：跟注收益更高' : '：加注收益更高');
        lines.push(`手牌级条件 EV：跟注 ${callEv >= 0 ? '+' : ''}${fmt(callEv)} BB，加注最高 ${bestRaise >= 0 ? '+' : ''}${fmt(bestRaise)} BB${verdict}。`);
      }
    }
    if (cond.impliedBB > 0) lines.push(`隐含赔率：跟注后击中提升牌的后续街收益约 +${cond.impliedBB.toFixed(1)} BB（已计入 call 的 EV）。`);
  }
  const whyMap = {
    FOLD: '权益或赔率不足，弃牌止损是长期最优',
    CHECK: '免费看牌控制底池，同时保留对手下注的诈唬空间',
    CALL: '跟注的即时赔率与权益匹配，EV 为正',
    BET: '下注可拒绝对手权益，并从更差牌获取价值',
    RAISE: '加注向对手范围施压，兼顾价值与弃牌率',
    ALLIN: '全下最大化弃牌率，被跟注时实现全部权益'
  };
  if (whyMap[rec.type]) lines.push(`主要判断依据：${whyMap[rec.type]}。`);
  if (req && req.rangeNote) lines.push(`范围口径：${esc(req.rangeNote)}。`);
  if (req && req.mode === 'exploit') {
    const A = r && r.archetype ? ARCHETYPES.find(a => a.id === r.archetype) : null;
    const lv = Number(r && r.intensity) === 0.5 ? '轻度' : Number(r && r.intensity) === 1.5 ? '重度' : '中度';
    lines.push(`剥削口径：对手画像 ${esc(A ? A.name + ' ' + A.tag : (r && r.archetype) || '—')} · ${lv}（节点锁定后求 Hero 最优应对）。`);
  }
  const allinSize = rec.type === 'ALLIN' ? Number(rec.sizeBB != null ? rec.sizeBB : (Number(req.stack) || 0) + toCall) : 0;
  if (allinSize > pot * 2 && (Number(req.stack) || 0) >= 150) {
    lines.push(`风险提示：全下 ${fmt(allinSize, 1)} BB 超过底池 2 倍且属深码，需对手大量弃牌才成立；模型为近似结果，实盘慎用。`);
  }
  return `<div class="live-why"><div class="why-hd">为什么推荐</div>${lines.map(l => `<div class="why-line">${l}</div>`).join('')}</div>`;
}

/* V1.18 河牌决策教学：基于求解结果里的 lesson（价值/诈唬组合拆解 + 抓诈赔率），
 * 用教学化语言解释「为什么高频跟注」「组合如何拆」「面对 TAG/LAG 怎么调」。
 * 数据全部来自本次求解，不硬编码具体牌。 */
function riverLessonHtml(r) {
  const L = r && r.lesson;
  if (!L) {
    // 仅在河牌面对下注时提供决策教学；其他节点给出明确指引，避免误以为功能缺失。
    return `<div class="river-lesson lesson-empty"><div class="lesson-hd">河牌决策教学<span class="pill">仅河牌提供</span></div>`
      + `<div class="lesson-sec"><div class="tiny muted">本局教学（价值/诈唬组合拆解、抓诈赔率、TAG/LAG 调整）仅在<b>河牌面对下注</b>的决策点生成；当前决策点不满足条件。`
      + `可在上方「行动回放与决策点」点击河牌那一步重新求解，即可看到完整教学。</div></div></div>`;
  }
  const eqPct = L.heroEquity != null ? (L.heroEquity * 100).toFixed(1) : '—';
  const needPct = (L.needPct * 100).toFixed(1);
  const mdfPct = (L.mdf * 100).toFixed(1);
  const fmtGroup = g => `<span class="lesson-combo" title="权益 ${(g.eq * 100).toFixed(1)}%">${esc(g.label)}<em>${g.combos}</em></span>`;
  const valueHtml = L.value.slice(0, 8).map(fmtGroup).join('');
  const bluffHtml = L.bluff.slice(0, 8).map(fmtGroup).join('') || '<span class="tiny muted">该画像下诈唬组合极少</span>';
  // V1.18.1：这里的权益必须是对「对手下注范围」的权益，不是对全范围。
  // 剥削档下注范围被极化收窄，全范围权益会虚高（如 TAG 全范围 35% 但对下注范围仅 2.6%）。
  const allPct = L.heroEquityAllRange != null ? (L.heroEquityAllRange * 100).toFixed(1) : null;
  const scopeNote = (allPct != null && Math.abs(L.heroEquityAllRange - L.heroEquity) > 0.03)
    ? `注意：这是你对<b>下注范围</b>的权益；你对对手<b>全范围</b>的权益虽有 ${allPct}%，但对手此刻下注的范围已被收窄/极化，不能用全范围权益来抓诈。`
    : '';
  const verdict = L.bluffCatchOk
    ? `你对下注范围的权益 <b>${eqPct}%</b> ≥ 抓诈门槛 <b>${needPct}%</b>，跟注长期为正 EV——这就是 GTO 在此高频跟注的根本原因：`
      + `对手下注范围里混入了足够多「你赢、他输」的诈唬牌，你只需要赢下其中 ${needPct}% 就能回本。`
    : `你对下注范围的权益 <b>${eqPct}%</b> &lt; 抓诈门槛 <b>${needPct}%</b>，跟注长期亏 EV，弃牌才是正解。`
    + (scopeNote ? ` ${scopeNote}` : '');
  const mdfLine = `最小防守频率 MDF = 底池 / (底池 + 下注) = ${fmt(L.pot, 1)} / (${fmt(L.pot, 1)} + ${fmt(L.bet, 1)}) ≈ <b>${mdfPct}%</b>。`
    + `GTO 要求你至少用 ${mdfPct}% 的手牌继续（跟注或加注），否则对手可以用任意牌下注就盈利——这是「不能弃太多」的数学下限。`;
  const streetNote = L.streetSteps > 0
    ? `本场景已打到河牌（跨街 ${L.streetSteps} 步），诈唬占比逐街衰减到 <b>${(L.bluffFrac * 100).toFixed(1)}%</b>，价值/诈唬极化度 <b>${fmt(L.polarization, 1)}:1</b>；连打三条街后仍在下注的范围，诈唬已所剩无几。`
    : '';
  const archLine = (() => {
    if ((r.mode || 'gto') !== 'exploit') {
      const caveat = (L.streetSteps || 0) > 0
        ? '注意：本场景已连打到河牌，跨街极化让诈唬逐街衰减——即便 LAG 到此诈唬也所剩不多，须结合极化度判断、并切「剥削」档核对具体频率。'
        : '可切到「剥削」档查看具体频率。';
      return `面对不同画像时的调整：<b>TAG</b> 主动下注的是筛选后的强范围、诈唬极少 → 应<b>提高弃牌频率</b>（少抓诈）；`
        + `<b>LAG</b> 下注混入大量空气、被加注后弃牌多 → 应<b>提高跟注频率</b>抓诈，甚至可加注施压。${caveat}`;
    }
    const A = ARCHETYPES.find(a => a.id === r.archetype);
    const polar = L.polarization;
    return `当前画像 <b>${esc(A ? A.name + ' ' + A.tag : (r.archetype || '—'))}</b>：下注范围价值/诈唬极化度 <b>${fmt(polar, 1)}:1</b>、诈唬占比 <b>${(L.bluffFrac * 100).toFixed(1)}%</b>。`
      + (polar >= 8 ? '诈唬极少，这是典型的 TAG/紧强范围 → 抓诈要谨慎、提高弃牌。'
        : polar >= 4 ? '诈唬中等，接近平衡 → 按底池赔率中性决策。'
          : '诈唬充足，范围偏松凶 → 跟注抓诈有价值，可放宽继续范围。');
  })();
  return `<div class="river-lesson">
    <div class="lesson-hd">河牌决策教学 · 抓诈与范围拆解<span class="pill">EV 单位 BB</span></div>
    <div class="lesson-sec"><b>① 局面与赔率</b>
      <div>底池 <b>${fmt(L.pot, 1)}</b> BB，对手下注 <b>${fmt(L.bet, 1)}</b> BB，你要跟 <b>${fmt(L.bet, 1)}</b> BB 争夺 <b>${fmt(L.pot + L.bet, 1)}</b> BB。</div>
      <div>抓诈门槛 = 跟注 / (底池 + 跟注) = ${fmt(L.bet, 1)} / ${fmt(L.pot + L.bet, 1)} ≈ <b>${needPct}%</b>。</div>
      <div>${verdict}</div>
    </div>
    <div class="lesson-sec"><b>② 为什么 GTO 高频跟注（MDF）</b><div>${mdfLine}</div>${streetNote ? `<div>${streetNote}</div>` : ''}</div>
    <div class="lesson-sec"><b>③ 对手下注范围拆解</b>
      <div><span class="lesson-tag val">价值区 · ${L.valueCombos} 组合</span>${valueHtml}</div>
      <div style="margin-top:5px"><span class="lesson-tag bluf">诈唬区 · ${L.bluffCombos} 组合</span>${bluffHtml}</div>
      <div class="tiny muted" style="margin-top:6px">数字 = 该手牌类别的组合数；按河牌穷举权益从高到低切分：价值区取前 ${(L.valueFrac * 100).toFixed(0)}%、诈唬区取后 ${(L.bluffFrac * 100).toFixed(0)}%。悬停看权益。</div>
    </div>
    <div class="lesson-sec"><b>④ 面对 TAG / LAG 的频率调整</b><div>${archLine}</div></div>
  </div>`;
}
/** 实时面板主体：waiting/closed/incomplete 直接给出状态说明；live/review 走求解状态机 */
function liveBodyHtml(h, street) {
  const key = liveReqKey(h, street);
  const t = liveTarget(h, street);
  const { live } = liveFor(h, street);
  if (key === 'incomplete') {
    const have = (h.board || []).filter(c => c != null).length;
    return `<div class="live-msg">正在选公共牌：还需 ${3 - have} 张即可实时预览翻牌局面</div>`;
  }
  if (key === 'waiting') {
    const toCall = Math.max(0, Number(live.toCall) || 0);
    return `<div class="live-msg"><span class="live-spin"></span> 轮到对手（${esc(t.actor || '—')}）行动${toCall > 0 ? ` · 对手需跟注 ${fmt(toCall, 1)} BB` : ''} · 底池 ${fmt(live.pot, 1)} BB</div>
      <div class="tiny muted" style="padding:0 2px 8px">你已行动，当前没有 Hero 待决策——为避免误导，不再显示上一节点的过牌等过期选项。对手动作录入后本面板自动重算；点时间线中自己的动作可复盘当时的决策。</div>`;
  }
  if (key === 'closed') {
    return `<div class="live-msg">✓ ${esc(t.reason || '本街行动已结束')} · 底池 ${fmt(live.pot, 1)} BB</div>
      <div class="tiny muted" style="padding:0 2px 8px">当前没有实时决策；点时间线中 Hero 的动作可复盘当时的策略。</div>`;
  }
  const done = livePreview.status === 'done' && livePreview.result && livePreview.key === key;
  if (livePreview.status === 'confirm' && livePreview.key === key) {
    const A = ARCHETYPES.find(a => a.id === h.archetype);
    const level = Number(h.intensity) === 0.5 ? '轻度' : Number(h.intensity) === 1.5 ? '重度' : '中度';
    return `<div class="live-confirm">
      <div class="live-msg">剥削画像已变更：${esc(h.mode === 'exploit' ? (A ? A.name + ' ' + A.tag : h.archetype) + ' · ' + level : h.mode)}。尚未重新求解。</div>
      <button class="btn primary" data-act="confirmExploit">确认并重新解算</button>
      <div class="tiny muted" style="margin-top:6px">为避免仅切换模式就自动重算，需你确认后才按新画像求解；确认前不显示任何旧频率与旧 EV。</div>
    </div>`;
  }
  if (livePreview.status === 'error' && livePreview.key === key) {
    return `<div class="live-msg err">预览不可用：${esc(livePreview.error)}（不影响正式解算）</div>`;
  }
  if (!done && (livePreview.status === 'solving' || livePreview.status === 'queued') && livePreview.key === key) {
    return `<div class="live-msg"><span class="live-spin"></span> 正在计算实时策略 · ${Math.round(livePreview.pct * 100)}%</div>
      <div class="tiny muted" style="padding:0 2px 4px">可剥削度 ${livePreview.mbb != null ? fmt(livePreview.mbb, 1) : '计算中'} / 目标 &lt;${livePreview.target != null ? livePreview.target : 50} mbb/hand（教学档）</div>
      <div class="progress" style="margin-top:6px"><i style="width:${(livePreview.pct * 100).toFixed(0)}%"></i></div>`;
  }
  if (done) {
    const r = livePreview.result;
    const acts = displayActs(r);
    const maxF = Math.max(0.0001, ...acts.map(a => a.freq));
    let req = null;
    try { req = buildSolveReq(h, t.di); } catch (e) { req = { pot: r.pot, facingBet: 0 }; }
    const handTag = r.focus && (r.focus.cards || []).length ? ` · 频率按手牌 ${esc(r.focus.cards.join(' '))}` : '';
    // 复盘模式：历史节点策略在此行内展示；实时模式的频率/EV 已内联到下方选项卡片
    const rows = t.mode === 'review'
      ? `<div class="dp-sub">复盘 #${t.di + 1} · 当时局面（仅展示，点时间线可切换）</div>
      <div class="live-bars">${acts.map((a, i) => `<div class="live-row ${a.freq >= maxF - 1e-9 && a.freq > 0 ? 'best' : ''}">
        <span class="live-act">${esc(a.label || a.type)}</span>
        <div class="live-track"><i style="width:${(a.freq / maxF * 100).toFixed(0)}%;animation-delay:${(i * 40)}ms"></i></div>
        <span class="live-freq">${(a.freq * 100).toFixed(0)}%</span>
        <span class="live-ev ${pnlCls(a.ev)}">${a.ev >= 0 ? '+' : ''}${fmt(a.ev)}</span>
      </div>`).join('')}</div>`
      : '';
    return `<div class="live-head"><span class="live-node">${esc(r.decisionNode || '')}</span><span class="tiny muted">底池 ${fmt(r.pot, 1)} BB · ${r.iterations} 次 CFR 迭代${handTag}</span></div>
      ${rows}
      ${liveWhyHtml(r, req, acts)}`;
  }
  if (livePreview.status === 'unsupported') {
    return `<div class="live-msg">当前环境不支持后台线程，实时预览已停用（不影响正式解算）</div>`;
  }
  return `<div class="live-msg muted-t">策略将随公共牌 / 动作 / 参数选择自动刷新</div>`;
}
function liveBadgeHtml(key) {
  if (key === 'waiting') return { cls: 'waiting', text: '等对手' };
  if (key === 'closed') return { cls: 'closed', text: '已收口' };
  const map = { idle: '待命', queued: '排队', solving: '求解中', done: '已就绪', confirm: '待确认', error: '不可用', unsupported: '停用' };
  return { cls: livePreview.status, text: map[livePreview.status] || livePreview.status };
}
/* ---------- 决策面板（V1.10：实时策略预览与操作选项合二为一） ---------- */
/** 求解行动列表：已知 Hero 手牌时优先展示「该手牌」的条件频率（focus.strategy），否则为节点混合频率 */
function displayActs(res) {
  const acts = ((res && res.actions) || []).map(a => ({ ...a }));
  const fs = res && res.focus && res.focus.strategy;
  if (fs && fs.length === acts.length) acts.forEach((a, i) => { if (Number.isFinite(fs[i].freq)) a.freq = fs[i].freq; });
  return acts;
}
function statLookup(acts) {
  const m = { FOLD: null, CHECK: null, CALL: null, ALLIN: null, BET: [], RAISE: [] };
  for (const a of acts) {
    if (a.type === 'BET') m.BET.push(a);
    else if (a.type === 'RAISE') m.RAISE.push(a);
    else if (a.type in m) m[a.type] = a;
  }
  return m;
}
function pickStat(list, amt) {
  if (!list || !list.length || !Number.isFinite(amt)) return null;
  let best = null, d = Infinity;
  for (const x of list) {
    const dd = Math.abs((x.sizeBB != null ? x.sizeBB : (x.amount != null ? x.amount : 0)) - amt);
    if (dd < d) { d = dd; best = x; }
  }
  return d <= Math.max(0.6, Math.abs(amt) * 0.12) ? best : null;
}
/** 当前节点的统计上下文（仅实时决策模式且预览完成时存在） */
function statCtxOf(h, street, t) {
  if (!t || t.mode !== 'live') return null;
  const key = liveReqKey(h, street);
  if (!(livePreview.status === 'done' && livePreview.result && livePreview.key === key)) return null;
  const acts = displayActs(livePreview.result);
  return {
    acts,
    solveKey: livePreview.key,
    lookup: statLookup(acts),
    maxF: Math.max(0.0001, ...acts.map(a => a.freq))
  };
}
function acStatHtml(st, maxF) {
  if (!st) return '';
  const w = Math.max(4, Math.round((st.freq / (maxF || 1)) * 100));
  const best = st.freq >= maxF - 1e-9 && st.freq > 0;
  return `<span class="ac-stat ${best ? 'best' : ''}">
    <span class="ac-bar"><i style="width:${w}%"></i></span>
    <span class="ac-freq">${(st.freq * 100).toFixed(0)}%</span>
    <span class="ac-ev ${pnlCls(st.ev)}">${st.ev >= 0 ? '+' : ''}${fmt(st.ev)}</span>
    ${best ? '<span class="ac-rec">推荐</span>' : ''}
  </span>`;
}
/** 求解完成后把统计条补挂到已渲染的选项按钮上（不重建 DOM，避免打断输入焦点与滚动） */
function applyStatsToCards() {
  const grid = $('#decisionCards');
  if (!grid) return;
  const h = wizard && wizard.hand, street = h && actStreet(h);
  if (!h) return;
  const ctx = statCtxOf(h, street, liveTarget(h, street));
  if (!ctx) return;
  grid.querySelectorAll('[data-act="quickAction"]').forEach(btn => {
    if (btn.querySelector('.ac-stat')) return;
    const type = btn.dataset.v;
    const amt = btn.dataset.amt != null && btn.dataset.amt !== 'custom' ? Number(btn.dataset.amt) : NaN;
    let st = null;
    if (type === 'BET') st = pickStat(ctx.lookup.BET, amt);
    else if (type === 'RAISE_TO') st = pickStat(ctx.lookup.RAISE, amt);
    else if (type === 'CALL') st = ctx.lookup.CALL;
    else if (type === 'ALLIN') st = ctx.lookup.ALLIN;
    else if (type === 'FOLD') st = ctx.lookup.FOLD;
    else if (type === 'CHECK') st = ctx.lookup.CHECK;
    if (st) btn.insertAdjacentHTML('beforeend', acStatHtml(st, ctx.maxF));
  });
}
/** 决策面板：节点信息 + 状态/推荐解释 + 可点击选项（频率/EV 内联）合为一体 */
function decisionPanelHtml(h, street, live, toCall, flow) {
  const key = liveReqKey(h, street);
  const t = liveTarget(h, street);
  const badge = liveBadgeHtml(key);
  const closed = flow.closed && !ui.act.force;
  const actor = closed ? null : (nextActorFor(h, street) || flow.first);
  const actorName = actor ? (actorKey(h, actor) === 'HERO' ? 'Hero' : actorKey(h, actor) === 'VILLAIN' ? '对手' : String(actor)) : '—';
  const nodeLine = `${STREET_NAME[street] || street} · 底池 ${fmt(live.pot, 1)} BB · ${toCall > 0 ? `面对下注 ${fmt(toCall, 1)} BB` : '无人下注'}${actor ? ` · 轮到 ${esc(actorName)}` : ''}`;
  const modeTag = t.mode === 'review'
    ? `<span class="live-tag review">复盘 #${t.di + 1} · 当时局面</span>`
    : t.mode === 'waiting'
      ? `<span class="live-tag">等对手行动</span>`
      : t.mode === 'live' ? `<span class="live-tag">实时决策</span>` : '';
  const cards = closed
    ? streetDoneHtml(h, street, flow)
    : actionCardsHtml(h, live, toCall, street, flow, statCtxOf(h, street, t));
  return `<div class="card live-card decision-panel">
    <div class="card-title"><h2>决策面板</h2>
    <span class="live-badge ${badge.cls}" id="liveBadge">${badge.text}</span></div>
    <div class="dp-node">${nodeLine} ${modeTag}</div>
    <div class="live-body" id="liveBodyWrap">${liveBodyHtml(h, street)}</div>
    ${t.mode === 'review' && !closed ? '<div class="dp-sub">录入当前行动（不影响上方复盘）</div>' : ''}
    <div class="dp-cards" id="dpCards">${cards}</div>
    <div class="tiny muted" style="margin-top:6px">随每次选择即时重算（实时预览固定为教学档：目标 &lt;50 mbb/hand、预算 1.5 万次，仅供趋势反馈；正式结果以「开始解算」按所选收敛目标为准）。数据只读取当前录入内容，不写入也不覆盖已有数据。</div>
  </div>`;
}
/** 调度实时预览：debounce + 序号防竞态；只在新建向导第 2 步触发 */
function scheduleLivePreview() {
  const { name } = routeInfo();
  if (name !== 'new' || !wizard || wizard.step !== 2) return;
  const h = wizard.hand, street = actStreet(h);
  const key = liveReqKey(h, street);
  if (key === 'incomplete' || key === 'waiting' || key === 'closed') {
    // 无需求解的实时决策（选牌中 / 等对手 / 已收口）：直接刷新状态说明
    livePreview = { key, status: 'idle', result: null, pct: 0, error: '' };
    updateLiveBody();
    return;
  }
  // confirm 也必须短路：refresh() 会连续调度两次，第二次不得把「待确认」覆盖成自动重算
  if (key === livePreview.key && (livePreview.status === 'done' || livePreview.status === 'solving' || livePreview.status === 'queued' || livePreview.status === 'confirm')) return;
  // 剥削模式：仅模式/画像/强度变更需显式确认，避免「只切一下模式」就触发双路线重算
  const pp = `${h.mode}|${h.archetype}|${h.intensity}`;
  if (h.mode === 'exploit' && key !== livePreview.key && liveProfilePart && liveProfilePart !== pp) {
    livePreviewSeq++;
    livePreview = { key, status: 'confirm', result: null, pct: 0, error: '' };
    clearTimeout(livePreviewTimer);
    updateLiveBody();
    return; // 不更新 liveProfilePart：等用户点确认才受理新画像
  }
  // 参数已变化：立即作废旧 Worker 回调，防止旧结果在排队窗口内覆盖新 key
  livePreviewSeq++;
  livePreview = { key, status: 'queued', result: null, pct: 0.02, error: '' };
  liveProfilePart = pp;
  clearTimeout(livePreviewTimer);
  livePreviewTimer = setTimeout(() => runLivePreview(key), 220);
}
function runLivePreview(key) {
  if (livePreview.key !== key || !wizard) return;
  const h = wizard.hand, street = actStreet(h);
  const t = liveTarget(h, street);
  if (t.mode !== 'live' && t.mode !== 'review') { updateLiveBody(); return; }
  const req = buildSolveReq(h, t.di);
  // 实时预览固定按「教学/粗略」档停止（目标 <50 mbb），只作交互反馈；正式解算用用户选定档位
  req.iterations = 15000; req.preset = 'fast'; req.quality = 'teaching'; req.targetMbb = 50;
  const seq = ++livePreviewSeq;
  const finishWorker = () => { if (livePreviewWorker) { try { livePreviewWorker.terminate(); } catch (e) {} livePreviewWorker = null; } };
  if (typeof Worker === 'undefined') {
    livePreview = { key, status: 'unsupported', result: null, pct: 0, error: '' };
    render(); return;
  }
  finishWorker();
  let w;
  try { w = new Worker(new URL('./solver.worker.js?v=1.18.2', import.meta.url), { type: 'module' }); }
  catch (e) { finishWorker(); livePreview = { key, status: 'error', result: null, pct: 0, error: '无法启动后台线程' }; render(); return; }
  livePreviewWorker = w;
  w.onmessage = ev => {
    const m = ev.data || {};
    if (seq !== livePreviewSeq) return; // 过期结果丢弃
    if (m.type === 'progress') {
      if (livePreview.status !== 'done') {
        livePreview.status = 'solving'; livePreview.pct = m.pct;
        livePreview.mbb = m.exploitabilityMbb; livePreview.target = m.targetMbb;
        updateLiveBody();
      }
    } else if (m.type === 'result') {
      livePreview = { key, status: 'done', result: m.result, pct: 1, error: '' };
      finishWorker(); updateLiveBody();
    } else if (m.type === 'error') {
      livePreview = { key, status: 'error', result: null, pct: 0, error: m.message || '未知错误' };
      finishWorker(); updateLiveBody();
    }
  };
  w.onerror = () => { if (seq === livePreviewSeq) { livePreview = { key, status: 'error', result: null, pct: 0, error: '后台线程异常' }; finishWorker(); updateLiveBody(); } };
  w.postMessage({ type: 'solve', jobId: 'live-' + seq, req });
}
/** 仅刷新实时面板 DOM，避免整页 render 打断输入焦点 */
function updateLiveBody() {
  const h = wizard && wizard.hand, street = h && actStreet(h);
  if (!h) return;
  const wrap = $('#liveBodyWrap');
  if (!wrap) return;
  const key = liveReqKey(h, street);
  wrap.innerHTML = liveBodyHtml(h, street);
  const badge = $('#liveBadge');
  if (badge) {
    const b = liveBadgeHtml(key);
    badge.className = 'live-badge ' + b.cls;
    badge.textContent = b.text;
  }
  // 求解完成后选项档位需与推荐同源：仅在尺度来源变化时重建选项区（不打断输入焦点）
  const dpCards = $('#dpCards'), grid = dpCards && $('#decisionCards');
  if (dpCards && grid) {
    const ctx = statCtxOf(h, street, liveTarget(h, street));
    const wantKey = ctx ? ctx.solveKey : '';
    if ((grid.dataset.solveKey || '') !== wantKey) {
      const flow = actionFlow(h, street);
      const closed = flow.closed && !ui.act.force;
      const { live } = liveFor(h, street);
      const toCall = Math.max(0, Number(live.toCall) || 0);
      dpCards.innerHTML = closed ? streetDoneHtml(h, street, flow)
        : actionCardsHtml(h, live, toCall, street, flow, ctx);
    }
  }
  applyStatsToCards();
}
/** 停止实时预览（进入正式求解 / 离开向导时调用），不触碰持久化数据 */
function stopLivePreview() {
  clearTimeout(livePreviewTimer);
  livePreviewSeq++;
  if (livePreviewWorker) { try { livePreviewWorker.terminate(); } catch (e) {} livePreviewWorker = null; }
}

/* ---------- 行动卡片 ---------- */
function simpleActionCard(type, title, sub, dis, reason, statHtml = '', amt = null) {
  return `<button class="ac ac-${type.toLowerCase()}" ${dis ? 'disabled' : `data-act="quickAction" data-v="${type}"${amt != null ? ` data-amt="${amt}"` : ''}`}>
    <span class="ac-ic">${ACTION_ICON[type]}</span>
    <span class="ac-main"><b>${esc(title)}</b><span class="ac-sub">${dis ? '✕ ' + esc(reason) : esc(sub)}</span></span>
    ${statHtml || ''}
  </button>`;
}
function sizeActionCard(type, title, sub, opts, dis, reason, statFn = null) {
  if (dis) return simpleActionCard(type, title, '', true, reason);
  return `<div class="ac ac-size ac-${type.toLowerCase()}">
    <div class="ac-main"><b>${esc(title)}</b><span class="ac-sub">${esc(sub)}</span></div>
    <div class="ac-sizes">${opts.map(o => `<button class="sz" data-act="quickAction" data-v="${type}" data-amt="${o.amt}"><b>${fmt(o.amt, 1)}<i>BB</i></b><em>${o.label}</em>${statFn ? statFn(type, o.amt) : ''}</button>`).join('')}
      <button class="sz sz-custom" data-act="quickAction" data-v="${type}" data-amt="custom"><b>自定义</b></button></div>
  </div>`;
}
/** 本街已结束：不再展示行动卡片，也不点亮任何座位，直接给出下一步 */
function streetDoneHtml(h, street, flow) {
  const si = STREETS.indexOf(street);
  const nextSt = si < 3 ? STREETS[si + 1] : null;
  return `<div class="street-done ${flow.handOver ? 'over' : ''}">
    <div class="sd-hd"><span class="sd-ic">✓</span><div><b>${esc(flow.closedReason || '本街行动已结束')}</b>
      <div class="small muted">底池 ${fmt(flow.pot, 1)} BB · 本街已无待行动玩家；${nextSt && !flow.handOver ? `可进入${STREET_NAME[nextSt]}或直接解算` : '可直接解算'}</div></div></div>
    <div class="row" style="margin-top:10px">
      ${nextSt && !flow.handOver ? `<button class="btn primary" data-act="advanceStage">下一步：${STREET_NAME[nextSt]} →</button>` : ''}
      <button class="btn" data-act="beginSolve">开始解算 →</button>
      <button class="btn sm" data-act="forceAct">仍要在本街补录</button>
    </div></div>`;
}
/**
 * 操作选项展示规则（V1.9）：只展示当前局面下合法且有意义的选项，无效选项直接不渲染。
 *  - 面对下注/加注（toCall>0）：弃牌 / 跟注 / 加注至 / 全下 —— 无「过牌」「下注」
 *  - 无人下注（toCall=0）：过牌 / 下注 / 全下 —— 无「跟注」「加注」，可免费过牌时不提供「弃牌」
 * 尺度选项按当前局面计算，以具体 BB（加注至 X BB / 下注 X BB）展示。
 */
function actionCardsHtml(h, live, toCall, street, flow, statCtx = null) {
  if (flow.closed && !ui.act.force) return streetDoneHtml(h, street, flow);
  // 有效后手口径（V1.10）：用行动者真实剩余后手，而不是买入总额（后街全下 / 跟注金额必须落在后手以内）
  const eff = deriveState(h, (h.actions || []).length);
  const actor = nextActorFor(h, street) || flow.first;
  const aKey = actorKey(h, actor);
  const aSide = aKey === 'HERO' ? 'hero' : aKey === 'VILLAIN' ? 'villain' : null;
  const ownRem = Math.max(0, aSide && eff.rem ? (eff.rem[aSide] || 0) : (Number(eff.stack) || 0));
  const streetCur = aSide && eff.streetInv ? (eff.streetInv[aSide] || 0) : 0;
  const allinTo = Math.round((streetCur + ownRem) * 10) / 10; // ALLIN 的本街总投入目标
  const pot = Math.max(0.5, Number(live.pot) || 1);
  const facing = toCall > 0;
  const preflop = street === 'PREFLOP';
  const callAmt = Math.round(Math.min(toCall, ownRem) * 10) / 10;
  const callAllin = ownRem > 0.5 && callAmt >= ownRem - 0.05;
  const stat = (type, amt) => statCtx ? acStatHtml(
    type === 'BET' ? pickStat(statCtx.lookup.BET, amt) :
    type === 'RAISE_TO' ? pickStat(statCtx.lookup.RAISE, amt) :
    statCtx.lookup[type] || null, statCtx.maxF) : '';
  const out = [], notes = [];
  if (preflop && facing) {
    // 翻前面对大盲 / 加注，规则上不存在过牌；只有大盲期权（待跟注额为 0）时才出现
    notes.push('翻前面对大盲 / 加注时没有「过牌」选项（对手已下注，此时不能过牌），只能弃牌、跟注或加注。');
  }
  if (facing) {
    notes.push(`面对下注 / 加注：不提供「过牌」「下注」；加注按当前局面计算，以「加注至 X BB」展示具体尺度。`);
    out.push(simpleActionCard('FOLD', '弃牌', '放弃本手，已投入的筹码不收回', false, '', stat('FOLD')));
    out.push(simpleActionCard('CALL', `跟注 ${fmt(callAmt, 1)}${callAllin ? '（全下）' : ''}`,
      `投入 ${fmt(callAmt, 1)} BB 匹配对手下注${callAllin ? ' · 后手全部押入' : ''}`, ownRem <= 0.05, '后手不足', stat('CALL'), callAmt));
    const minTo = Math.max(0, Number(live.highest) || 0) + Math.max(1, Number(live.lastRaise) || 1);
    // 加注仅在有合法加注空间时提供：对手已全下 / 后手不足以最小加注时，只剩弃牌与跟注
    const canRaise = ownRem > toCall + 0.5 && allinTo + 1e-6 >= minTo;
    if (canRaise) {
      // 尺度与「为什么推荐」同源：实时预览已完成时直接用求解器动作里的加注至金额
      const solveOpts = statCtx ? solverSizeOptions(statCtx.acts, 'RAISE', allinTo, minTo) : null;
      out.push(sizeActionCard('RAISE_TO', '加注至', `面对 ${fmt(Number(live.highest) || 0, 1)} BB · 最小加注至 ${fmt(minTo, 1)} BB`, solveOpts || raiseSizes(live, allinTo), false, '', stat));
    }
    else notes.push('对手已全下或你的后手不足以最小加注：当前只有「弃牌 / 跟注」两个选项。');
  } else {
    notes.push('无人下注：不提供「跟注 / 加注」；可免费过牌时「弃牌」无意义，也不提供。');
    const bbOption = preflop && (h.actions || []).some(a => String(a.street).toUpperCase() === 'PREFLOP' && a.type === 'CALL');
    out.push(simpleActionCard('CHECK', bbOption ? '过牌（大盲期权）' : '过牌',
      bbOption ? '无人再加注，保留大盲期权直接看翻牌' : '不投入，把行动权交给对手', false, '', stat('CHECK')));
    const betTitle = preflop ? '加注（大盲期权）' : '下注';
    // 与加注同理：有求解结果时优先用求解器的下注尺度，保证与推荐文案一致
    const solveBet = statCtx ? solverSizeOptions(statCtx.acts, 'BET', ownRem, 0.9) : null;
    out.push(sizeActionCard('BET', betTitle,
      preflop ? `主动加注 · 底池 ${fmt(pot, 1)} BB，按求解尺度给出加注额` : `主动下注 · 底池 ${fmt(pot, 1)} BB，按求解尺度给出下注额`,
      solveBet || betSizes(live, ownRem), ownRem <= 0.5, '后手不足', stat));
  }
  if (ownRem > 0.5 && (!facing || ownRem > toCall + 0.5)) {
    out.push(simpleActionCard('ALLIN', `全下 ${fmt(allinTo, 1)}`,
      `投入全部后手 ${fmt(ownRem, 1)} BB（本街总投入 ${fmt(allinTo, 1)} BB）`, false, '', stat('ALLIN'), allinTo));
  }
  return `<div class="ac-grid" id="decisionCards" data-solve-key="${statCtx ? esc(statCtx.solveKey) : ''}">${out.join('')}</div>
    ${notes.map(n => `<div class="ac-note">${esc(n)}</div>`).join('')}
    ${ui.act.force ? `<div class="notice" style="margin-top:8px">手动补录模式：当前行动者 <b>${esc(nextActorFor(h, street) || '—')}</b>。
      <button class="btn sm" data-act="cancelForce">恢复自动顺位</button></div>` : ''}`;
}

/* ---------- 行动时间线 ---------- */
function timelineHtml(h, idxs, di) {
  const acts = h.actions || [];
  const pend = pendingHeroDecision(h);
  if (!acts.length && !pend) return '<div class="empty">还没有录入行动 · 点击上方卡片即录入一条</div>';
  // 违规行动标注：状态机检出的不合逻辑行动（下注未被回应 / 收口后又行动 / 已弃牌又行动）
  const badMap = new Map();
  for (const e of validateHand(h).errors || []) {
    const m = String(e.path || '').match(/^actions\[(\d+)\]$/);
    if (m) badMap.set(Number(m[1]), e.msg);
  }
  const banner = badMap.size
    ? `<div class="notice danger">⚠ 行动流有 <b>${badMap.size}</b> 处不合逻辑（见红色标注）：${esc([...badMap.values()][0])}${badMap.size > 1 ? ' 等' : ''}。点对应行动修正或删除后再解算。</div>`
    : '';
  return banner + STREETS.map(st => {
    const items = acts.map((a, i) => ({ a, i })).filter(x => String(x.a.street).toUpperCase() === st);
    const pendHere = pend && pend.street === st;
    if (!items.length && !pendHere) return '';
    const pendHtml = pendHere ? `<button class="tl-pill pending-hero ${pend.index === di ? 'on' : ''}" data-act="setPendingDecision" data-v="${pend.index}" title="牌谱停在对手下注：这是 Hero 尚未应对的决策点，点此设为解算点">
        <span class="no">下一步</span><span class="who">HERO</span><span class="what">待应对 ${fmt(pend.toCall, 1)} BB</span><span class="flag">决策点</span>
      </button>` : '';
    return `<div class="tl-street"><div class="tl-hd"><b>${STREET_NAME[st]}</b><span class="tiny muted">${items.length} 条${pendHere ? ' · 1 待决策' : ''}</span></div>
      <div class="tl-row">${items.map(({ a, i }) => {
        const isDecision = idxs.includes(i);
        const bad = badMap.has(i);
        const side = actorKey(h, a.actor) === 'HERO' ? 'hero' : actorKey(h, a.actor) === 'VILLAIN' ? 'villain' : 'other';
        return `<button class="tl-pill ${side} ${a.type === 'FOLD' ? 'fold' : ''} ${a.auto ? 'auto' : ''} ${bad ? 'bad' : ''} ${i === di ? 'on' : ''} ${ui.act.flash && ui.act.flash.idx === i ? 'flash' : ''}" data-act="editAction" data-v="${i}" title="${bad ? esc(badMap.get(i)) : '点击编辑 / 删除 / 设为决策点'}">
          <span class="no">#${i + 1}</span><span class="who">${esc(a.actor)}</span><span class="what">${ACTION_LABEL[a.type] || a.type}</span>
          ${a.amountBB != null ? `<b>${fmt(a.amountBB, 1)}</b>` : ''}
          ${a.auto ? '<span class="flag auto">默认</span>' : ''}${isDecision ? '<span class="flag">决策点</span>' : ''}${bad ? '<span class="flag bad">⚠ 不合逻辑</span>' : ''}
        </button>`;
      }).join('')}${pendHtml}</div></div>`;
  }).join('');
}

/* ---------- 就绪度 ---------- */
function readinessStrip(rd) {
  const keys = ['heroCards', 'board', 'headsUp', 'actions', 'positions'];
  const items = rd.items.filter(i => keys.includes(i.key));
  return `<div class="rd-strip">${items.map(i => `<button class="rd ${i.ok ? 'ok' : 'ng'}" data-act="showReadiness"><span>${i.ok ? '✓' : '✕'}</span>${esc(i.label)}</button>`).join('')}
    ${rd.ready ? '' : '<button class="rd ng more" data-act="showReadiness">查看还差什么 →</button>'}</div>`;
}
function firstBlocking(rd) {
  const b = rd.items.find(i => !i.ok);
  return b ? b.label + (b.hint ? `（${b.hint}）` : '') : '';
}

function wizardStep2(h, di, v, rd) {
  const idxs = heroDecisionIndices(h);
  const street = actStreet(h);
  const si = STREETS.indexOf(street);
  const acts = h.actions || [];
  const { live, f: flow } = liveFor(h, street);
  const closed = flow.closed && !ui.act.force;
  const actor = closed ? null : (nextActorFor(h, street) || flow.first);
  const toCall = Math.max(0, Number(live.toCall) || 0);
  const actorSideName = actorKey(h, actor) === 'HERO' ? 'Hero' : actorKey(h, actor) === 'VILLAIN' ? '对手' : '其他位置';
  const boardNeed = stageBoardCount(street);
  const boardNow = (h.board || []).filter(c => c != null).length;
  const heroPos = String(h.positions.hero || '').toUpperCase();
  const villainPos = String(h.positions.villain || '').toUpperCase();
  const usedAliases = [...new Set(acts.map(a => String(a.actor).toUpperCase()).filter(x => x === 'HERO' || x === 'VILLAIN'))];
  const actorOptions = [...new Set([heroPos, villainPos, ...usedAliases])];
  const otherPos = positionsFor(h.tableSize).filter(p => p !== heroPos && p !== villainPos);
  const stageNav = STREETS.map((st, i) => {
    const need = stageBoardCount(st);
    const done = i > 0 && boardNow >= need;
    return `<button class="stage ${st === street ? 'on' : ''}" data-act="setStreet" data-v="${st}">
      <b>${['①', '②', '③', '④'][i]} ${STREET_NAME[st]}</b>
      <span>${need === 0 ? '无需公共牌' : `需 ${need} 张公共牌`}${done ? ' ✓' : ''}</span></button>`;
  }).join('');
  const nextSt = si < 3 ? STREETS[si + 1] : null;

  return `<div class="card"><div class="card-title"><h2>③ 选择行动</h2><span class="tiny muted">已录入 ${acts.length} 条 · 点卡片即录入</span></div>
    ${readinessStrip(rd)}
    ${exploitBarHtml(h)}
    <div class="stage-nav">${stageNav}</div>
    <div class="stage-actions">
      ${nextSt ? `<button class="btn primary" data-act="advanceStage">下一步：${STREET_NAME[nextSt]} →</button>` : '<span class="tiny muted">已到河牌，可直接解算</span>'}
      ${si > 0 && boardNow < boardNeed ? `<button class="btn sm" data-act="solveStreet" data-v="${STREETS[si - 1]}" title="切换回上一街并解算该街的 Hero 决策">先解算${STREET_NAME[STREETS[si - 1]]}</button>` : ''}
      <button class="btn sm" data-act="toggleParams">${wizard.paramsOpen ? '收起求解参数' : '求解参数（范围 / 尺度 / 剥削画像）'}</button>
      <span class="tiny muted">当前阶段：${STREET_NAME[street]}</span>
    </div>
    <div class="turn-bar ${closed ? 'is-closed' : ''}">
      <div class="turn-who">
        ${closed
          ? `<span class="turn-label">本街状态</span><b class="side-done">已结束</b><span class="tiny muted">${esc(flow.closedReason)}</span>`
          : `<span class="turn-label">轮到行动</span><b class="side-${actorKey(h, actor) === 'HERO' ? 'hero' : 'villain'}">${esc(actor)}</b><span class="tiny muted">${actorSideName}</span>`}
      </div>
      <div class="turn-nums">
        <div><span>待跟注</span><b>${fmt(toCall, 1)}</b></div>
        <div><span>最小加注至</span><b>${fmt((Number(live.highest) || 0) + Math.max(1, Number(live.lastRaise) || 1), 1)}</b></div>
        <div><span>后手</span><b>${fmt(h.stackBB, 1)}</b></div>
      </div>
      <label class="field turn-pick"><span>换人</span><select data-act="setActor">${actorOptions.map(x => `<option value="${x}" ${x === actor ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
      ${ui.act.actor ? '<button class="btn sm" data-act="resetActor">自动顺位</button>' : ''}
    </div>
    ${tableHtml(h, street, actor, live)}
    ${decisionPanelHtml(h, street, live, toCall, flow)}
    ${closed ? '' : `<details class="adv-amt"><summary>自定义金额（可选）</summary>
      <div class="row" style="margin-top:6px"><input type="number" id="naAmount" step="0.1" min="0" placeholder="输入 BB 数，然后点上方「自定义」">
      <span class="tiny muted">用于「下注 / 加注」的「自定义」按钮；留空则采用卡片上的建议值。</span></div>
    </details>`}
  </div>
  <div class="card"><div class="card-title"><h2>动作时间线</h2><span class="tiny muted">点任意一条可编辑 / 删除 / 设为决策点</span></div>
    ${timelineHtml(h, idxs, di)}
    <div class="auto-fold-note">其余 ${otherPos.length} 个位置（${esc(otherPos.join(' / '))}）已按第 1 步的位置设定<b>默认翻前弃牌</b>，无需逐一录入；仅 ${esc(heroPos)}（Hero）与 ${esc(villainPos)}（对手）参与行动。</div>
    <div class="row" style="margin-top:10px">
      <button class="btn sm" data-act="undoAction" ${acts.length ? '' : 'disabled'}>↶ 撤销末条</button>
      <button class="btn sm" data-act="clearActions" ${acts.length ? '' : 'disabled'}>清空</button>
      <button class="btn sm" data-act="foldToHero" title="把其它位置的翻前弃牌显式写入行动流（用于导出 HH）">补录其它位置弃牌（可选）</button>
      <button class="btn sm" data-act="toggleBulk">${ui.act.bulk ? '收起批量录入' : '批量粘贴录入'}</button>
      <button class="btn sm" data-act="loadExampleActions">填充标准示例</button>
    </div>
    ${ui.act.bulk ? `<div class="bulk-box"><div class="small muted">每行一条街，逗号分隔动作；支持中英文动作名，金额可省略（自动按状态机补齐）。公共牌请在对应街阶段录入。</div>
      <textarea id="bulkActions" rows="6" spellcheck="false" placeholder="Preflop: UTG fold, BTN raise 5, BB call 5&#10;Flop: BB check, BTN bet 3.3, BB call">${esc(wizard.bulkText || '')}</textarea>
      <div class="row" style="margin-top:8px"><button class="btn sm" data-act="bulkLoadExample">载入示例</button><button class="btn primary sm" data-act="bulkParse">解析并替换行动流</button></div>
      ${wizard.bulkInfo ? `<div class="${wizard.bulkInfo.ok ? 'notice info' : 'notice danger'}" style="margin-top:8px">${esc(wizard.bulkInfo.msg)}</div>` : ''}</div>` : ''}
  </div>
  <div class="card"><h2>决策点</h2><div class="small muted">复盘的是「Hero 在该节点应该怎么打」。默认取当前阶段最后一个 Hero 动作；该街尚未行动时直接解算当前局面。</div>
    <div class="row" style="margin-top:8px">${idxs.length ? idxs.map(i => `<button class="chip ${i === di ? 'on' : ''}" data-act="setDecision" data-v="${i}">#${i + 1} ${esc(formatAction(h.actions[i]))}</button>`).join('') : '<span class="small muted">该阶段尚未录入 Hero 动作 · 可直接解算「还没行动的这一步」</span>'}</div>
  </div>
  <div class="card"><h2>状态校验</h2>
    ${v.errors.length ? `<div class="notice danger">${v.errors.map(e => esc(e.path + '：' + e.msg)).join('<br>')}</div>` : '<div class="notice info">行动流校验通过</div>'}
    ${v.warnings.length ? `<div class="notice" style="margin-top:8px">${v.warnings.map(esc).join('<br>')}</div>` : ''}
    <div class="small muted" style="margin-top:8px">当前局面：底池 ${fmt(live.pot ?? v.computedPotBB, 1)} BB · 待跟注 ${fmt(toCall, 1)} BB；行动流推算底池 ${fmt(v.computedPotBB, 1)} BB（含盲注）。</div>
  </div>
  ${wizard.paramsOpen ? wizardStep3(h) : ''}`;
}

/* ---------- 行动编辑弹窗 ---------- */
function openActionEditor(i) {
  const h = wizard.hand, a = (h.actions || [])[i];
  if (!a) return;
  const idxs = heroDecisionIndices(h);
  const canDecision = idxs.includes(i);
  openModal(`<h2>编辑 #${i + 1}</h2>
    <div class="small muted">${STREET_NAME[String(a.street).toUpperCase()]} · ${esc(a.actor)} · ${ACTION_LABEL[a.type] || a.type}</div>
    ${['CALL', 'BET', 'RAISE_TO', 'ALLIN'].includes(a.type)
      ? `<label class="field" style="margin-top:10px"><span>金额 (BB)</span><input type="number" step="0.1" min="0" id="editAmt" value="${a.amountBB ?? ''}" placeholder="留空按状态机推算"></label>`
      : '<div class="tiny muted" style="margin-top:8px">该动作无需金额。</div>'}
    <div class="row" style="margin-top:12px">
      <button class="btn primary" data-act="saveAction" data-v="${i}">保存</button>
      ${canDecision ? `<button class="btn" data-act="setDecision" data-v="${i}" data-close="1">设为决策点</button>` : '<span class="tiny muted">仅 Hero 在当前阶段的动作可作决策点</span>'}
      <button class="btn danger" data-act="delAction" data-v="${i}">删除</button>
      <button class="btn ghost" data-act="closeModal">取消</button>
    </div>`);
}

/* ---------- 就绪度弹窗 ---------- */
function openReadiness(rd) {
  openModal(`<h2>${rd.ready ? '可以解算了' : '还差几步'}</h2>
    <div class="rd-list">${rd.items.map(it => `<div class="rd-item ${it.ok ? 'ok' : 'ng'}">
      <span class="ic">${it.ok ? '✓' : '✕'}</span>
      <div class="tx"><b>${esc(it.label)}</b>${it.hint ? `<span>${esc(it.hint)}</span>` : ''}</div>
      ${it.ok ? '' : `<button class="btn sm" data-act="goStep" data-v="${it.step}">去修正</button>`}
    </div>`).join('')}</div>
    <div class="row end" style="margin-top:12px"><button class="btn" data-act="closeModal">知道了</button>
    ${rd.ready ? '<button class="btn primary" data-act="beginSolve">开始解算 →</button>' : ''}</div>`);
}
function beginSolve() {
  if (!wizard) return;
  const rd = solveReadiness(wizard.hand, wizard.stage);
  if (!rd.ready) { openReadiness(rd); return; }
  stopLivePreview();
  submitSolve(wizard.hand, selectedDecisionIndex(wizard.hand));
}
function sizeChips(h) {
  const presets = [[0.33, '33%'], [0.5, '50%'], [0.67, '67%'], [1, '满池'], [1.33, '超池']];
  return presets.map(([v, n]) => `<button class="chip ${h.sizes.includes(v) ? 'on' : ''}" data-act="toggleSize" data-v="${v}">${n}</button>`).join('');
}
/* 剥削输入常驻条：第 3 步默认可见，不再藏在「求解参数」折叠面板里 */
function exploitBarHtml(h) {
  const modeChips = `<div class="chips"><button class="chip ${h.mode === 'gto' ? 'on' : ''}" data-act="setMode" data-v="gto">标准 GTO</button><button class="chip ${h.mode === 'exploit' ? 'on' : ''}" data-act="setMode" data-v="exploit">剥削模式</button></div>`;
  const detail = h.mode !== 'exploit' ? '' : `<div class="exploit-row"><span class="tiny muted">对手画像</span><div class="chips">${ARCHETYPES.map(a => `<button class="chip ${h.archetype === a.id ? 'on' : ''}" data-act="setArchetype" data-v="${a.id}">${a.name} ${a.tag}</button>`).join('')}</div></div>
    <div class="exploit-row"><span class="tiny muted">强度</span><div class="chips">${[[0.5, '轻度'], [1, '中度'], [1.5, '重度']].map(([v, n]) => `<button class="chip ${Number(h.intensity) === v ? 'on' : ''}" data-act="setIntensity" data-v="${v}">${n}</button>`).join('')}</div></div>
    <div class="tiny muted" style="margin-top:6px">画像通过节点锁定求 Hero 最优应对；对手范围已按行动收窄时，松型画像不会再放宽范围。</div>`;
  return `<div class="exploit-bar"><div class="row between"><div class="small"><b>求解模式</b><span class="tiny muted"> · ${h.mode === 'exploit' ? '剥削（对手画像）' : '标准 GTO'}</span></div>${modeChips}</div>${detail}</div>`;
}
function wizardStep3(h) {
  return `<div class="card"><h2>对手范围与求解参数</h2>
    <div class="grid g2">
      <label class="field"><span>Hero 范围模板</span><select data-range-preset="hero">${RANGE_PRESETS.map(p => `<option value="${p.id}" ${h.rangePresets.hero === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
      <label class="field"><span>Villain 范围模板</span><select data-range-preset="villain">${RANGE_PRESETS.map(p => `<option value="${p.id}" ${h.rangePresets.villain === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
    </div>
    <div class="small muted" style="margin-top:8px">自定义范围矩阵（点击格子循环：0 → 50% → 100%）</div>
    <div class="row" style="margin:6px 0"><button class="chip on" id="rangeSideHero" data-act="rangeSide" data-v="hero">Hero 矩阵</button><button class="chip" id="rangeSideVillain" data-act="rangeSide" data-v="villain">Villain 矩阵</button></div>
    <div id="rangeGrid">${rangeGridHtml(h.ranges.hero)}</div>
    <div class="hr"></div>
    <div class="small muted">下注尺度集合（每街 ≤ 4 个）</div><div class="chips" style="margin-top:6px">${sizeChips(h)}</div>
    <label class="field" style="margin-top:8px"><span>自定义尺度（逗号分隔底池倍数，如 0.25,0.75）</span><input type="text" data-bind="customSizes" value="${esc((h.customSizes || []).join(','))}" placeholder="留空则使用上方预设"></label>
    <label class="check"><input type="checkbox" data-bind="allowCheckRaise" ${h.allowCheckRaise ? 'checked' : ''}>允许过牌加注 Check-Raise</label>
    <div class="grid g2" style="margin-top:6px">
      <label class="field"><span>收敛目标（停止指标）</span><select data-bind="quality">${Object.values(CONVERGENCE_TARGETS).map(t => `<option value="${t.id}" ${(h.quality || 'daily') === t.id ? 'selected' : ''}>${esc(t.label)} · &lt;${t.targetMbb} mbb（预算 ${t.maxIterations.toLocaleString('en-US')} 次）</option>`).join('')}</select>
        <span class="tiny muted" style="display:block;margin-top:4px">${esc((CONVERGENCE_TARGETS[h.quality || 'daily'] || CONVERGENCE_TARGETS.daily).hint)}</span></label>
      <label class="field"><span>当前底池覆盖 (BB，留空用推算值)</span><input type="number" step="0.1" min="0.1" data-bind="potOverrideBB" value="${esc(h.potOverrideBB ?? '')}" placeholder="自动推算"></label>
      <label class="field"><span>有效后手覆盖 (BB)</span><input type="number" step="1" min="1" data-bind="stackOverrideBB" value="${esc(h.stackOverrideBB ?? '')}" placeholder="自动推算"></label>
    </div>
  </div>
  <div class="card"><h2>求解模式</h2>
    <div class="chips"><button class="chip ${h.mode === 'gto' ? 'on' : ''}" data-act="setMode" data-v="gto">标准 GTO</button><button class="chip ${h.mode === 'exploit' ? 'on' : ''}" data-act="setMode" data-v="exploit">剥削模式（对手画像）</button></div>
    ${h.mode === 'exploit' ? `<div class="hr"></div><div class="small muted">对手画像（附录 D 预设节点锁定）</div><div class="chips" style="margin-top:6px">${ARCHETYPES.map(a => `<button class="chip ${h.archetype === a.id ? 'on' : ''}" data-act="setArchetype" data-v="${a.id}">${a.name} ${a.tag}</button>`).join('')}</div>
      <div class="small muted" style="margin-top:8px">强度档</div><div class="chips" style="margin-top:6px">${[[0.5, '轻度'], [1, '中度'], [1.5, '重度']].map(([v, n]) => `<button class="chip ${Number(h.intensity) === v ? 'on' : ''}" data-act="setIntensity" data-v="${v}">${n}</button>`).join('')}</div>
      <div class="tiny muted" style="margin-top:8px">口径：按所选画像冻结对手策略后求 Hero 最优应对；画像参数变化时结果需重算。</div>` : ''}
  </div>`;
}
function rangeGridHtml(matrix) {
  let html = '<div class="range-wrap"><div class="range-grid"><div class="hdr"></div>';
  for (let j = 12; j >= 0; j--) html += `<div class="hdr">${RANKS[j]}</div>`;
  for (let i = 12; i >= 0; i--) {
    html += `<div class="hdr">${RANKS[i]}</div>`;
    for (let j = 12; j >= 0; j--) {
      const v = matrix[i][j] || 0;
      const c = v <= 0.02 ? '#f3f4f7' : v < 0.55 ? '#c9d4f7' : '#3b5bdb';
      const col = v >= 0.55 ? '#fff' : '#26303f';
      html += `<div class="cell" style="background:${c};color:${col}" data-act="rangeCell" data-i="${i}" data-j="${j}" title="${classLabel(i, j)}: ${Math.round(v * 100)}%">${classLabel(i, j)}</div>`;
    }
  }
  return html + '</div></div>';
}
function statLine(k, v) { return `<div class="stat-line"><span class="muted">${esc(k)}</span><span>${esc(v)}</span></div>`; }

/* ---------------- 结果页 ---------------- */
function renderResult(id) {
  const job = state().jobs.find(j => j.id === id);
  if (!job) { app.innerHTML = '<div class="card"><div class="empty">求解任务不存在或已被清理</div></div>'; return; }
  if (job.status === 'queued' || job.status === 'running') {
    app.innerHTML = `<div class="page-head"><div><h1>求解中</h1><p class="sub">任务队列：同一时间仅运行 1 个求解任务</p></div></div>
      <div class="card"><div class="row between"><h2>${esc(job.mode === 'exploit' ? '剥削求解' : 'GTO 均衡求解')}</h2><span class="pill">${esc(job.status === 'queued' ? '排队中' : '运行中')}</span></div>
      <div id="solveProgress">${progressHtml(job)}</div></div>
      <div class="notice">求解范围：翻前近似 / 翻后单挑；无抽水；结果为近似解。超过 60 秒可继续留在页面等待，结果会自动刷新。</div>`;
    return;
  }
  if (job.status === 'failed') {
    app.innerHTML = `<div class="card"><h2>求解失败</h2><div class="notice danger">${esc(job.error || '未知错误')}</div>
      <div class="row" style="margin-top:10px"><button class="btn" data-act="go" data-v="new">返回录入</button><button class="btn primary" data-act="rerunJob" data-id="${esc(job.id)}">重新求解</button></div></div>`;
    return;
  }
  const r = job.result;
  const h = state().hands.find(x => x.id === job.handId) || defaultHand();
  const tab = ui.resTab || (r.mode === 'exploit' ? 'exploit' : 'gto');
  const shown = tab === 'gto' && r.gtoActions ? { ...r, actions: r.gtoActions, evLossBB: r.gtoEvLossBB, mode: 'gto' } : r;
  // 主表按「你的手牌」条件频率展示（与决策面板同源）；EV 仍为动作在全范围下的平均值
  const handFreq = shown.focus?.strategy?.length === shown.actions.length ? shown.focus.strategy.map(s => s.freq) : null;
  const shownActions = shown.actions.map((a, i) => handFreq ? { ...a, freq: handFreq[i], rangeFreq: a.freq } : a);
  const maxFreq = Math.max(0.0001, ...shownActions.map(a => a.freq));
  const topAction = shownActions.slice().sort((a, b) => b.freq - a.freq)[0];
  const deepAllInCaution = topAction && topAction.type === 'ALLIN' && Number(shown.stacks || shown.stack || 0) >= 150
    && Number(topAction.sizeBB != null ? topAction.sizeBB : shown.stacks) > Number(shown.pot || 0) * 2;
  const bestEV = Math.max(...shown.actions.map(a => a.ev));
  const convTarget = r.targetMbb != null ? r.targetMbb : 1;
  const convTargetText = convTarget < 1 ? fmt(convTarget, 1) : String(Math.round(convTarget));
  const convInvalid = r.exploitabilityMbb === 0;
  const convReached = !!r.converged || (r.exploitabilityMbb > 0 && r.exploitabilityMbb <= convTarget);
  const convScope = r.nashConvScope === 'gto-reference' ? '均衡基线（剥削路线非均衡，NashConv 不适用）' : '均衡解';
  const convStatus = convInvalid
    ? '≈0 为近似模型的测量下限，无法可靠判定收敛；结果仅供趋势参考'
    : convReached ? '✓ 已达到目标，可停止；混合频率与价值/诈唬比例可用于复盘'
      : '尚未达到目标；迭代已到预算上限，结果为近似趋势，不宜抠混合频率';
  const idxs = heroDecisionIndices(h);
  const pend = pendingHeroDecision(h);
  app.innerHTML = `
  <div class="page-head"><div><h1>求解结果</h1><p class="sub">${esc(r.decisionNode || '')} · 底池 ${fmt(r.pot, 1)} BB · 后手 ${fmt(r.stacks, 1)} BB</p></div>
    <div class="row"><button class="btn sm" data-act="resCopy" data-id="${esc(job.id)}">复制牌谱</button><button class="btn sm" data-act="resPNG" data-id="${esc(job.id)}">导出图片</button></div></div>
  ${r.phase === 'preflop' ? '<div class="notice info">翻前近似解：基于起手牌范围对抗权益分档 + 街内 CFR，蒙特卡洛补全 5 张公共牌；未展开翻后博弈树，不等同商用 Solver 的翻前解，仅供范围对抗参考。</div>' : ''}
  <div class="tabs">
    <button class="${tab === 'gto' ? 'on' : ''}" data-act="resTab" data-v="gto" data-id="${esc(job.id)}">GTO 均衡</button>
    ${r.gtoActions ? `<button class="${tab === 'exploit' ? 'on' : ''}" data-act="resTab" data-v="exploit" data-id="${esc(job.id)}">剥削路线</button>` : ''}
  </div>
  <div class="card"><h2>行动回放与决策点</h2><div class="action-list">
    ${(h.actions || []).length ? h.actions.map((a, i) => `<div class="action-item ${idxs.includes(i) ? 'click' : ''} ${i === job.params.decisionIndex ? 'on' : ''}" ${idxs.includes(i) ? `data-act="resDecision" data-id="${esc(job.id)}" data-v="${i}"` : ''}>
      <span class="st">${esc(String(a.street).slice(0, 4))}</span><span class="ac">${esc(formatAction(a))}</span>${i === job.params.decisionIndex ? '<span class="tag">当前</span>' : ''}</div>`).join('') : '<div class="empty">无行动记录</div>'}
    ${pend ? `<div class="action-item click ${pend.index === job.params.decisionIndex ? 'on' : ''}" data-act="resDecision" data-id="${esc(job.id)}" data-v="${pend.index}">
      <span class="st">下一步</span><span class="ac">Hero 待应对 ${fmt(pend.toCall, 1)} BB</span>${pend.index === job.params.decisionIndex ? '<span class="tag">当前</span>' : ''}</div>` : ''}
  </div><div class="tiny muted" style="margin-top:6px">点击 Hero 决策可切换复盘节点（重新求解）</div></div>
  <div class="card"><div class="card-title"><h2>${tab === 'exploit' ? '剥削路线输出' : '均衡输出'}</h2><span class="pill">EV 单位：BB</span></div>
    <div class="tiny muted" style="margin-bottom:6px">频率按你的手牌 ${shown.focus ? esc(shown.focus.cards.join(' ')) : ''} 的条件策略；EV 为全范围动作平均值。</div>
    ${deepAllInCaution ? '<div class="notice" style="margin-bottom:8px">风险提示：主推深码超底池全下，需对手大量弃牌才成立；模型为近似结果，实盘慎用。</div>' : ''}
    <div class="table-wrap"><table class="ev-table"><thead><tr><th>动作</th><th class="num">${tab === 'exploit' ? '剥削频率' : '均衡频率'}</th><th class="num">动作 EV</th><th>标签</th></tr></thead><tbody>
      ${shownActions.map((a, i) => {
        const badge = a.freq >= 0.66 ? '<span class="badge hi">高频</span>' : a.freq >= 0.33 ? '<span class="badge mid">混合</span>' : a.freq > 0 ? '<span class="badge lo">低频</span>' : '<span class="badge zero">零频率</span>';
        return `<tr class="${a.ev >= bestEV - 1e-9 ? 'hl' : ''}"><td>${esc(a.label || a.type)}${a.sizeBB != null && !String(a.label || '').includes(' BB') ? ` <span class="tiny muted">${fmt(a.sizeBB, 1)} BB</span>` : ''}</td>
          <td class="num">${(a.freq * 100).toFixed(1)}%<div class="bar" style="margin-top:3px"><i style="width:${(a.freq / maxFreq * 100).toFixed(0)}%"></i></div></td>
          <td class="num ${a.ev >= 0 ? 'up' : 'down'}">${fmt(a.ev)}</td><td>${badge}</td></tr>`;
      }).join('')}
    </tbody></table></div>
    <div class="hr"></div>
    <div class="conv-summary ${convReached ? 'reached' : ''}">
      <div class="conv-main"><span class="conv-label">可剥削度 NashConv</span>
        <b class="conv-val">${r.exploitabilityMbb == null ? '—' : (convInvalid ? '≈0' : fmt(r.exploitabilityMbb, 1))}</b><span class="conv-unit">mbb/hand</span></div>
      <div class="conv-meta">目标 <b>&lt; ${convTargetText}</b> mbb/hand · mbb = 千分之一大盲 / 手 · 口径：${esc(convScope)}</div>
      <div class="conv-status">${convStatus}</div>
      <div class="tiny muted" style="margin-top:5px">迭代 ${Number(r.iterations || 0).toLocaleString('en-US')} 次${r.iterationsExploit ? ` + 剥削 ${Number(r.iterationsExploit).toLocaleString('en-US')} 次` : ''}（辅助信息） · 耗时 ${r.durationMs || 0} ms</div>
    </div>
    <div class="grid g2">
      ${statLine('推荐主行动', shownActions.slice().sort((a, b) => b.freq - a.freq)[0]?.label || '—')}
      ${statLine('最优动作 EV', fmt(bestEV) + ' BB')}
      ${statLine('实现 EV 差', shown.evLossBB != null ? fmt(shown.evLossBB) + ' BB' : '未录入实际动作（隐藏）')}
      ${statLine('收敛档位', esc((CONVERGENCE_TARGETS[r.quality] || CONVERGENCE_TARGETS.daily).label))}
      ${statLine('迭代预算', Number(r.maxIterations || r.iterations || 0).toLocaleString('en-US') + ' 次（仅上限，不作有效性判据）')}
      ${statLine('树规模', (r.treeSize || '—') + ' 节点')}
    </div>
    ${shown.focus ? `<div class="hr"></div><h3>你的手牌 ${esc(shown.focus.cards.join(' '))}（牌力档 ${shown.focus.bucket}）</h3><div class="small muted">该手牌对 Villain 范围权益约 ${(shown.focus.equityVsVillainRange * 100).toFixed(1)}%；节点策略：${shown.focus.strategy.map(s => `${esc(s.label)} ${(s.freq * 100).toFixed(0)}%`).join(' · ')}</div>` : ''}
    ${riverLessonHtml(shown)}
  </div>
  ${r.mode === 'exploit' ? renderExploitBlock(r, tab) : ''}
  ${r.gtoActions && tab === 'exploit' ? renderCompareTable(r) : ''}
  <div class="card heat-card"><h2>范围热力图 · Hero 策略分区</h2><div class="grid heat-2col"><div id="heatHero"></div><div id="heatVillain"></div></div>
    <div class="tiny muted" style="margin-top:8px">按 13×13 手牌类别聚合：F=弃牌 / C=跟注 / R=加注，纯策略标字母、混合策略标频率；悬停看完整花色与三路频率。分组：对角线=对子，右上=同花，左下=非同花。</div></div>
  <div class="card"><h2>路线预览</h2><div class="small muted">选择动作后，采样一张后续公共牌并快解下一条街（不预展开全树）。</div>
    <div class="chips" style="margin-top:8px">${(r.actions || []).map((a, i) => `<button class="chip" data-act="resPreview" data-id="${esc(job.id)}" data-v="${i}">${esc(a.label || a.type)}</button>`).join('')}</div>
    <div id="previewBox" style="margin-top:8px">${previewResult ? renderPreview(previewResult) : ''}</div></div>
  <div class="card"><h2>操作</h2><div class="grid g2">
    <button class="btn primary" data-act="resSave" data-id="${esc(job.id)}">保存到牌谱库</button>
    <button class="btn" data-act="resBind" data-id="${esc(job.id)}">绑定至对局</button>
    <button class="btn" data-act="resFav" data-id="${esc(job.id)}">${h.favorite ? '取消收藏' : '收藏'}</button>
    <button class="btn" data-act="resTag" data-id="${esc(job.id)}">添加标签</button>
    <button class="btn" data-act="resRerun" data-id="${esc(job.id)}">调整参数重跑</button>
    <button class="btn" data-act="go" data-v="library">前往牌谱库</button>
  </div></div>
  <div class="tiny muted">求解口径：${r.phase === 'preflop' ? '翻前近似（起手牌范围权益分档 + 街内 CFR，蒙特卡洛补全公共牌）' : '10 档牌力抽象 + 街内有限博弈树 + CFR 线性平均'}；${r.mode === 'exploit' ? '剥削路线按所选对手画像冻结策略后求解。' : '近似均衡，非商用 Solver 精度。'}停止口径：以可剥削度 NashConv（mbb/hand）达到目标为准，迭代次数仅为预算上限与辅助信息；1 次迭代 = 1 次 CFR 遍历，显示次数 = 实际执行次数。</div>`;
}
function progressHtml(job) {
  return convHtml({ exploitabilityMbb: job.exploitabilityMbb, targetMbb: job.targetMbb, converged: job.converged, iterations: job.iterations },
    job.progress || 0, job.progressLabel, job.etaMs)
    + `<div class="row end" style="margin-top:8px"><button class="btn sm" data-act="cancelJob" data-id="${esc(job.id)}">取消任务</button></div>`;
}
function renderExploitBlock(r, tab) {
  const A = ARCHETYPES.find(a => a.id === r.archetype);
  return `<div class="card"><h2>剥削模式（对手画像）</h2><div class="grid g2">
    ${statLine('对手画像', (A ? A.name + ' ' + A.tag : r.archetypeLabel) || '—')}
    ${statLine('强度档', r.intensity === 0.5 ? '轻度' : r.intensity === 1.5 ? '重度' : '中度')}
    ${statLine('剥削增益', r.exploitGainBB != null ? fmt(r.exploitGainBB) + ' BB' + (r.exploitGainBB < 0 ? '（剥削更差，建议切回 GTO）' : '') : '—')}
    ${statLine('范围宽度倍率', r.lockedInfo ? fmt(r.lockedInfo.params.width) + '×' : '—')}
  </div><div class="tiny muted" style="margin-top:8px">剥削增益 = EV(剥削路线) − EV(GTO 路线)，二者均在<b>同一画像假设环境</b>下计算。${tab === 'gto' ? '当前显示 GTO 基准路线。' : ''}</div></div>`;
}
function renderCompareTable(r) {
  return `<div class="card"><h2>GTO vs 剥削 双路线对比</h2><div class="table-wrap"><table class="ev-table"><thead><tr><th>动作</th><th class="num">GTO 频率</th><th class="num">剥削频率</th><th class="num">GTO EV</th><th class="num">剥削 EV</th></tr></thead><tbody>
  ${(r.gtoActions || []).map((g, i) => { const e = r.actions[i] || {}; return `<tr><td>${esc(g.label || g.type)}</td><td class="num">${(g.freq * 100).toFixed(1)}%</td><td class="num">${((e.freq || 0) * 100).toFixed(1)}%</td><td class="num">${fmt(g.ev)}</td><td class="num">${fmt(e.ev)}</td></tr>`; }).join('')}
  </tbody></table></div><div class="tiny muted" style="margin-top:6px">剥削频率 = Hero 对锁定对手的最优应对在各牌力档上的占比；EV 基于锁定后的对手策略。</div></div>`;
}
function renderPreview(p) {
  if (!p.available) return `<div class="notice">${esc(p.reason || '无法预览')}</div>`;
  return `<div class="notice info"><b>${esc(p.street)} 预览</b> · 新增公共牌 ${esc(p.newCard)} · 牌面 ${esc(p.board.join(' '))} · ${p.iterations} 次迭代<br>
    ${p.actions.map(a => `${esc(a.label || a.type)} ${(a.freq * 100).toFixed(0)}% / EV ${fmt(a.ev)} BB`).join(' · ')}</div>`;
}

/* ---------------- 对局台账 ---------------- */
function renderSessions() {
  const f = ui.filters;
  let list = state().sessions.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
  if (f.sign === 'win') list = list.filter(x => sessionNet(x) > 0);
  if (f.sign === 'loss') list = list.filter(x => sessionNet(x) < 0);
  if (f.type !== 'all') list = list.filter(x => x.type === f.type);
  if (f.q) list = list.filter(x => (x.name || '').includes(f.q) || (x.note || '').includes(f.q));
  app.innerHTML = `<div class="page-head"><div><h1>对局台账</h1><p class="sub">净盈亏 = 离场结算 − 总买入；删除对局会解除手牌绑定但保留手牌</p></div>
    <button class="btn primary" data-act="go" data-v="session/new">新建对局</button></div>
  <div class="card tight"><div class="row">
    <div class="chips">${[['all', '全部'], ['win', '盈利'], ['loss', '亏损']].map(([k, n]) => `<button class="chip ${f.sign === k ? 'on' : ''}" data-act="filterSign" data-v="${k}">${n}</button>`).join('')}</div>
    <div class="chips">${[['all', '全部场地'], ['online', '线上'], ['offline', '线下']].map(([k, n]) => `<button class="chip ${f.type === k ? 'on' : ''}" data-act="filterType" data-v="${k}">${n}</button>`).join('')}</div>
    <input type="search" id="sessionQ" placeholder="搜索名称 / 备注" value="${esc(f.q)}" style="max-width:220px">
  </div></div>
  <div class="card"><div class="table-wrap"><table><thead><tr><th>日期</th><th>名称</th><th>盲注</th><th>总买入</th><th>结算</th><th>净盈亏</th><th>手牌</th><th>操作</th></tr></thead><tbody>
    ${list.length ? list.map(s => `<tr><td>${esc(s.date)}</td><td>${esc(s.name)}</td><td>${esc(s.stakes?.sb)}/${esc(s.stakes?.bb)}</td><td>${fmt(sessionBuyin(s))}</td><td>${fmt(s.cashout)}</td>
      <td class="${pnlCls(sessionNet(s))}"><b>${signed(sessionNet(s))}</b></td><td>${state().hands.filter(h => h.sessionId === s.id).length}</td>
      <td><div class="row"><button class="btn sm" data-act="go" data-v="session/${esc(s.id)}">详情</button><button class="btn sm danger" data-act="delSession" data-id="${esc(s.id)}">删除</button></div></td></tr>`).join('') : '<tr><td colspan="8"><div class="empty">暂无对局</div></td></tr>'}
  </tbody></table></div></div>`;
}
function renderSession(id) {
  const isNew = id === 'new' || !id;
  const s = isNew ? { id: makeId('session'), name: '', date: today(), type: 'offline', stakes: { sb: 1, bb: 2 }, buyins: [200], cashout: 200, bbValue: 0, note: '' } : state().sessions.find(x => x.id === id);
  if (!s) { app.innerHTML = '<div class="card"><div class="empty">对局不存在</div></div>'; return; }
  const hands = isNew ? [] : state().hands.filter(h => h.sessionId === s.id);
  app.innerHTML = `<div class="page-head"><div><h1>${isNew ? '新建对局' : esc(s.name)}</h1><p class="sub">${isNew ? '创建一场 session 并绑定复盘手牌' : esc(s.date) + ' · ' + (s.type === 'online' ? '线上' : '线下')}</p></div>
    <button class="btn" data-act="go" data-v="sessions">返回列表</button></div>
  <div class="card"><h2>对局信息</h2><div class="grid g2">
    <label class="field"><span>对局名称</span><input type="text" id="sfName" value="${esc(s.name)}" placeholder="如：周五朋友局"></label>
    <label class="field"><span>日期</span><input type="date" id="sfDate" value="${esc(s.date)}"></label>
    <label class="field"><span>类型</span><select id="sfType"><option value="offline" ${s.type === 'offline' ? 'selected' : ''}>线下</option><option value="online" ${s.type === 'online' ? 'selected' : ''}>线上</option></select></label>
    <label class="field"><span>盲注级别 SB / BB</span><div class="row"><input type="number" id="sfSb" step="0.5" value="${esc(s.stakes.sb)}"><input type="number" id="sfBb" step="0.5" value="${esc(s.stakes.bb)}"></div></label>
    <label class="field"><span>离场结算金额</span><input type="number" id="sfCash" step="0.01" value="${esc(s.cashout)}"></label>
    <label class="field"><span>每 BB 折算金额（可选）</span><input type="number" id="sfBbValue" step="0.01" value="${esc(s.bbValue)}" placeholder="用于 BB 盈亏折算"></label>
  </div>
  <div class="hr"></div><h3>买入 / 补入（多笔）</h3><div id="buyinRows">${(s.buyins || []).map((b, i) => buyinRow(b, i)).join('')}</div>
  <div class="row" style="margin-top:8px"><button class="btn sm" data-act="addBuyin">+ 添加一笔</button><span class="small muted">总买入：<b id="buyinTotal">${fmt(sessionBuyin(s))}</b></span><span class="small muted">净盈亏：<b id="netPreview" class="${pnlCls(sessionNet(s))}">${signed(sessionNet(s))}</b></span></div>
  <label class="field" style="margin-top:10px"><span>备注（桌子风格、对手特点）</span><textarea id="sfNote" rows="2" placeholder="仅限策略复盘描述">${esc(s.note || '')}</textarea></label>
  <div class="row end" style="margin-top:10px"><button class="btn primary" data-act="saveSession" data-id="${esc(s.id)}">保存对局</button></div>
  <div class="tiny muted" style="margin-top:6px">校验：金额必须为数值且精度 ≤ 2 位小数；允许负数表示真实亏损；不含任何资金划转功能。</div></div>
  ${!isNew ? `<div class="card"><div class="card-title"><h2>绑定手牌（${hands.length}）</h2><button class="btn sm" data-act="showBind" data-id="${esc(s.id)}">追加手牌</button></div>
    ${hands.length ? `<div class="table-wrap"><table><thead><tr><th>手牌</th><th>位置</th><th>牌面</th><th>盈亏(BB)</th><th>已求解</th><th>操作</th></tr></thead><tbody>${hands.map(h => `<tr>
      <td class="mono">${esc((h.heroCards || []).map(cardStr).join(' '))}</td><td>${esc(h.positions.hero)}</td><td class="mono">${esc((h.board || []).map(cardStr).join(' '))}</td>
      <td class="${pnlCls(handProfitBB(h))}">${signed(handProfitBB(h))}</td><td>${h.solvedJobId ? '是' : '否'}</td>
      <td><button class="btn sm" data-act="unbindHand" data-id="${esc(h.id)}">解除绑定</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">尚未绑定手牌，求解完成后可一键加入</div>'}</div>` : ''}`;
}
function buyinRow(b, i) {
  return `<div class="row" style="margin-bottom:6px" data-buyin="${i}"><input type="number" step="0.01" class="buyinVal" value="${esc(b)}" style="max-width:200px"><button class="btn sm" data-act="delBuyin" data-v="${i}">移除</button></div>`;
}
function readSessionForm(id) {
  const num = (q, d = 0) => Number($(q)?.value ?? d);
  const buyins = [...document.querySelectorAll('.buyinVal')].map(i => Math.round(Number(i.value) * 100) / 100).filter(v => Number.isFinite(v));
  for (const v of [num('#sfCash'), ...buyins]) if (!Number.isFinite(v)) { toast('金额必须为数值'); return null; }
  const cash = Math.round(num('#sfCash') * 100) / 100;
  return {
    id, name: ($('#sfName')?.value || '').trim() || '未命名对局', date: $('#sfDate')?.value || today(),
    type: $('#sfType')?.value || 'offline', stakes: { sb: num('#sfSb', 1), bb: num('#sfBb', 2) },
    buyins, cashout: cash, bbValue: Math.round(num('#sfBbValue') * 100) / 100,
    note: ($('#sfNote')?.value || '').trim(), updatedAt: new Date().toISOString()
  };
}

/* ---------------- 统计 ---------------- */
function renderStats() {
  const s = computeStats(ui.period);
  app.innerHTML = `<div class="page-head"><div><h1>统计面板</h1><p class="sub">基于已录入对局与手牌 · 红涨绿跌</p></div>
    <div class="chips">${[['7d', '7 天'], ['30d', '30 天'], ['quarter', '本季'], ['all', '全部']].map(([k, n]) => `<button class="chip ${ui.period === k ? 'on' : ''}" data-act="setPeriod" data-v="${k}">${n}</button>`).join('')}</div></div>
  <div class="notice ${s.sampleWarning ? '' : 'info'}" >样本偏差提示：VPIP / PFR / 3bet / bb·100 与平均每手盈利仅基于<b>已录入手牌</b>计算（n=${s.handCount}），非全部实战手数。${s.sampleWarning ? '<b>样本不足 100 手，统计不稳定。</b>' : ''}</div>
  <div class="grid g4" style="margin-top:12px">
    ${kpi('总场次', s.sessionCount)}
    ${kpi('总买入', money(s.totalBuyin))}
    ${kpi('总盈亏', money(s.totalNet), pnlCls(s.totalNet))}
    ${kpi('平均每手 (BB)', fmt(s.avgPerHandBB), pnlCls(s.avgPerHandBB))}
    ${kpi('bb/100', fmt(s.bbPer100))}
    ${kpi('胜 / 负局', s.wins + ' / ' + s.losses)}
    ${kpi('最大单局盈利', money(s.maxWin))}
    ${kpi('最大回撤', money(s.maxDrawdown))}
    ${kpi('VPIP', fmt(s.vpip, 1) + '%')}
    ${kpi('PFR', fmt(s.pfr, 1) + '%')}
    ${kpi('3bet', fmt(s.threeBet, 1) + '%')}
    ${kpi('手牌样本 n', s.handCount)}
  </div>
  <div class="card"><div class="card-title"><h2>累计盈利曲线</h2><span class="tiny muted" id="curveTip">悬停 / 长按查看对局详情</span></div><div class="canvas-box"><canvas id="statCurve"></canvas></div></div>
  <div class="card"><h2>单局盈亏柱状图</h2><div class="canvas-box"><canvas id="statBars"></canvas></div></div>
  <div class="grid g2">
    <div class="card"><h2>按位置盈亏 (BB)</h2>${dimTable(s.byPosition)}</div>
    <div class="card"><h2>按牌型盈亏 (BB)</h2>${dimTable(s.byClass)}</div>
  </div>`;
}
function dimTable(obj) {
  const rows = Object.entries(obj).sort((a, b) => b[1] - a[1]);
  if (!rows.length) return '<div class="empty">暂无数据</div>';
  return `<div class="table-wrap"><table><thead><tr><th>维度</th><th class="num">盈亏 (BB)</th></tr></thead><tbody>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num ${pnlCls(v)}">${signed(v)}</td></tr>`).join('')}</tbody></table></div>`;
}

/* ---------------- 牌谱库 ---------------- */
function renderLibrary() {
  const L = ui.lib;
  let list = state().hands.slice().sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
  if (L.fav) list = list.filter(h => h.favorite);
  if (L.tag) list = list.filter(h => (h.tags || []).includes(L.tag));
  if (L.q) {
    const q = L.q.toLowerCase();
    list = list.filter(h => [h.heroCards.map(cardStr).join(''), h.positions.hero, h.board.map(cardStr).join(''), String(h.stakes?.bb), ...(h.tags || [])].join(' ').toLowerCase().includes(q));
  }
  app.innerHTML = `<div class="page-head"><div><h1>牌谱库</h1><p class="sub">私有牌谱资产 · 标签 / 收藏 / 搜索 / 导出</p></div><button class="btn sm" data-act="go" data-v="new">新建复盘</button></div>
  <div class="card tight"><div class="stack">
    <input type="search" id="libQ" placeholder="搜索手牌 / 位置 / 盲注 / 标签" value="${esc(L.q)}">
    <div class="chips"><button class="chip ${L.fav ? 'on' : ''}" data-act="libFavToggle">收藏夹</button>
      <button class="chip ${!L.tag ? 'on' : ''}" data-act="libTag" data-v="">全部标签</button>
      ${state().tags.map(t => `<button class="chip ${L.tag === t ? 'on' : ''}" data-act="libTag" data-v="${esc(t)}">${esc(t)}</button>`).join('')}</div>
  </div></div>
  <div class="card">${list.length ? `<div class="table-wrap"><table><thead><tr><th>手牌</th><th>位置</th><th>牌面</th><th>盲注</th><th>结果</th><th>标签</th><th>操作</th></tr></thead><tbody>
    ${list.map(h => `<tr><td class="mono">${esc(h.heroCards.map(cardStr).join(' '))}</td><td>${esc(h.positions.hero)}</td><td class="mono">${esc(h.board.map(cardStr).join(' '))}</td>
      <td>${esc(h.stakes?.sb)}/${esc(h.stakes?.bb)}</td><td class="${pnlCls(handProfitBB(h))}">${h.result ? signed(handProfitBB(h)) + ' BB' : '—'}</td>
      <td>${(h.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('') || '—'}</td>
      <td><div class="row"><button class="btn sm" data-act="libOpen" data-id="${esc(h.id)}">打开</button>
        <button class="btn sm" data-act="libFav" data-id="${esc(h.id)}">${h.favorite ? '★' : '☆'}</button>
        <button class="btn sm" data-act="libHH" data-id="${esc(h.id)}">HH</button>
        <button class="btn sm danger" data-act="libDel" data-id="${esc(h.id)}">删</button></div></td></tr>`).join('')}
  </tbody></table></div>` : '<div class="empty">牌谱库为空，完成一次求解后会自动归档</div>'}</div>`;
}

/* ---------------- 备份 ---------------- */
function renderBackup() {
  const s = state();
  app.innerHTML = `<div class="page-head"><div><h1>数据备份</h1><p class="sub">全部数据保存在本机浏览器（IndexedDB + localStorage 镜像）</p></div></div>
  <div class="card"><h2>导出</h2><div class="grid g2">
    <button class="btn primary" data-act="expJSON">导出全量 JSON 备份</button>
    <button class="btn" data-act="expCSV">导出对局 CSV</button>
    <button class="btn" data-act="expHH">导出全部牌谱 HH 文本</button>
    <button class="btn" data-act="go" data-v="stats">查看统计面板</button>
  </div><div class="small muted" style="margin-top:8px">上次备份：${esc(s.settings.lastBackupAt || '尚未备份')} · 共 ${s.sessions.length} 场对局 / ${s.hands.length} 手牌 / ${s.jobs.length} 个求解任务</div></div>
  <div class="card"><h2>导入</h2><div class="small muted">JSON 全量恢复，可选覆盖或合并（按 id 去重）。</div>
    <div class="row" style="margin-top:8px"><button class="btn" data-act="impMerge">导入并合并</button><button class="btn" data-act="impOverwrite">导入并覆盖</button>
      <input type="file" id="importFile" class="file-input" accept="application/json,.json"></div></div>
  <div class="card"><h2>本地数据</h2>
    ${statLine('存储方式', 'IndexedDB（localStorage 镜像 / 降级）')}
    ${statLine('对局 / 手牌 / 任务', `${s.sessions.length} / ${s.hands.length} / ${s.jobs.length}`)}
    <div class="row" style="margin-top:10px"><button class="btn danger" data-act="clearAll">清理全部本地数据</button></div>
  </div>
  <div class="card"><h2>部署说明</h2><div class="small muted">纯静态站点，可直接推送到 GitHub 仓库并开启 GitHub Pages；无后端、无构建步骤。本地预览请通过 HTTP 服务打开（ES Module Worker 不支持 file:// 协议）。</div></div>`;
}

/* ---------------- 渲染后处理（Canvas 等） ---------------- */
let curveHit = null;
function postRender(name, id) {
  if (name === 'dashboard') {
    const s = computeStats(ui.period);
    requestAnimationFrame(() => { const c = $('#dashCurve'); if (c) drawCurve(c, s.curve, { height: 180 }); });
  }
  if (name === 'stats') {
    const s = computeStats(ui.period);
    requestAnimationFrame(() => {
      const c = $('#statCurve'); if (c) curveHit = drawCurve(c, s.curve, { height: 210 });
      const b = $('#statBars'); if (b) drawBars(b, s.bar, { height: 180 });
    });
  }
  if (name === 'result') {
    const job = state().jobs.find(j => j.id === id);
    if (job && job.status === 'done' && job.result) {
      requestAnimationFrame(() => {
        const a = $('#heatHero'), b = $('#heatVillain');
        const rj = job.result;
        const useGto = ui.resTab === 'gto' && rj.gtoActions;
        const strat = rj.heatmap && rj.heatmap.strategy
          ? (useGto && rj.heatmap.strategy.gto ? rj.heatmap.strategy.gto : rj.heatmap.strategy.hero) : null;
        const shownR = useGto ? { ...rj, mode: 'gto' } : rj;
        if (a && strat && strat.length) {
          renderStrategyHeatmap(a, strat, {
            title: `Hero 策略分区 · ${shownR.mode === 'exploit' ? '剥削路线' : '均衡'}`,
            focusCards: (shownR.focus && shownR.focus.cards) || [],
            note: '按你手牌类别给出主策略：每个格子来自该类别组合在此决策点的平均策略。混合策略标「动作字母+主策略频率」，纯策略只标字母。重点看蓝框（你的手牌）落在哪个区。'
          });
        } else if (a) renderHeatmapGrid(a, rj.heatmap.hero, { title: 'Hero 均衡进攻范围', legend: '颜色越深 = 下注/加注频率越高' });
        if (b) renderHeatmapGrid(b, rj.heatmap.villain, { title: 'Villain 范围与应对象', legend: '颜色越深 = 面对下注时不弃牌倾向越高' });
      });
    }
  }
}

/* ---------------- 事件绑定 ---------------- */
function setPath(obj, path, value) {
  const parts = path.split('.');
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) { if (o[parts[i]] == null) o[parts[i]] = {}; o = o[parts[i]]; }
  o[parts[parts.length - 1]] = value;
}
/** Hero 与对手位置不能相同：冲突时自动改派对手，否则对手的行动会被判成第三方、下注后不出跟注选项 */
function syncDistinctPositions(h) {
  const pos = positionsFor(h.tableSize).map(p => String(p).toUpperCase());
  const heroU = String(h.positions.hero).toUpperCase();
  if (String(h.positions.villain).toUpperCase() === heroU) {
    const alt = heroU !== 'BTN' ? 'BTN' : 'BB';
    h.positions.villain = pos.includes(alt) ? alt : (pos.find(p => p !== heroU) || 'BB');
    toast(`对手位置不能与 Hero 相同，已自动改为 ${h.positions.villain}`);
    return true;
  }
  return false;
}
function handleBind(target) {
  if (!wizard) return;
  const h = wizard.hand;
  const path = target.dataset.bind;
  // 第 1 步改了座位设定后，清掉上一套手动行动者 / 补录状态
  if (String(path).startsWith('positions.') || path === 'tableSize') { ui.act.actor = null; ui.act.force = false; }
  let v = target.type === 'checkbox' ? target.checked : target.value;
  if (target.type === 'number' || /^(stakes|stackBB|tableSize|intensity|potOverrideBB|stackOverrideBB|customSizes|deadText)$/.test(path)) {
    if (path === 'customSizes') {
      const arr = String(v).split(/[,，\s]+/).map(Number).filter(x => Number.isFinite(x) && x > 0 && x <= 3).slice(0, 4);
      h.customSizes = arr; if (arr.length) h.sizes = arr;
      return;
    }
    if (path === 'deadText') { h.deadCards = parseCardList(String(v)); return; }
    if (path === 'potOverrideBB' || path === 'stackOverrideBB') { h[path] = v === '' ? null : Number(v); return; }
    v = Number(v);
    if (path === 'tableSize') { h.tableSize = v === 9 ? 9 : 6; const pos = positionsFor(h.tableSize); if (!pos.includes(h.positions.hero)) h.positions.hero = 'BTN'; if (!pos.includes(h.positions.villain)) h.positions.villain = 'BB'; syncDistinctPositions(h); return; }
  }
  setPath(h, path, v);
  if (String(path).startsWith('positions.')) syncDistinctPositions(h);
  saveDraft(h);
}
function saveWizard() { if (wizard) saveDraft(wizard.hand); }
function refresh() { saveWizard(); render(); scheduleLivePreview(); }

function refocus(id, value) {
  const el = $('#' + id);
  if (!el) return;
  el.focus();
  try { el.setSelectionRange(value.length, value.length); } catch (e) { /* ignore */ }
}
document.addEventListener('input', e => {
  const t = e.target;
  if (t.id === 'bulkActions') { wizard.bulkText = t.value; return; }
  if (t.id === 'pasteText') { wizard.pasteText = t.value; return; }
  if (t.id === 'libQ') { ui.lib.q = t.value; renderLibrary(); refocus('libQ', t.value); return; }
  if (t.id === 'sessionQ') { ui.filters.q = t.value; renderSessions(); refocus('sessionQ', t.value); return; }
  if (t.dataset.bind) handleBind(t);
});
document.addEventListener('change', e => {
  const t = e.target;
  if (t.dataset.editAmount != null) {
    const i = Number(t.dataset.editAmount), a = wizard?.hand?.actions?.[i];
    if (a) {
      if (t.value === '') a.amountBB = null;
      else {
        const n = Number(t.value);
        if (!Number.isFinite(n) || n < 0) { toast('下注量必须为非负数值'); render(); return; }
        a.amountBB = Math.round(n * 10) / 10;
      }
      wizard.decisionIndex = null; refresh();
    }
    return;
  }
  if (t.dataset.act === 'setActor') {
    ui.act.actor = t.value;
    if (wizard && actionFlow(wizard.hand, actStreet(wizard.hand)).closed) ui.act.force = true;
    render(); return;
  }
  if (t.dataset.bind) { handleBind(t); if (t.dataset.refresh) render(); return; }
  if (t.dataset.act === 'rangePreset' || t.dataset.rangePreset) {
    const side = t.dataset.rangePreset || t.dataset.side; wizard.hand.rangePresets[side] = t.value; wizard.hand.ranges[side] = presetMatrix(t.value);
    if (side === heroRangeSide()) $('#rangeGrid').innerHTML = rangeGridHtml(wizard.hand.ranges[side]);
    saveWizard(); return;
  }
});
let heroRangeSide = () => 'hero';
app.addEventListener('mousemove', e => {
  if (!curveHit || !e.target || e.target.id !== 'statCurve') return;
  const rect = e.target.getBoundingClientRect();
  const p = curveHit(e.clientX - rect.left);
  const tip = $('#curveTip');
  if (tip && p) tip.textContent = `${p.label} · 累计 ${signed(p.value)} · 单局 ${signed(p.single)}`;
});

function openCardPicker(kind, idx) {
  pendingPick = { kind, idx };
  const h = wizard.hand;
  const cur = kind === 'board' ? h.board[idx] : kind === 'hero' ? h.heroCards[idx] : h.villainCards[idx];
  let html = `<h2>选择牌</h2><div class="small muted">${kind === 'board' ? '公共牌' : kind === 'hero' ? 'Hero 手牌' : 'Villain 手牌'} · 第 ${idx + 1} 张${cur != null ? ' · 当前 ' + esc(cardLabel(cur)) : ''}</div>
    <div class="card-picker" style="margin-top:10px">`;
  html += `<div class="rank"></div>` + RANKS.split('').map(r => `<div class="rank">${r}</div>`).join('');
  for (let s = 0; s < 4; s++) {
    html += `<div class="rank">${SUIT_SYM[SUITS[s]]}</div>`;
    for (let r = 0; r < 13; r++) {
      const c = s * 13 + r;
      const used = [...h.heroCards, ...h.villainCards, ...h.board, ...h.deadCards].includes(c);
      html += `<button class="card-slot ${isRed(c) ? 'red' : ''}" style="min-width:0;width:100%;height:36px;font-size:12px;${used ? 'opacity:.3' : ''}" data-act="pickCardCell" data-c="${c}" ${used && c !== cur ? 'disabled' : ''}>${cardLabel(c)}</button>`;
    }
  }
  html += `</div><div class="row end" style="margin-top:12px">${cur != null ? `<button class="btn sm danger" data-act="clearCard">清除该张</button>` : ''}<button class="btn sm" data-act="closeModal">取消</button></div>`;
  openModal(html);
}

function handleAct(act, ds, ev) {
  const id = ds.id, v = ds.v;
  switch (act) {
    case 'go': go(v); break;
    case 'closeModal': closeModal(); break;
    case 'closeModalBg': if (ev && ev.target.classList.contains('modal')) closeModal(); break;
    case 'setPeriod': ui.period = v; render(); break;
    case 'resetWizard': confirmDialog('清空重填', '将清空当前草稿并恢复默认牌谱，是否继续？', () => { wizard = null; clearDraft(); ensureWizard(); render(); }, '清空'); break;
    /* 向导 */
    case 'wizTab': ui.wizTab = v; if (wizard) wizard.wizTab = v; render(); break;
    case 'wizStep': wizard.step = Number(v); saveWizard(); render(); break;
    case 'loadExample': wizard.pasteText = HH_EXAMPLE; render(); break;
    case 'parsePaste': {
      const text = $('#pasteText')?.value ?? wizard.pasteText;
      wizard.pasteText = text;
      wizard.parseInfo = parseHH(text);
      render(); break;
    }
    case 'pasteToWizard': ui.wizTab = 'wizard'; wizard.wizTab = 'wizard'; render(); break;
    case 'useParsed':
    case 'useParsedForce': {
      const h = wizard.parseInfo.hand;
      wizard.hand = h; wizard.step = 2; wizard.decisionIndex = null;
      wizard.stage = stageFromBoard((h.board || []).length); wizard.paramsOpen = false;
      ui.wizTab = 'wizard'; wizard.wizTab = 'wizard';
      saveWizard(); render();
      toast(v === 'useParsedForce' ? '已载入牌谱 · 请按红色标注修正不合逻辑的行动' : `已载入牌谱 · 当前阶段：${STREET_NAME[wizard.stage]}`);
      break;
    }
    case 'pickCard': openCardPicker(ds.kind, Number(ds.idx)); break;
    case 'pickCardCell': {
      const c = Number(ds.c), h = wizard.hand, p = pendingPick;
      if (!p) break;
      const cur = p.kind === 'board' ? h.board[p.idx] : p.kind === 'hero' ? h.heroCards[p.idx] : p.kind === 'villain' ? h.villainCards[p.idx] : null;
      if (c === cur) { closeModal(); break; }
      const arr = p.kind === 'board' ? h.board : p.kind === 'hero' ? h.heroCards : p.kind === 'villain' ? h.villainCards : null;
      if (arr && p.idx > arr.length) { toast('请按顺序先选择前面的牌'); break; }
      const all = [...h.heroCards, ...h.villainCards, ...h.board, ...h.deadCards];
      if (all.includes(c)) { toast('该牌已被使用，请选择其他牌'); break; }
      // 记录选牌前当前街已填公共牌数，用于判断「刚选齐最后一张」
      const street0 = actStreet(h), need0 = stageBoardCount(street0);
      const beforeFilled = (h.board || []).filter(x => x != null).slice(0, need0).length;
      if (p.kind === 'hero') h.heroCards[p.idx] = c;
      else if (p.kind === 'villain') h.villainCards[p.idx] = c;
      else if (p.kind === 'board') h.board[p.idx] = c;
      else h.deadCards.push(c);
      closeModal();
      // 公共牌刚选齐当前街最后一张 → 仅当本街行动已收口时自动进入下一街（行动未完先留在本街，避免出现未回应就换街的行动线）
      let advanced = false, stayNote = '';
      if (p.kind === 'board' && need0 > 0 && beforeFilled === need0 - 1) {
        const afterFilled = (h.board || []).filter(x => x != null).slice(0, need0).length;
        const si0 = STREETS.indexOf(wizard.stage);
        if (afterFilled >= need0 && si0 >= 0 && si0 < 3) {
          const fl = actionFlow(h, street0);
          if (fl.closed || fl.handOver) {
            wizard.stage = STREETS[si0 + 1];
            ui.act.actor = null; ui.act.force = false; wizard.decisionIndex = null;
            advanced = true;
          } else {
            stayNote = `公共牌已选齐 · 请录完${STREET_NAME[street0]}行动（下注需被回应），收口后自动进入下一街`;
          }
        }
      }
      refresh();
      if (advanced) toast(`${STREET_NAME[street0]}公共牌已选齐 · 自动进入${STREET_NAME[wizard.stage]}`);
      else if (stayNote) toast(stayNote);
      break;
    }
    case 'clearCard': {
      const h = wizard.hand, p = pendingPick;
      if (!p) break;
      if (p.kind === 'board') h.board.splice(p.idx, 1);
      else if (p.kind === 'hero') h.heroCards.splice(p.idx, 1);
      else if (p.kind === 'villain') h.villainCards.splice(p.idx, 1);
      closeModal(); refresh(); break;
    }
    case 'clearCards': { const h = wizard.hand; if (ds.kind === 'hero') h.heroCards = []; else if (ds.kind === 'villain') h.villainCards = []; else h.board = []; refresh(); break; }
    case 'setStreet':
    case 'nextStreet':
      wizard.stage = v; ui.act.street = null; ui.act.actor = null; ui.act.force = false; wizard.decisionIndex = null;
      saveWizard(); render(); break;
    case 'solveStreet':
      wizard.stage = v; ui.act.street = null; ui.act.actor = null; ui.act.force = false;
      saveWizard(); render(); beginSolve(); break;
    case 'advanceStage': {
      const si = STREETS.indexOf(wizard.stage);
      if (si >= 3) { toast('已到河牌，可直接解算'); break; }
      wizard.stage = STREETS[si + 1];
      ui.act.street = null; ui.act.actor = null; ui.act.force = false; wizard.decisionIndex = null;
      const need = stageBoardCount(wizard.stage);
      const have = (wizard.hand.board || []).filter(c => c != null).length;
      saveWizard(); render();
      toast(have >= need ? `进入${STREET_NAME[wizard.stage]}` : `进入${STREET_NAME[wizard.stage]}：请选择 ${need} 张公共牌（已保留 ${have} 张）`);
      break;
    }
    case 'toggleParams': wizard.paramsOpen = !wizard.paramsOpen; render(); break;
    case 'setActorSeat': {
      const h = wizard.hand, street = actStreet(h), flow = actionFlow(h, street);
      ui.act.actor = v;
      if (flow.closed) ui.act.force = true;
      render(); toast(`已指定 ${v} 行动${flow.closed ? '（手动补录模式）' : ''}`); break;
    }
    case 'forceAct': ui.act.force = true; render(); toast('手动补录已开启，可继续在本街录入动作'); break;
    case 'cancelForce': ui.act.force = false; ui.act.actor = null; render(); break;
    case 'resetActor': ui.act.actor = null; render(); toast('已恢复自动顺位'); break;
    case 'quickAction': {
      const h = wizard.hand, street = actStreet(h), si = STREETS.indexOf(street);
      const flow = actionFlow(h, street);
      if (flow.closed && !ui.act.force) { toast('本街行动已结束：请进入下一街，或点「仍要在本街补录」'); break; }
      const actor = nextActorFor(h, street) || flow.first;
      const { live } = liveFor(h, street);
      const effState = deriveState(h, (h.actions || []).length);
      const sugSide = actorKey(h, actor) === 'HERO' ? 'hero' : actorKey(h, actor) === 'VILLAIN' ? 'villain' : null;
      const sug = suggestedAmounts(h, live, effState, sugSide);
      let amountBB = sug[v];
      if (ds.amt === 'custom') {
        const raw = $('#naAmount')?.value ?? '';
        const n = Number(raw);
        if (raw === '' || !Number.isFinite(n) || n <= 0) { toast('请先在「自定义金额」里填入大于 0 的 BB 数'); break; }
        amountBB = Math.round(n * 10) / 10;
      } else if (ds.amt != null && ds.amt !== '') {
        amountBB = Math.round(Number(ds.amt) * 10) / 10;
      }
      if (v === 'FOLD' || v === 'CHECK') amountBB = null;
      if (['CALL', 'BET', 'RAISE_TO'].includes(v) && !(amountBB > 0)) { toast('金额需大于 0'); break; }
      // 按街序插入，允许回到前面的街补录而不破坏行动流顺序
      let insertAt = h.actions.length;
      for (let k = h.actions.length - 1; k >= 0; k--) {
        if (STREETS.indexOf(String(h.actions[k].street).toUpperCase()) <= si) { insertAt = k + 1; break; }
        insertAt = k;
      }
      h.actions.splice(insertAt, 0, { street, actor, type: v, amountBB });
      ui.act.actor = null; ui.act.force = false; wizard.decisionIndex = null; wizard.bulkInfo = null;
      const label = `${actor} ${ACTION_LABEL[v]}${amountBB != null ? ' ' + fmt(amountBB, 1) + ' BB' : ''}`;
      ui.act.flash = { idx: insertAt, at: Date.now() };
      const after = actionFlow(h, street);
      let msg = `已录入 #${insertAt + 1} · ${label}`;
      if (after.closed) {
        if (after.handOver) msg += ' · 本手结束，可直接解算';
        else if (si < 3) {
          wizard.stage = STREETS[si + 1];
          const need = stageBoardCount(wizard.stage);
          const have = (h.board || []).filter(c => c != null).length;
          msg += ` · 本街结束 → 自动进入${STREET_NAME[wizard.stage]}${have < need ? `，请选择 ${need - have} 张公共牌` : ''}`;
        } else msg += ' · 河牌行动结束，可直接解算';
      } else msg += ` · 轮到 ${after.actor}`;
      saveWizard(); render(); toast(msg);
      break;
    }
    case 'beginSolve': beginSolve(); break;
    case 'showReadiness': openReadiness(solveReadiness(wizard.hand, wizard.stage)); break;
    case 'goStep': wizard.step = Math.max(1, Math.min(2, Number(v) || 1)); closeModal(); saveWizard(); render(); break;
    case 'editAction': openActionEditor(Number(v)); break;
    case 'saveAction': {
      const i = Number(v), a = wizard?.hand?.actions?.[i];
      if (!a) { closeModal(); break; }
      if (['CALL', 'BET', 'RAISE_TO', 'ALLIN'].includes(a.type)) {
        const el = $('#editAmt');
        const raw = el ? el.value : '';
        if (raw === '') a.amountBB = null;
        else {
          const n = Number(raw);
          if (!Number.isFinite(n) || n < 0) { toast('金额必须为非负数值'); break; }
          a.amountBB = Math.round(n * 10) / 10;
        }
      }
      closeModal(); wizard.decisionIndex = null; refresh(); toast(`已更新 #${i + 1}`);
      break;
    }
    case 'undoAction': wizard.hand.actions.pop(); wizard.decisionIndex = null; ui.act.force = false; ui.act.actor = null; refresh(); break;
    case 'clearActions': {
      confirmDialog('清空行动流', '将删除已录入的全部行动，是否继续？', () => {
        wizard.hand.actions = []; wizard.decisionIndex = null;
        ui.act.street = null; ui.act.actor = null; ui.act.force = false; refresh();
      }, '清空');
      break;
    }
    case 'foldToHero': {
      // 其它位置本来就是隐式默认弃牌；此按钮仅把它们显式写入行动流（便于导出 HH）
      const h = wizard.hand;
      const hero = String(h.positions.hero).toUpperCase(), villain = String(h.positions.villain).toUpperCase();
      const others = positionsFor(h.tableSize).filter(p => p !== hero && p !== villain);
      const already = new Set((h.actions || []).filter(a => String(a.street).toUpperCase() === 'PREFLOP').map(a => String(a.actor).toUpperCase()));
      const adds = others.filter(p => !already.has(p)).map(actor => ({ street: 'PREFLOP', actor, type: 'FOLD', amountBB: null, auto: true }));
      if (!adds.length) { toast('其它位置的翻前弃牌已存在，无需补录'); break; }
      h.actions = [...adds, ...(h.actions || [])];
      wizard.decisionIndex = null; ui.act.actor = null; ui.act.force = false;
      refresh(); toast(`已补录 ${adds.length} 条其它位置弃牌（仅影响导出，不改变行动顺位）`); break;
    }
    case 'toggleBulk': ui.act.bulk = !ui.act.bulk; render(); break;
    case 'bulkLoadExample': wizard.bulkText = BULK_EXAMPLE; wizard.bulkInfo = null; render(); break;
    case 'bulkParse': {
      const text = $('#bulkActions')?.value ?? wizard.bulkText ?? '';
      wizard.bulkText = text;
      const r = parseActionText(text, wizard.hand);
      if (r.errors.length) {
        wizard.bulkInfo = { ok: false, msg: '解析失败：' + r.errors.slice(0, 5).map(e => `第 ${e.line} 行 ${e.msg}`).join('；') };
        render(); break;
      }
      const acts = normalizeActionAmounts(r.actions, wizard.hand);
      wizard.hand.actions = acts;
      wizard.decisionIndex = null; ui.act.street = null; ui.act.actor = null;
      wizard.stage = stageFromBoard((wizard.hand.board || []).length);
      const chk = validateHand(wizard.hand);
      const actionErrs = chk.errors.filter(e => String(e.path).startsWith('actions'));
      const otherErrs = chk.errors.length - actionErrs.length;
      wizard.bulkInfo = {
        ok: actionErrs.length === 0,
        msg: `已录入 ${acts.length} 条动作`
          + (actionErrs.length ? '；行动流错误：' + actionErrs.slice(0, 3).map(e => e.msg).join('；') : '，行动流校验通过')
          + (r.warnings.length ? '（' + r.warnings.join('；') + '）' : '')
          + (otherErrs ? '（手牌请在第 1 步补齐，公共牌在对应街阶段选择）' : '')
      };
      refresh(); break;
    }
    case 'loadExampleActions': {
      const h = wizard.hand;
      h.heroCards = [parseCard('As'), parseCard('Kd')];
      h.board = [parseCard('Kc'), parseCard('7h'), parseCard('2s'), parseCard('5d')];
      h.actions = [
        { street: 'PREFLOP', actor: 'UTG', type: 'FOLD', amountBB: null },
        { street: 'PREFLOP', actor: 'MP', type: 'FOLD', amountBB: null },
        { street: 'PREFLOP', actor: 'CO', type: 'FOLD', amountBB: null },
        { street: 'PREFLOP', actor: 'BTN', type: 'RAISE_TO', amountBB: 5 },
        { street: 'PREFLOP', actor: 'SB', type: 'FOLD', amountBB: null },
        { street: 'PREFLOP', actor: 'BB', type: 'CALL', amountBB: 5 },
        { street: 'FLOP', actor: 'BB', type: 'CHECK', amountBB: null },
        { street: 'FLOP', actor: 'BTN', type: 'BET', amountBB: 3.3 },
        { street: 'FLOP', actor: 'BB', type: 'CALL', amountBB: 3.3 },
        { street: 'TURN', actor: 'BB', type: 'CHECK', amountBB: null },
        { street: 'TURN', actor: 'BTN', type: 'BET', amountBB: 11 },
        { street: 'TURN', actor: 'BB', type: 'FOLD', amountBB: null }
      ];
      h.result = 'hero'; wizard.decisionIndex = null;
      wizard.stage = stageFromBoard(h.board.length); ui.act.street = null; ui.act.actor = null;
      refresh(); toast(`已填充标准示例 · 当前阶段：${STREET_NAME[wizard.stage]}`); break;
    }
    case 'delAction': {
      const i = Number(v);
      closeModal();
      wizard.hand.actions.splice(i, 1); wizard.decisionIndex = null; refresh(); toast(`已删除 #${i + 1}`); break;
    }
    case 'setDecision': {
      const el = ev && ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
      if (el && ev.target !== el && ev.target.closest('button,input')) break;
      closeModal();
      wizard.decisionIndex = Number(v); refresh(); toast(`决策点已切换为 #${Number(v) + 1}`); break;
    }
    case 'setPendingDecision': {
      wizard.decisionIndex = Number(v); refresh(); toast('决策点已设为：Hero 面对对手下注的应对'); break;
    }
    case 'toggleSize': {
      const h = wizard.hand, n = Number(v);
      h.sizes = h.sizes.includes(n) ? h.sizes.filter(x => x !== n) : [...h.sizes, n].slice(0, 4);
      if (!h.sizes.length) h.sizes = [0.5];
      refresh(); break;
    }
    case 'rangePreset': break;
    case 'rangeSide': {
      heroRangeSide = () => v;
      $('#rangeSideHero').classList.toggle('on', v === 'hero');
      $('#rangeSideVillain').classList.toggle('on', v === 'villain');
      $('#rangeGrid').innerHTML = rangeGridHtml(wizard.hand.ranges[v]); break;
    }
    case 'rangeCell': {
      const side = heroRangeSide(), m = wizard.hand.ranges[side], i = Number(ds.i), j = Number(ds.j);
      const cur = m[i][j] || 0;
      m[i][j] = cur <= 0.02 ? 0.5 : cur < 0.55 ? 1 : 0;
      $('#rangeGrid').innerHTML = rangeGridHtml(m); saveWizard(); break;
    }
    case 'setMode': wizard.hand.mode = v; refresh(); break;
    case 'setArchetype': wizard.hand.archetype = v; refresh(); break;
    case 'setIntensity': wizard.hand.intensity = Number(v); refresh(); break;
    case 'confirmExploit': {
      if (!wizard) break;
      const h = wizard.hand, street = actStreet(h), key = liveReqKey(h, street);
      if (key === 'incomplete' || key === 'waiting' || key === 'closed') break;
      livePreviewSeq++;
      liveProfilePart = `${h.mode}|${h.archetype}|${h.intensity}`;
      livePreview = { key, status: 'queued', result: null, pct: 0.02, error: '' };
      clearTimeout(livePreviewTimer);
      updateLiveBody();
      livePreviewTimer = setTimeout(() => runLivePreview(key), 0);
      break;
    }
    case 'solve': beginSolve(); break;
    /* 结果页 */
    case 'resTab': ui.resTab = v; render(); break;
    case 'resDecision': {
      const job = state().jobs.find(j => j.id === id); const h = state().hands.find(x => x.id === job.handId);
      if (h) submitSolve(h, Number(v)); break;
    }
    case 'resPreview': {
      const job = state().jobs.find(j => j.id === id);
      if (!job || !job.req) break;
      const label = (job.result.actions[Number(v)] || {}).label || '';
      previewResult = null; render();
      toast('正在采样后续公共牌并快解下一条街');
      queue.submit({
        jobId: 'preview_' + Date.now(), req: job.req, type: 'preview', actionLabel: label, persist: false,
        handlers: {
          onPreview: r => { previewResult = r; if (routeInfo().id === id) render(); },
          onError: m => toast('路线预览失败：' + m)
        }
      });
      break;
    }
    case 'cancelJob': queue.cancel(id); break;
    case 'rerunJob': {
      const job = state().jobs.find(j => j.id === id);
      const fresh = { ...job, id: makeId('job'), status: 'queued', progress: 0, result: null, createdAt: new Date().toISOString() };
      upsertJob(fresh); go('result/' + fresh.id);
      queue.submit({ jobId: fresh.id, req: fresh.req, type: 'solve', persist: true, handlers: {
        onProgress: (p, l, eta) => { if (routeInfo().id === fresh.id) renderProgress(fresh.id, p, l, eta); },
        onResult: () => { if (routeInfo().id === fresh.id) render(); },
        onError: m => { toast('求解失败：' + m); if (routeInfo().id === fresh.id) render(); }
      } });
      break;
    }
    case 'resSave': {
      const job = state().jobs.find(j => j.id === id); const h = state().hands.find(x => x.id === job.handId);
      if (h) { h.solvedJobId = id; upsertHand(h); toast('已保存到牌谱库'); } break;
    }
    case 'resFav': {
      const job = state().jobs.find(j => j.id === id); const h = state().hands.find(x => x.id === job.handId);
      if (h) { h.favorite = !h.favorite; upsertHand(h); render(); } break;
    }
    case 'resTag': {
      const job = state().jobs.find(j => j.id === id); const h = state().hands.find(x => x.id === job.handId);
      if (!h) break;
      openModal(`<h2>添加标签</h2><div class="chips">${state().tags.map(t => `<button class="chip" data-act="applyTag" data-id="${esc(h.id)}" data-v="${esc(t)}">${esc(t)}</button>`).join('')}</div>
        <label class="field" style="margin-top:10px"><span>自定义标签</span><input type="text" id="newTag" placeholder="输入后点击添加"></label>
        <div class="row end" style="margin-top:8px"><button class="btn primary" data-act="applyTag" data-id="${esc(h.id)}" data-custom="1">添加自定义</button></div>`);
      break;
    }
    case 'applyTag': {
      const h = state().hands.find(x => x.id === id); if (!h) break;
      let t = ds.custom ? ($('#newTag')?.value || '').trim() : v;
      if (!t) break;
      h.tags = [...new Set([...(h.tags || []), t])]; upsertHand(h);
      if (!state().tags.includes(t)) commit(s => { s.tags.push(t); });
      closeModal(); render(); toast('标签已添加'); break;
    }
    case 'resBind': {
      const job = state().jobs.find(j => j.id === id); const h = state().hands.find(x => x.id === job.handId);
      if (!h) break;
      const list = state().sessions;
      if (!list.length) { toast('尚无对局，请先新建对局'); break; }
      openModal(`<h2>绑定至对局</h2><div class="stack">${list.map(s => `<button class="btn block" data-act="doBind" data-id="${esc(h.id)}" data-v="${esc(s.id)}">${esc(s.date)} · ${esc(s.name)}</button>`).join('')}
        <button class="btn" data-act="unbindHand" data-id="${esc(h.id)}">解除当前绑定</button></div>`);
      break;
    }
    case 'doBind': bindHand(id, v); closeModal(); render(); toast('已绑定至对局'); break;
    case 'resCopy': {
      const job = state().jobs.find(j => j.id === id); const h = state().hands.find(x => x.id === job.handId);
      const text = h ? serializeHH(h) : '';
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => toast('牌谱文本已复制')).catch(() => downloadText('hand.txt', text));
      else { downloadText('hand.txt', text); toast('已下载牌谱文本'); }
      break;
    }
    case 'resPNG': {
      const job = state().jobs.find(j => j.id === id); const h = state().hands.find(x => x.id === job.handId);
      if (!job || !h) break;
      try {
        const url = buildResultImage(job.result, h, { date: h.createdAt?.slice(0, 10), handCards: h.heroCards.map(cardStr).join(' '), board: h.board.map(cardStr).join(' ') });
        const a = document.createElement('a'); a.href = url; a.download = `gto_result_${id}.png`; document.body.appendChild(a); a.click(); a.remove();
        toast('结果图已导出');
      } catch (e) { toast('导出失败：' + e.message); }
      break;
    }
    case 'resRerun': {
      const job = state().jobs.find(j => j.id === id); const h = state().hands.find(x => x.id === job.handId);
      if (!h) break;
      wizard = { step: 3, hand: JSON.parse(JSON.stringify(h)), decisionIndex: job.params.decisionIndex, wizTab: 'wizard', pasteText: '', parseInfo: null };
      saveDraft(wizard.hand); go('new'); break;
    }
    /* 对局 */
    case 'filterSign': ui.filters.sign = v; renderSessions(); break;
    case 'filterType': ui.filters.type = v; renderSessions(); break;
    case 'addBuyin': { const box = $('#buyinRows'); const d = document.createElement('div'); d.innerHTML = buyinRow(100, box.children.length); box.appendChild(d.firstElementChild); break; }
    case 'delBuyin': { const rows = $('#buyinRows'); if (rows.children.length <= 1) { toast('至少保留一笔买入'); break; } rows.children[Number(v)]?.remove(); break; }
    case 'saveSession': {
      const data = readSessionForm(id); if (!data) break;
      upsertSession(data); go('sessions'); toast('对局已保存'); break;
    }
    case 'delSession': confirmDialog('删除对局', '将删除该对局并解除其手牌绑定（手牌本身保留），是否继续？', () => { removeSession(id); render(); toast('对局已删除'); }, '删除'); break;
    case 'showBind': {
      const candidates = state().hands.filter(h => h.sessionId !== id);
      if (!candidates.length) { toast('没有可追加的手牌'); break; }
      openModal(`<h2>追加手牌至对局</h2><div class="stack">${candidates.slice(0, 40).map(h => `<button class="btn block" data-act="doBind" data-id="${esc(h.id)}" data-v="${esc(id)}">${esc(h.heroCards.map(cardStr).join(' '))} · ${esc(h.positions.hero)} · ${esc(h.board.map(cardStr).join(' '))}</button>`).join('')}</div>`);
      break;
    }
    case 'unbindHand': bindHand(id, null); closeModal(); render(); toast('已解除绑定（手牌保留）'); break;
    /* 牌谱库 */
    case 'libFavToggle': ui.lib.fav = !ui.lib.fav; renderLibrary(); break;
    case 'libTag': ui.lib.tag = v; renderLibrary(); break;
    case 'libFav': { const h = state().hands.find(x => x.id === id); if (h) { h.favorite = !h.favorite; upsertHand(h); renderLibrary(); } break; }
    case 'libDel': confirmDialog('删除手牌', '该手牌将从牌谱库移除，无法恢复。', () => { removeHand(id); renderLibrary(); toast('已删除'); }, '删除'); break;
    case 'libHH': { const h = state().hands.find(x => x.id === id); if (h) { downloadText(`hand_${id}.txt`, serializeHH(h)); toast('HH 文本已导出'); } break; }
    case 'libOpen': {
      const h = state().hands.find(x => x.id === id); if (!h) break;
      const job = state().jobs.filter(j => j.handId === id && j.status === 'done').pop();
      if (job) go('result/' + job.id);
      else { wizard = { step: 1, hand: JSON.parse(JSON.stringify(h)), decisionIndex: null, wizTab: 'wizard', pasteText: '', parseInfo: null }; go('new'); }
      break;
    }
    /* 备份 */
    case 'expJSON': {
      downloadText(`poker_gto_backup_${today()}.json`, exportJSON(), 'application/json;charset=utf-8');
      commit(s => { s.settings.lastBackupAt = new Date().toISOString(); }); render(); toast('全量备份已导出'); break;
    }
    case 'expCSV': downloadText(`poker_gto_sessions_${today()}.csv`, exportSessionsCSV(), 'text/csv;charset=utf-8'); toast('对局 CSV 已导出'); break;
    case 'expHH': {
      const txt = state().hands.map(h => serializeHH(h)).join('\n\n');
      downloadText(`poker_gto_hands_${today()}.txt`, txt || '# 暂无牌谱'); toast('牌谱 HH 已导出'); break;
    }
    case 'impMerge': case 'impOverwrite': {
      const input = $('#importFile'); if (!input) break;
      input.dataset.mode = act === 'impOverwrite' ? 'overwrite' : 'merge'; input.click(); break;
    }
    case 'clearAll': confirmDialog('清理全部本地数据', '此操作不可撤销：将删除全部对局、手牌、求解结果与设置。建议先导出 JSON 备份。', () => {
      commit(s => { const d = defaultState(); Object.keys(s).forEach(k => delete s[k]); Object.assign(s, d); });
      wizard = null; ui = { wizTab: 'wizard', resTab: null, period: '30d', filters: { sign: 'all', type: 'all', q: '' }, lib: { q: '', tag: '', fav: false }, act: { street: null, actor: null, bulk: false } };
      go('dashboard'); toast('本地数据已清理');
    }, '确认清理'); break;
    default: break;
  }
}
document.addEventListener('click', e => {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  e.preventDefault();
  try { handleAct(t.dataset.act, t.dataset, e); } catch (err) { showFatal(err); }
});
document.querySelectorAll('#nav button').forEach(b => b.addEventListener('click', () => go(b.dataset.route)));

/* 导入文件处理 */
document.addEventListener('change', e => {
  if (e.target && e.target.id === 'importFile' && e.target.files && e.target.files[0]) {
    const file = e.target.files[0], mode = e.target.dataset.mode || 'merge';
    const reader = new FileReader();
    reader.onload = () => {
      try { const r = importJSON(String(reader.result), mode); toast(`导入成功：${r.sessions} 场对局 / ${r.hands} 手牌`); render(); }
      catch (err) { toast('导入失败：' + err.message); }
      e.target.value = '';
    };
    reader.readAsText(file);
  }
});

/* ---------------- 启动 ---------------- */
(async function boot() {
  await initDB();
  $('#versionTag').textContent = 'V1.3 · 翻前 / 翻后';
  render();
})();
