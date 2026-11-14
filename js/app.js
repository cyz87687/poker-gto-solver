/* app.js —— SPA 主程序：路由、向导录入、求解队列、结果页、台账、统计、牌谱库、备份 */
import { RANKS, SUITS, SUIT_SYM, cardStr, cardLabel, isRed, parseCardList, parseCard, presetMatrix, emptyMatrix, RANGE_PRESETS, classLabel } from './cards.js';
import {
  STREETS, POS6, POS9, ACTION_TYPES, BUILTIN_TAGS, ARCHETYPES, positionsFor, makeId, defaultHand,
  formatAction, parseHH, validateHand, deriveState, heroDecisionIndices, serializeHH, handClass, handProfitBB,
  parseActionText, normalizeActionAmounts, solveReadiness, firstToActPostflop
} from './hand.js';
import {
  initDB, state, commit, persist, saveDraft, clearDraft, upsertSession, removeSession, upsertHand, removeHand,
  bindHand, upsertJob, findCachedJob, jobCacheKey, escapeHtml,
  computeStats, sessionNet, sessionBuyin, exportJSON, importJSON, exportSessionsCSV, exportHandHH, downloadText
} from './db.js';
import { drawCurve, drawBars, renderHeatmapGrid, buildResultImage } from './charts.js';
import { solveCore } from './solver-core.js';

const $ = s => document.querySelector(s);
const app = $('#app');
const esc = escapeHtml;
const fmt = (v, d = 2) => (Number(v) || 0).toFixed(d);
const signed = v => (Number(v) > 0 ? '+' : '') + fmt(v);
const pnlCls = v => Number(v) > 0 ? 'up' : Number(v) < 0 ? 'down' : '';
const money = v => (state().settings.currency || '¥') + fmt(v);
const today = () => new Date().toISOString().slice(0, 10);

let wizard = null;
let ui = { wizTab: 'wizard', resTab: null, period: '30d', filters: { sign: 'all', type: 'all', q: '' }, lib: { q: '', tag: '', fav: false }, act: { street: null, actor: null, bulk: false } };
let pendingPick = null;
let previewResult = null;
let toastTimer = null;

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
  const fn = pages[name] || renderDashboard;
  try { fn(); } catch (e) { showFatal(e); }
  postRender(name, id);
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
      try { w = new Worker(new URL('./solver.worker.js', import.meta.url), { type: 'module' }); }
      catch (e) { this.fallback(item); return; }
      item.worker = w;
      w.onerror = ev => this.fail(item, '求解线程异常：' + (ev.message || '未知错误'));
      w.onmessage = ev => {
        const m = ev.data || {};
        if (m.type === 'progress') {
          if (item.persist) upsertJob({ id: item.jobId, progress: m.pct, progressLabel: m.label, etaMs: m.etaMs });
          item.handlers.onProgress && item.handlers.onProgress(m.pct, m.label, m.etaMs);
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
          : solveCore(item.req, (p, l) => { item.handlers.onProgress && item.handlers.onProgress(p, l, null); });
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
  return {
    board: st.board, heroCards: h.heroCards || [], villainCards: h.villainCards || [], deadCards: h.deadCards || [],
    heroRange: h.ranges.hero, villainRange: h.ranges.villain,
    pot, stack, facingBet: st.facingBet, heroOOP: st.heroOOP, oppChecked: st.oppChecked,
    sizes: h.sizes, allowCheckRaise: h.allowCheckRaise, preset: h.preset,
    mode: h.mode, archetype: h.archetype, intensity: h.intensity,
    userAction: act ? { type: act.type, amountBB: act.amountBB } : null,
    decisionNode: `${st.street}|${h.positions.hero}|${st.facingBet > 0 ? 'vs_bet' : 'vs_check'}`,
    decisionIndex
  };
}
function selectedDecisionIndex(h) {
  const idxs = heroDecisionIndices(h);
  if (!idxs.length) return (h.actions || []).length;
  return wizard && idxs.includes(wizard.decisionIndex) ? wizard.decisionIndex : idxs[idxs.length - 1];
}
function submitSolve(h, decisionIndex) {
  const rd = solveReadiness(h);
  if (!rd.ready) { openReadiness(rd); return; }
  const v = validateHand(h);
  if (!v.ok) { openReadiness(rd); return; }
  if (!v.solveAllowed) { openReadiness(rd); return; }
  upsertHand(h);
  const req = buildSolveReq(h, decisionIndex);
  const params = { mode: h.mode, archetype: h.archetype, intensity: h.intensity, sizes: h.sizes, pot: req.pot, stack: req.stack, decisionIndex, preset: h.preset };
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
      onProgress: (pct, label, eta) => { if (routeInfo().name === 'result') renderProgress(job.id, pct, label, eta); },
      onResult: () => { if (routeInfo().name === 'result') render(); },
      onError: msg => { toast('求解失败：' + msg); if (routeInfo().name === 'result') render(); }
    }
  });
}
function renderProgress(jobId, pct, label, eta) {
  const box = $('#solveProgress');
  if (!box) { if (routeInfo().id === jobId) render(); return; }
  box.innerHTML = `<div class="row between"><span class="small">${esc(label || '求解中')}</span><span class="small mono">${(pct * 100).toFixed(0)}%${eta ? ' · 预计剩余 ' + Math.ceil(eta / 1000) + 's' : ''}</span></div>
    <div class="progress" style="margin-top:6px"><i style="width:${Math.round(pct * 100)}%"></i></div>
    <div class="row end" style="margin-top:8px"><button class="btn sm" data-act="cancelJob" data-id="${esc(jobId)}">取消任务</button></div>`;
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
  <div class="notice info">求解范围：<b>仅翻后单挑底池</b>（公共牌 3–5 张）；不支持翻前求解、3 人及以上底池、ICM 与含抽水计算。结果为牌力分档抽象下的近似均衡解。</div>`;
}
function kpi(label, value, cls = '') {
  return `<div class="kpi"><div class="label">${esc(label)}</div><div class="value ${cls}">${esc(value)}</div></div>`;
}

/* ---------------- 新建复盘（向导 / 粘贴） ---------------- */
function ensureWizard() {
  if (wizard) return wizard;
  const draft = state().draft;
  wizard = { step: 1, hand: draft || defaultHand(), decisionIndex: null, wizTab: ui.wizTab, pasteText: '', parseInfo: null };
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
  <div class="page-head"><div><h1>新建一手复盘</h1><p class="sub">向导录入 / 牌谱粘贴导入 · V1.0 仅翻后单挑可求解</p></div>
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
  <div class="notice">导入后仍可在向导中调整对手范围、下注尺度与求解模式；学徒模式下请勿录入任何真实资金相关内容。</div>`;
}
function renderParseInfo(info) {
  if (info.errors.length) return `<div class="notice danger" style="margin-top:12px"><b>解析失败（${info.errors.length} 处）</b><br>${info.errors.map(e => `第 ${e.line} 行：${esc(e.msg)}`).join('<br>')}<br><span class="tiny">可点击「转为向导录入」手动填写。</span></div>`;
  const h = info.hand;
  const v = validateHand(h);
  return `<div class="notice info" style="margin-top:12px"><b>解析成功</b>：${esc(h.positions.hero)} ${h.heroCards.map(cardStr).join('')} · 公共牌 ${h.board.map(cardStr).join(' ')} · ${h.actions.length} 条行动 · 校验${v.ok ? '通过' : '存在 ' + v.errors.length + ' 处错误'}</div>
  ${v.errors.length ? `<div class="notice danger" style="margin-top:8px">${v.errors.map(e => esc(e.path + '：' + e.msg)).join('<br>')}</div>` : ''}
  ${v.warnings.length ? `<div class="notice" style="margin-top:8px">${v.warnings.map(esc).join('<br>')}</div>` : ''}
  <div class="row" style="margin-top:10px"><button class="btn primary" data-act="useParsed" ${v.ok ? '' : 'disabled'}>使用此牌谱继续配置</button></div>`;
}
function renderWizard(w) {
  const h = w.hand;
  const steps = ['基础与手牌', '行动流', '范围与参数', '校验并求解'];
  const v = validateHand(h);
  const di = selectedDecisionIndex(h);
  const rd = solveReadiness(h);
  let body = '';
  if (w.step === 1) body = wizardStep1(h);
  else if (w.step === 2) body = wizardStep2(h, di, v);
  else if (w.step === 3) body = wizardStep3(h);
  else body = wizardStep4(h, di, v);
  const stateTip = rd.ready
    ? '<span class="ready-ok">✓ 已满足解算条件</span>'
    : `<span class="ready-no">✕ ${esc(firstBlocking(rd))}</span>`;
  return `<div class="card tight"><div class="stepper">${steps.map((s, i) => `${i ? '<span class="line"></span>' : ''}<span class="s ${w.step === i + 1 ? 'on' : ''}"><span class="n">${i + 1}</span>${s}</span>`).join('')}</div></div>
  ${body}
  <div class="wiz-foot">
    <button class="btn" data-act="wizStep" data-v="${Math.max(1, w.step - 1)}" ${w.step === 1 ? 'disabled' : ''}>上一步</button>
    <div class="foot-state">${stateTip}<span class="tiny muted sep">·</span><span class="tiny muted">草稿自动保存</span></div>
    <div class="row">
      ${w.step < 4 ? `<button class="btn" data-act="wizStep" data-v="${w.step + 1}">${w.step === 2 ? '范围与参数' : '下一步'}</button>` : ''}
      ${w.step >= 2 ? `<button class="btn primary" data-act="beginSolve">开始解算 →</button>` : ''}
    </div>
  </div>`;
}
function cardSlot(c, kind, idx) {
  const label = c != null ? cardLabel(c) : '+';
  return `<button class="card-slot ${c != null && isRed(c) ? 'red' : ''}" data-act="pickCard" data-kind="${kind}" data-idx="${idx}" title="点击选择">${esc(label)}</button>`;
}
function cardRowHtml(cards, kind, n) {
  const arr = (cards || []).slice(0, n);
  return `<div class="card-row">${Array.from({ length: n }, (_, i) => cardSlot(arr[i], kind, i)).join('')}
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
  <div class="card"><h2>② 手牌与公共牌</h2>
    <div class="small muted">Hero 手牌（点击格子选择花色 + 牌点）</div>${cardRowHtml(h.heroCards, 'hero', 2)}
    <div class="small muted" style="margin-top:8px">公共牌（翻牌 3 张起，可追加转牌 / 河牌）</div>${cardRowHtml(h.board, 'board', 5)}
    <div class="small muted" style="margin-top:8px">对手手牌（可选，摊牌已知时填写）</div>${cardRowHtml(h.villainCards, 'villain', 2)}
    <label class="field" style="margin-top:8px"><span>死牌 Dead Cards（可选，如 As Kd）</span><input type="text" data-bind="deadText" value="${esc((h.deadCards || []).map(cardStr).join(' '))}" placeholder="已知弃牌，空格分隔"></label>
    <label class="field" style="margin-top:8px"><span>摊牌结果</span><select data-bind="result"><option value="" ${!h.result ? 'selected' : ''}>未录入</option><option value="hero" ${h.result === 'hero' ? 'selected' : ''}>我方赢</option><option value="villain" ${h.result === 'villain' ? 'selected' : ''}>对方赢</option><option value="split" ${h.result === 'split' ? 'selected' : ''}>平分底池</option></select></label>
  </div>
  <div class="notice info">V1.0 仅支持<b>翻后单挑</b>求解：公共牌需 3–5 张，且翻牌后只有 Hero 与 Villain 两家行动。多人底牌谱可录入归档，但不输出求解结果。</div>`;
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
  const acts = h.actions || [];
  return ui.act.street || (acts.length ? String(acts[acts.length - 1].street).toUpperCase() : 'PREFLOP');
}
/** 下一位行动者：同街自动顺位推进；进入新街回到该街首位（翻后按位置由 OOP 先动） */
function nextActorFor(h, street) {
  if (ui.act.actor) return ui.act.actor;
  const pos = positionsFor(h.tableSize);
  const acts = h.actions || [];
  const sameStreet = acts.filter(a => String(a.street).toUpperCase() === street);
  const last = sameStreet[sameStreet.length - 1];
  const si = STREETS.indexOf(street);
  if (si > 0) {
    // 翻后为单挑底池：只在 Hero 与 Villain 之间交替，首位由位置（OOP）决定
    if (!last) return firstToActPostflop(h);
    return actorKey(h, last.actor) === 'HERO' ? h.positions.villain : h.positions.hero;
  }
  const first = pos[0];
  if (!last) return first;
  const key = actorKey(h, last.actor);
  const i = pos.findIndex(x => x.toUpperCase() === key);
  return i >= 0 ? pos[(i + 1) % pos.length] : first;
}
/** 某条街结束时的局面（用于在该街末尾补录动作，可回到前面的街） */
function liveFor(h, street) {
  const v = validateHand(h);
  const si = STREETS.indexOf(street);
  const traces = v.potTrace || [];
  const onStreet = traces.filter(t => t.street === street);
  if (onStreet.length) {
    const last = onStreet[onStreet.length - 1];
    return {
      v,
      live: {
        pot: last.pot, toCall: last.toCall,
        highest: last.highest != null ? last.highest : 0,
        lastRaise: last.lastRaise != null ? last.lastRaise : 1,
        street
      }
    };
  }
  const prev = traces.filter(t => STREETS.indexOf(t.street) < si);
  if (prev.length) {
    return { v, live: { pot: prev[prev.length - 1].pot, toCall: 0, highest: 0, lastRaise: 1, street } };
  }
  const sb = Number(h.stakes?.sb) || 1, bb = Number(h.stakes?.bb) || 2;
  return {
    v,
    live: { pot: Math.round((sb / bb + 1) * 10) / 10, toCall: si === 0 ? 1 : 0, highest: si === 0 ? 1 : 0, lastRaise: 1, street }
  };
}
function suggestedAmounts(h, live) {
  const r1 = x => Math.round(x * 10) / 10;
  return {
    FOLD: null, CHECK: null,
    CALL: r1(Number(live.toCall) || 0),
    BET: r1(Math.max(1, (Number(live.pot) || 1.5) * 0.67)),
    RAISE_TO: r1(Math.max(3, (Number(live.highest) || 0) + (Number(live.lastRaise) || 1) * 3)),
    ALLIN: r1(Number(h.stackBB) || 100)
  };
}
/** 下注尺度：按底池比例生成，最多 4 档，去重并裁到后手以内 */
function betSizes(live, stack) {
  const pot = Math.max(0.5, Number(live.pot) || 1);
  const cap = Math.max(0.5, Number(stack) || 100);
  const out = [], seen = new Set();
  const add = (amt, label) => {
    const a = Math.round(amt * 10) / 10;
    if (!(a > 0) || a > cap + 1e-9 || seen.has(a)) return;
    seen.add(a); out.push({ amt: a, label });
  };
  add(pot * 0.33, '33%'); add(pot * 0.5, '50%'); add(pot * 0.67, '67%'); add(pot, '满池');
  return out.slice(0, 4);
}
/** 加注尺度：最小加注 → 2× → 3× → 全下 */
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
  add(minTo, '最小');
  add(Math.min(cap, minTo * 2), '2×');
  add(Math.min(cap, minTo * 3), '3×');
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
    return { name, left: 50 + 37 * Math.cos(rad), top: 50 + 33 * Math.sin(rad) };
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
  const actorU = String(actor || '').toUpperCase();
  const seats = seatCoords(h).map(s => {
    const key = actorKey(h, s.name);
    const side = key === 'HERO' ? 'hero' : key === 'VILLAIN' ? 'villain' : 'other';
    const isFolded = folded.has(key);
    const active = key === actorKey(h, actorU) || s.name === actorU;
    const isOut = side === 'other' && isFolded;
    const amt = inv[key] || 0;
    return `<div class="seat ${side} ${isFolded ? 'folded' : ''} ${active ? 'active' : ''} ${isOut ? 'out' : ''}"
      style="left:${s.left.toFixed(1)}%;top:${s.top.toFixed(1)}%">
      <div class="seat-nm">${esc(s.name)}</div>
      <div class="seat-tag">${side === 'hero' ? 'HERO' : side === 'villain' ? '对手' : isFolded ? '已弃' : '—'}${amt > 0 ? ' · ' + fmt(amt, 1) : ''}</div>
      ${active ? '<div class="seat-act">行动中</div>' : ''}
    </div>`;
  }).join('');
  const board = (h.board || []).map(c => `<span class="mini-card ${isRed(c) ? 'red' : ''}">${cardLabel(c)}</span>`).join('');
  return `<div class="table-wrap-v">
    <div class="felt">${seats}
      <div class="felt-center">
        <div class="pot"><span>底池</span><b>${fmt(live.pot ?? 0, 1)}</b><span>BB</span></div>
        <div class="felt-board">${board || '<span class="tiny muted">未选公共牌</span>'}</div>
        <div class="felt-street">${STREET_NAME[street] || street}</div>
      </div>
    </div>
    <div class="table-legend"><span><i class="dot hero"></i>Hero</span><span><i class="dot villain"></i>对手</span><span><i class="dot folded"></i>已弃牌</span><span><i class="dot active"></i>下一位行动</span></div>
  </div>`;
}

/* ---------- 行动卡片 ---------- */
function simpleActionCard(type, title, sub, dis, reason) {
  return `<button class="ac ac-${type.toLowerCase()}" ${dis ? 'disabled' : `data-act="quickAction" data-v="${type}"`}>
    <span class="ac-ic">${ACTION_ICON[type]}</span>
    <span class="ac-main"><b>${esc(title)}</b><span class="ac-sub">${dis ? '✕ ' + esc(reason) : esc(sub)}</span></span>
  </button>`;
}
function sizeActionCard(type, title, sub, opts, dis, reason) {
  if (dis) return simpleActionCard(type, title, '', true, reason);
  return `<div class="ac ac-size ac-${type.toLowerCase()}">
    <div class="ac-main"><b>${esc(title)}</b><span class="ac-sub">${esc(sub)}</span></div>
    <div class="ac-sizes">${opts.map(o => `<button class="sz" data-act="quickAction" data-v="${type}" data-amt="${o.amt}"><em>${o.label}</em><b>${fmt(o.amt, 1)}</b></button>`).join('')}
      <button class="sz sz-custom" data-act="quickAction" data-v="${type}" data-amt="custom"><b>自定义</b></button></div>
  </div>`;
}
function actionCardsHtml(h, live, toCall) {
  const stack = Math.max(0, Number(h.stackBB) || 100);
  const pot = Math.max(0.5, Number(live.pot) || 1);
  const sug = suggestedAmounts(h, live);
  const facing = toCall > 0;
  const callAmt = Math.min(toCall, stack);
  const out = [];
  out.push(simpleActionCard('FOLD', '弃牌', '放弃本手，已投入的筹码不收回', false, ''));
  out.push(simpleActionCard('CHECK', '过牌', '不投入，把行动权交给对手', facing, '对手已下注，此时不能过牌'));
  out.push(simpleActionCard('CALL', facing ? `跟注 ${fmt(callAmt, 1)}` : '跟注', facing ? `投入 ${fmt(callAmt, 1)} BB 匹配对手下注` : '', !facing, '无人下注，无需跟注'));
  out.push(sizeActionCard('BET', '下注', `主动投入 · 底池 ${fmt(pot, 1)} BB`, betSizes(live, stack), facing, '对手已下注，应使用「加注」'));
  const minTo = Math.max(0, Number(live.highest) || 0) + Math.max(1, Number(live.lastRaise) || 1);
  out.push(sizeActionCard('RAISE_TO', '加注', minTo > 0 ? `本街投入提到 ${fmt(minTo, 1)} BB 起` : '把本街投入提高到指定额', raiseSizes(live, stack), !facing, '无人下注，应使用「下注」'));
  out.push(simpleActionCard('ALLIN', `全下 ${fmt(stack, 1)}`, `投入全部后手 ${fmt(stack, 1)} BB`, stack <= 0.5, '后手不足'));
  return `<div class="ac-grid">${out.join('')}</div>`;
}

/* ---------- 行动时间线 ---------- */
function timelineHtml(h, idxs, di) {
  const acts = h.actions || [];
  if (!acts.length) return '<div class="empty">还没有录入行动 · 点击上方卡片即录入一条</div>';
  return STREETS.map(st => {
    const items = acts.map((a, i) => ({ a, i })).filter(x => String(x.a.street).toUpperCase() === st);
    if (!items.length) return '';
    return `<div class="tl-street"><div class="tl-hd"><b>${STREET_NAME[st]}</b><span class="tiny muted">${items.length} 条</span></div>
      <div class="tl-row">${items.map(({ a, i }) => {
        const isDecision = idxs.includes(i);
        const side = actorKey(h, a.actor) === 'HERO' ? 'hero' : actorKey(h, a.actor) === 'VILLAIN' ? 'villain' : 'other';
        return `<button class="tl-pill ${side} ${a.type === 'FOLD' ? 'fold' : ''} ${i === di ? 'on' : ''} ${ui.act.flash && ui.act.flash.idx === i ? 'flash' : ''}" data-act="editAction" data-v="${i}" title="点击编辑 / 删除 / 设为决策点">
          <span class="no">#${i + 1}</span><span class="who">${esc(a.actor)}</span><span class="what">${ACTION_LABEL[a.type] || a.type}</span>
          ${a.amountBB != null ? `<b>${fmt(a.amountBB, 1)}</b>` : ''}
          ${isDecision ? '<span class="flag">决策点</span>' : ''}
        </button>`;
      }).join('')}</div></div>`;
  }).join('');
}

/* ---------- 就绪度 ---------- */
function readinessStrip(rd) {
  const keys = ['heroCards', 'board', 'headsUp', 'actions'];
  const items = rd.items.filter(i => keys.includes(i.key));
  return `<div class="rd-strip">${items.map(i => `<button class="rd ${i.ok ? 'ok' : 'ng'}" data-act="showReadiness"><span>${i.ok ? '✓' : '✕'}</span>${esc(i.label)}</button>`).join('')}
    ${rd.ready ? '' : '<button class="rd ng more" data-act="showReadiness">查看还差什么 →</button>'}</div>`;
}
function firstBlocking(rd) {
  const b = rd.items.find(i => !i.ok);
  return b ? b.label + (b.hint ? `（${b.hint}）` : '') : '';
}

function wizardStep2(h, di, v) {
  const idxs = heroDecisionIndices(h);
  const street = actStreet(h);
  const si = STREETS.indexOf(street);
  const acts = h.actions || [];
  const lastSi = acts.length ? STREETS.indexOf(String(acts[acts.length - 1].street).toUpperCase()) : -1;
  const actor = nextActorFor(h, street);
  const live = liveFor(h, street).live;
  const toCall = Math.max(0, Number(live.toCall) || 0);
  const rd = solveReadiness(h);
  const actorSideName = actorKey(h, actor) === 'HERO' ? 'Hero' : actorKey(h, actor) === 'VILLAIN' ? '对手' : '其他位置';
  const streetChips = STREETS.map((st, i) => `<button class="chip ${st === street ? 'on' : ''}" data-act="setStreet" data-v="${st}" ${i < lastSi ? 'disabled title="街序不能回退"' : ''}>${STREET_NAME[st]}${st === street ? ' · 当前' : ''}</button>`).join('');
  const nextSt = STREETS[Math.min(3, si + 1)];

  return `<div class="card"><div class="card-title"><h2>③ 选择行动</h2><span class="tiny muted">已录入 ${acts.length} 条 · 点卡片即录入</span></div>
    ${readinessStrip(rd)}
    <div class="street-row"><div class="chips">${streetChips}<button class="chip sm" data-act="nextStreet" data-v="${nextSt}" ${si >= 3 ? 'disabled' : ''}>下一街 →</button></div></div>
    <div class="turn-bar">
      <div class="turn-who"><span class="turn-label">下一位行动</span><b class="side-${actorKey(h, actor) === 'HERO' ? 'hero' : 'villain'}">${esc(actor)}</b><span class="tiny muted">${actorSideName}</span></div>
      <div class="turn-nums">
        <div><span>待跟注</span><b>${fmt(toCall, 1)}</b></div>
        <div><span>最小加注至</span><b>${fmt((Number(live.highest) || 0) + Math.max(1, Number(live.lastRaise) || 1), 1)}</b></div>
        <div><span>后手</span><b>${fmt(h.stackBB, 1)}</b></div>
      </div>
      <label class="field turn-pick"><span>换人</span><select data-act="setActor">${[...positionsFor(h.tableSize), 'HERO', 'VILLAIN'].map(x => `<option value="${x}" ${x === actor ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
    </div>
    ${tableHtml(h, street, actor, live)}
    ${actionCardsHtml(h, live, toCall)}
    <details class="adv-amt"><summary>自定义金额（可选）</summary>
      <div class="row" style="margin-top:6px"><input type="number" id="naAmount" step="0.1" min="0" placeholder="输入 BB 数，然后点上方「自定义」">
      <span class="tiny muted">用于「下注 / 加注」的「自定义」按钮；留空则采用卡片上的建议值。</span></div>
    </details>
  </div>
  <div class="card"><div class="card-title"><h2>动作时间线</h2><span class="tiny muted">点任意一条可编辑 / 删除 / 设为决策点</span></div>
    ${timelineHtml(h, idxs, di)}
    <div class="row" style="margin-top:10px">
      <button class="btn sm" data-act="undoAction" ${acts.length ? '' : 'disabled'}>↶ 撤销末条</button>
      <button class="btn sm" data-act="clearActions" ${acts.length ? '' : 'disabled'}>清空</button>
      <button class="btn sm" data-act="foldToHero" title="一次性生成翻前 Hero 之前所有位置的弃牌">翻前弃牌到 Hero</button>
      <button class="btn sm" data-act="toggleBulk">${ui.act.bulk ? '收起批量录入' : '批量粘贴录入'}</button>
      <button class="btn sm" data-act="loadExampleActions">填充标准示例</button>
    </div>
    ${ui.act.bulk ? `<div class="bulk-box"><div class="small muted">每行一条街，逗号分隔动作；支持中英文动作名，金额可省略（自动按状态机补齐）。公共牌请在第一步录入。</div>
      <textarea id="bulkActions" rows="6" spellcheck="false" placeholder="Preflop: UTG fold, BTN raise 5, BB call 5&#10;Flop: BB check, BTN bet 3.3, BB call">${esc(wizard.bulkText || '')}</textarea>
      <div class="row" style="margin-top:8px"><button class="btn sm" data-act="bulkLoadExample">载入示例</button><button class="btn primary sm" data-act="bulkParse">解析并替换行动流</button></div>
      ${wizard.bulkInfo ? `<div class="${wizard.bulkInfo.ok ? 'notice info' : 'notice danger'}" style="margin-top:8px">${esc(wizard.bulkInfo.msg)}</div>` : ''}</div>` : ''}
  </div>
  <div class="card"><h2>决策点</h2><div class="small muted">复盘的是「Hero 在该节点应该怎么打」。默认取最后一个 Hero 翻后动作；点下方标签可切换。</div>
    <div class="row" style="margin-top:8px">${idxs.length ? idxs.map(i => `<button class="chip ${i === di ? 'on' : ''}" data-act="setDecision" data-v="${i}">#${i + 1} ${esc(formatAction(h.actions[i]))}</button>`).join('') : '<span class="small muted">尚未录入 Hero 翻后动作 · 若想复盘「还没行动的这一步」，可直接解算当前局面</span>'}</div>
  </div>
  <div class="card"><h2>状态校验</h2>
    ${v.errors.length ? `<div class="notice danger">${v.errors.map(e => esc(e.path + '：' + e.msg)).join('<br>')}</div>` : '<div class="notice info">行动流校验通过</div>'}
    ${v.warnings.length ? `<div class="notice" style="margin-top:8px">${v.warnings.map(esc).join('<br>')}</div>` : ''}
    <div class="small muted" style="margin-top:8px">当前局面：底池 ${fmt(live.pot ?? v.computedPotBB, 1)} BB · 待跟注 ${fmt(toCall, 1)} BB；行动流推算底池 ${fmt(v.computedPotBB, 1)} BB（含盲注）。</div>
  </div>`;
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
      ${canDecision ? `<button class="btn" data-act="setDecision" data-v="${i}" data-close="1">设为决策点</button>` : '<span class="tiny muted">仅 Hero 的翻后动作可作决策点</span>'}
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
  const rd = solveReadiness(wizard.hand);
  if (!rd.ready) { openReadiness(rd); return; }
  submitSolve(wizard.hand, selectedDecisionIndex(wizard.hand));
}
function sizeChips(h) {
  const presets = [[0.33, '33%'], [0.5, '50%'], [0.67, '67%'], [1, '满池'], [1.33, '超池']];
  return presets.map(([v, n]) => `<button class="chip ${h.sizes.includes(v) ? 'on' : ''}" data-act="toggleSize" data-v="${v}">${n}</button>`).join('');
}
function wizardStep3(h) {
  return `<div class="card"><h2>④ 对手范围与求解参数</h2>
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
      <label class="field"><span>求解档位</span><select data-bind="preset"><option value="fast" ${h.preset === 'fast' ? 'selected' : ''}>快解（迭代较少）</option><option value="precise" ${h.preset === 'precise' ? 'selected' : ''}>精解（迭代更多）</option></select></label>
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
function wizardStep4(h, di, v) {
  const st = deriveState(h, di);
  const act = h.actions[di];
  const req = buildSolveReq(h, di);
  return `<div class="card"><h2>⑤ 校验并提交</h2>
    <div class="grid g2">
      ${statLine('决策点', req.decisionNode)}
      ${statLine('公共牌', st.board.map(cardStr).join(' ') || '—')}
      ${statLine('Hero 手牌', (h.heroCards || []).map(cardStr).join(' ') || '—')}
      ${statLine('当前底池', fmt(req.pot, 1) + ' BB')}
      ${statLine('有效后手', fmt(req.stack, 1) + ' BB')}
      ${statLine('面对下注', st.facingBet > 0 ? fmt(st.facingBet, 1) + ' BB' : '无（可过牌）')}
      ${statLine('求解模式', h.mode === 'exploit' ? '剥削 · ' + (ARCHETYPES.find(a => a.id === h.archetype)?.name || '') : '标准 GTO')}
      ${statLine('尺度集合', (h.sizes || []).map(s => Math.round(s * 100) + '%').join(' / '))}
      ${statLine('实际动作', act ? formatAction(act) : '未录入（隐藏实现 EV 差）')}
      ${statLine('范围组合', 'Hero / Villain 按 13×13 矩阵展开')}
    </div>
    <div class="hr"></div>
    ${v.errors.length ? `<div class="notice danger"><b>校验未通过</b><br>${v.errors.map(e => esc(e.path + '：' + e.msg)).join('<br>')}</div>` : '<div class="notice info">行动流状态机校验通过（牌面唯一性、街序、最小加注、后手上限）</div>'}
    ${v.warnings.length ? `<div class="notice" style="margin-top:8px">${v.warnings.map(esc).join('<br>')}</div>` : ''}
    ${!v.solveAllowed ? '<div class="notice danger" style="margin-top:8px">V1.0 仅输出单挑底池求解结果：请确认公共牌 ≥3 张且翻后仅两家行动。</div>' : ''}
    <div class="notice" style="margin-top:8px">求解在浏览器 Worker 中执行，不阻塞页面；分支过大时会提示压缩尺度集合或收窄范围。结果为<b>近似均衡</b>（牌力分档抽象 + 街内有限博弈树 + CFR）。</div>
  </div>`;
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
      <div class="notice">求解范围：翻后单挑；无抽水；近似均衡。超过 60 秒可继续留在页面等待，结果会自动刷新。</div>`;
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
  const maxFreq = Math.max(0.0001, ...shown.actions.map(a => a.freq));
  const bestEV = Math.max(...shown.actions.map(a => a.ev));
  const idxs = heroDecisionIndices(h);
  app.innerHTML = `
  <div class="page-head"><div><h1>求解结果</h1><p class="sub">${esc(r.decisionNode || '')} · 底池 ${fmt(r.pot, 1)} BB · 后手 ${fmt(r.stacks, 1)} BB</p></div>
    <div class="row"><button class="btn sm" data-act="resCopy" data-id="${esc(job.id)}">复制牌谱</button><button class="btn sm" data-act="resPNG" data-id="${esc(job.id)}">导出图片</button></div></div>
  <div class="tabs">
    <button class="${tab === 'gto' ? 'on' : ''}" data-act="resTab" data-v="gto" data-id="${esc(job.id)}">GTO 均衡</button>
    ${r.gtoActions ? `<button class="${tab === 'exploit' ? 'on' : ''}" data-act="resTab" data-v="exploit" data-id="${esc(job.id)}">剥削路线</button>` : ''}
  </div>
  <div class="card"><h2>行动回放与决策点</h2><div class="action-list">
    ${(h.actions || []).length ? h.actions.map((a, i) => `<div class="action-item ${idxs.includes(i) ? 'click' : ''} ${i === job.params.decisionIndex ? 'on' : ''}" ${idxs.includes(i) ? `data-act="resDecision" data-id="${esc(job.id)}" data-v="${i}"` : ''}>
      <span class="st">${esc(String(a.street).slice(0, 4))}</span><span class="ac">${esc(formatAction(a))}</span>${i === job.params.decisionIndex ? '<span class="tag">当前</span>' : ''}</div>`).join('') : '<div class="empty">无行动记录</div>'}
  </div><div class="tiny muted" style="margin-top:6px">点击 Hero 决策可切换复盘节点（重新求解）</div></div>
  <div class="card"><div class="card-title"><h2>${tab === 'exploit' ? '剥削路线输出' : '均衡输出'}</h2><span class="pill">EV 单位：BB</span></div>
    <div class="table-wrap"><table class="ev-table"><thead><tr><th>动作</th><th class="num">${tab === 'exploit' ? '剥削频率' : '均衡频率'}</th><th class="num">动作 EV</th><th>标签</th></tr></thead><tbody>
      ${shown.actions.map((a, i) => {
        const badge = a.freq >= 0.66 ? '<span class="badge hi">高频</span>' : a.freq >= 0.33 ? '<span class="badge mid">混合</span>' : a.freq > 0 ? '<span class="badge lo">低频</span>' : '<span class="badge zero">零频率</span>';
        return `<tr class="${a.ev >= bestEV - 1e-9 ? 'hl' : ''}"><td>${esc(a.label || a.type)}${a.sizeBB != null ? ` <span class="tiny muted">${fmt(a.sizeBB, 1)} BB</span>` : ''}</td>
          <td class="num">${(a.freq * 100).toFixed(1)}%<div class="bar" style="margin-top:3px"><i style="width:${(a.freq / maxFreq * 100).toFixed(0)}%"></i></div></td>
          <td class="num ${a.ev >= 0 ? 'up' : 'down'}">${fmt(a.ev)}</td><td>${badge}</td></tr>`;
      }).join('')}
    </tbody></table></div>
    <div class="hr"></div>
    <div class="grid g2">
      ${statLine('推荐主行动', shown.actions.slice().sort((a, b) => b.freq - a.freq)[0]?.label || '—')}
      ${statLine('最优动作 EV', fmt(bestEV) + ' BB')}
      ${statLine('实现 EV 差', shown.evLossBB != null ? fmt(shown.evLossBB) + ' BB' : '未录入实际动作（隐藏）')}
      ${statLine('收敛信息', `${r.iterations} 次迭代 · ${r.durationMs} ms`)}
      ${statLine('可剥削度', r.exploitabilityMbb != null ? fmt(r.exploitabilityMbb, 1) + ' mbb/hand' : '剥削模式不输出')}
      ${statLine('树规模', (r.treeSize || '—') + ' 节点')}
    </div>
    ${shown.focus ? `<div class="hr"></div><h3>你的手牌 ${esc(shown.focus.cards.join(' '))}（牌力档 ${shown.focus.bucket}）</h3><div class="small muted">该手牌对 Villain 范围权益约 ${(shown.focus.equityVsVillainRange * 100).toFixed(1)}%；节点策略：${shown.focus.strategy.map(s => `${esc(s.label)} ${(s.freq * 100).toFixed(0)}%`).join(' · ')}</div>` : ''}
  </div>
  ${r.mode === 'exploit' ? renderExploitBlock(r, tab) : ''}
  ${r.gtoActions && tab === 'exploit' ? renderCompareTable(r) : ''}
  <div class="card"><h2>范围热力图</h2><div class="grid g2"><div id="heatHero"></div><div id="heatVillain"></div></div>
    <div class="tiny muted" style="margin-top:8px">按 13×13 手牌类别聚合并按进攻/加注频率着色；颜色越深频率越高。</div></div>
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
  <div class="tiny muted">求解口径：10 档牌力抽象 + 街内有限博弈树 + CFR 线性平均；${r.mode === 'exploit' ? '剥削路线按所选对手画像冻结策略后求解。' : '近似均衡，非商用 Solver 精度。'}</div>`;
}
function progressHtml(job) {
  const p = job.progress || 0;
  return `<div class="row between"><span class="small">${esc(job.progressLabel || '求解中')}</span><span class="small mono">${(p * 100).toFixed(0)}%${job.etaMs ? ' · 预计剩余 ' + Math.ceil(job.etaMs / 1000) + 's' : ''}</span></div>
  <div class="progress" style="margin-top:6px"><i style="width:${Math.round(p * 100)}%"></i></div>
  <div class="row end" style="margin-top:8px"><button class="btn sm" data-act="cancelJob" data-id="${esc(job.id)}">取消任务</button></div>`;
}
function renderExploitBlock(r, tab) {
  const A = ARCHETYPES.find(a => a.id === r.archetype);
  return `<div class="card"><h2>剥削模式（对手画像）</h2><div class="grid g2">
    ${statLine('对手画像', (A ? A.name + ' ' + A.tag : r.archetypeLabel) || '—')}
    ${statLine('强度档', r.intensity === 0.5 ? '轻度' : r.intensity === 1.5 ? '重度' : '中度')}
    ${statLine('剥削增益', r.exploitGainBB != null ? fmt(r.exploitGainBB) + ' BB' : '—')}
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
  const s = isNew ? { id: makeId('session'), name: '', date: today(), type: 'offline', stakes: { sb: 1, bb: 2 }, buyins: [100], cashout: 100, bbValue: 0, note: '' } : state().sessions.find(x => x.id === id);
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
        if (a) renderHeatmapGrid(a, job.result.heatmap.hero, { title: 'Hero 均衡进攻范围', legend: '颜色越深 = 下注/加注频率越高' });
        if (b) renderHeatmapGrid(b, job.result.heatmap.villain, { title: 'Villain 范围与应对象', legend: '颜色越深 = 面对下注时不弃牌倾向越高' });
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
function handleBind(target) {
  if (!wizard) return;
  const h = wizard.hand;
  const path = target.dataset.bind;
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
    if (path === 'tableSize') { h.tableSize = v === 9 ? 9 : 6; const pos = positionsFor(h.tableSize); if (!pos.includes(h.positions.hero)) h.positions.hero = 'BTN'; if (!pos.includes(h.positions.villain)) h.positions.villain = 'BB'; return; }
  }
  setPath(h, path, v);
  saveDraft(h);
}
function saveWizard() { if (wizard) saveDraft(wizard.hand); }
function refresh() { saveWizard(); render(); }

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
  if (t.dataset.act === 'setActor') { ui.act.actor = t.value; render(); return; }
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
    case 'useParsed': {
      const h = wizard.parseInfo.hand;
      wizard.hand = h; wizard.step = 3; wizard.decisionIndex = null; ui.wizTab = 'wizard'; wizard.wizTab = 'wizard';
      saveWizard(); render(); toast('已载入牌谱，请配置范围与求解模式'); break;
    }
    case 'pickCard': openCardPicker(ds.kind, Number(ds.idx)); break;
    case 'pickCardCell': {
      const c = Number(ds.c), h = wizard.hand, p = pendingPick;
      if (!p) break;
      const cur = p.kind === 'board' ? h.board[p.idx] : p.kind === 'hero' ? h.heroCards[p.idx] : p.kind === 'villain' ? h.villainCards[p.idx] : null;
      if (c === cur) { closeModal(); break; }
      const all = [...h.heroCards, ...h.villainCards, ...h.board, ...h.deadCards];
      if (all.includes(c)) { toast('该牌已被使用，请选择其他牌'); break; }
      if (p.kind === 'hero') h.heroCards[p.idx] = c;
      else if (p.kind === 'villain') h.villainCards[p.idx] = c;
      else if (p.kind === 'board') h.board[p.idx] = c;
      else h.deadCards.push(c);
      closeModal(); refresh(); break;
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
    case 'nextStreet': ui.act.street = v; ui.act.actor = null; render(); break;
    case 'quickAction': {
      const h = wizard.hand, street = actStreet(h), actor = nextActorFor(h, street);
      const { live } = liveFor(h, street);
      const sug = suggestedAmounts(h, live);
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
      const si = STREETS.indexOf(street);
      let insertAt = h.actions.length;
      for (let k = h.actions.length - 1; k >= 0; k--) {
        if (STREETS.indexOf(String(h.actions[k].street).toUpperCase()) <= si) { insertAt = k + 1; break; }
        insertAt = k;
      }
      h.actions.splice(insertAt, 0, { street, actor, type: v, amountBB });
      ui.act.actor = null; wizard.decisionIndex = null; wizard.bulkInfo = null;
      const label = `${actor} ${ACTION_LABEL[v]}${amountBB != null ? ' ' + fmt(amountBB, 1) + ' BB' : ''}`;
      ui.act.flash = { idx: insertAt, at: Date.now() };
      saveWizard(); render();
      const next = nextActorFor(h, street);
      toast(`已录入 #${insertAt + 1} · ${label} · 轮到 ${next}`);
      break;
    }
    case 'beginSolve': beginSolve(); break;
    case 'showReadiness': openReadiness(solveReadiness(wizard.hand)); break;
    case 'goStep': wizard.step = Math.max(1, Math.min(4, Number(v) || 1)); closeModal(); saveWizard(); render(); break;
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
    case 'undoAction': wizard.hand.actions.pop(); wizard.decisionIndex = null; refresh(); break;
    case 'clearActions': {
      confirmDialog('清空行动流', '将删除已录入的全部行动，是否继续？', () => {
        wizard.hand.actions = []; wizard.decisionIndex = null;
        ui.act.street = null; ui.act.actor = null; refresh();
      }, '清空');
      break;
    }
    case 'foldToHero': {
      const h = wizard.hand, pos = positionsFor(h.tableSize);
      const hero = String(h.positions.hero).toUpperCase();
      const hi = pos.findIndex(x => x.toUpperCase() === hero);
      if (hi <= 0) { toast('Hero 位置已是首位或不在座位表中，无需生成弃牌'); break; }
      const rest = (h.actions || []).filter(a => String(a.street).toUpperCase() !== 'PREFLOP');
      h.actions = [...pos.slice(0, hi).map(actor => ({ street: 'PREFLOP', actor, type: 'FOLD', amountBB: null })), ...rest];
      wizard.decisionIndex = null; ui.act.street = 'PREFLOP'; ui.act.actor = hero;
      refresh(); toast(`已生成 ${hi} 条翻前弃牌，下一位 ${hero}`); break;
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
      const chk = validateHand(wizard.hand);
      const actionErrs = chk.errors.filter(e => String(e.path).startsWith('actions'));
      const otherErrs = chk.errors.length - actionErrs.length;
      wizard.bulkInfo = {
        ok: actionErrs.length === 0,
        msg: `已录入 ${acts.length} 条动作`
          + (actionErrs.length ? '；行动流错误：' + actionErrs.slice(0, 3).map(e => e.msg).join('；') : '，行动流校验通过')
          + (r.warnings.length ? '（' + r.warnings.join('；') + '）' : '')
          + (otherErrs ? '（手牌 / 公共牌请在第一步补齐）' : '')
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
      h.result = 'hero'; wizard.decisionIndex = null; refresh(); toast('已填充标准示例牌谱'); break;
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
  $('#versionTag').textContent = 'V1.2 · 翻后单挑';
  render();
})();
