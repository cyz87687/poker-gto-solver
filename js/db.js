/* db.js —— 本地持久化、统计计算、导入导出
 * IndexedDB 为主存储，localStorage 作镜像与降级（file:// / 隐私模式）。
 */
import { BUILTIN_TAGS, handProfitBB, handClass, serializeHH, actorSide } from './hand.js';

const DB_NAME = 'poker_gto_review';
const STORE = 'kv';
const KEY = 'state_v1';
const LS_KEY = 'poker_gto_review_state_v1';

export function defaultState() {
  return {
    version: 1,
    settings: { period: '30d', currency: '¥', solvePreset: 'fast', lastBackupAt: null },
    sessions: [], hands: [], jobs: [], ranges: [], tags: BUILTIN_TAGS.slice(), draft: null,
    updatedAt: new Date().toISOString()
  };
}
let cache = null;
let idb = null;

function openIDB() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { resolve(null); return; }
    let req;
    try { req = indexedDB.open(DB_NAME, 1); } catch (e) { resolve(null); return; }
    req.onupgradeneeded = () => { const d = req.result; if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}
function idbGet(db, key) {
  return new Promise(resolve => {
    if (!db) { resolve(null); return; }
    try {
      const tx = db.transaction(STORE, 'readonly');
      const r = tx.objectStore(STORE).get(key);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => resolve(null);
    } catch (e) { resolve(null); }
  });
}
function idbSet(db, key, val) {
  return new Promise(resolve => {
    if (!db) { resolve(false); return; }
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(val, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch (e) { resolve(false); }
  });
}
export async function initDB() {
  idb = await openIDB();
  let data = await idbGet(idb, KEY);
  if (!data && typeof localStorage !== 'undefined') {
    try { data = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (e) { data = null; }
  }
  cache = normalizeState(data);
  return cache;
}
function normalizeState(s) {
  const d = defaultState();
  if (!s || typeof s !== 'object') return d;
  return {
    ...d, ...s,
    settings: { ...d.settings, ...(s.settings || {}) },
    sessions: Array.isArray(s.sessions) ? s.sessions : [],
    hands: Array.isArray(s.hands) ? s.hands : [],
    jobs: Array.isArray(s.jobs) ? s.jobs : [],
    ranges: Array.isArray(s.ranges) ? s.ranges : [],
    tags: Array.isArray(s.tags) && s.tags.length ? s.tags : d.tags
  };
}
export function state() { return cache || (cache = defaultState()); }
export function persist() {
  const s = state();
  s.updatedAt = new Date().toISOString();
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch (e) { /* 配额不足时仍保留内存态 */ }
  if (idb) idbSet(idb, KEY, JSON.parse(JSON.stringify(s))).catch(() => {});
  return s;
}
/** 同步修改内存态 + 异步持久化 */
export function commit(fn) { const r = fn(state()); persist(); return r; }
export function saveDraft(draft) { commit(s => { s.draft = draft; }); }
export function clearDraft() { commit(s => { s.draft = null; }); }

/* ---------------- CRUD ---------------- */
export function upsertSession(session) {
  return commit(s => {
    const i = s.sessions.findIndex(x => x.id === session.id);
    if (i >= 0) s.sessions[i] = { ...s.sessions[i], ...session };
    else s.sessions.push(session);
    return session;
  });
}
export function removeSession(id) {
  return commit(s => {
    s.sessions = s.sessions.filter(x => x.id !== id);
    s.hands.forEach(h => { if (h.sessionId === id) h.sessionId = null; });
  });
}
export function upsertHand(hand) {
  return commit(s => {
    const i = s.hands.findIndex(x => x.id === hand.id);
    hand.updatedAt = new Date().toISOString();
    if (i >= 0) s.hands[i] = { ...s.hands[i], ...hand };
    else s.hands.push(hand);
    return hand;
  });
}
export function removeHand(id) { return commit(s => { s.hands = s.hands.filter(h => h.id !== id); }); }
export function bindHand(handId, sessionId) {
  const h = state().hands.find(x => x.id === handId);
  if (!h) return null;
  h.sessionId = sessionId || null; persist(); return h;
}
export function upsertJob(job) {
  return commit(s => {
    const i = s.jobs.findIndex(x => x.id === job.id);
    if (i >= 0) s.jobs[i] = { ...s.jobs[i], ...job }; else s.jobs.push(job);
    if (s.jobs.length > 40) s.jobs = s.jobs.slice(-40);
    return job;
  });
}
/* 求解器版本令牌：迭代口径/预算变更时递增，仅使旧缓存不再命中（旧 job 数据保留不动） */
const SOLVER_REV = 'v1.8';
export function findCachedJob(hand, params) {
  const key = JSON.stringify([hand.id, params.mode, params.archetype, params.intensity, params.sizes, params.pot, params.stack, params.decisionIndex, params.preset, SOLVER_REV]);
  return state().jobs.find(j => j.cacheKey === key && j.status === 'done' && j.result) || null;
}
export function jobCacheKey(hand, params) {
  return JSON.stringify([hand.id, params.mode, params.archetype, params.intensity, params.sizes, params.pot, params.stack, params.decisionIndex, params.preset, SOLVER_REV]);
}

/* ---------------- 工具 ---------------- */
export function escapeHtml(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- 统计 ---------------- */
export function sessionNet(s) {
  const buy = (s.buyins || []).reduce((a, b) => a + (Number(b) || 0), 0);
  return Math.round(((Number(s.cashout) || 0) - buy) * 100) / 100;
}
export function sessionBuyin(s) {
  return (s.buyins || []).reduce((a, b) => a + (Number(b) || 0), 0);
}
function inPeriod(dateStr, period, now = Date.now()) {
  if (period === 'all') return true;
  const t = new Date(dateStr).getTime();
  if (!Number.isFinite(t)) return true;
  const days = period === '7d' ? 7 : period === 'quarter' ? 90 : 30;
  return now - t <= days * 86400000;
}
export function computeStats(period = 'all') {
  const s = state();
  const sessions = s.sessions.filter(x => inPeriod(x.date, period)).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const hands = s.hands.filter(h => inPeriod(h.createdAt, period));
  let cum = 0, peak = 0, maxDD = 0;
  const curve = sessions.map((ses, i) => {
    cum += sessionNet(ses); peak = Math.max(peak, cum); maxDD = Math.max(maxDD, peak - cum);
    return { index: i, label: ses.name || ses.date, date: ses.date, value: Math.round(cum * 100) / 100, single: sessionNet(ses) };
  });
  const bar = sessions.map(ses => ({ label: ses.name || ses.date, value: sessionNet(ses) }));
  const net = sessions.reduce((a, x) => a + sessionNet(x), 0);
  const buyin = sessions.reduce((a, x) => a + sessionBuyin(x), 0);
  const wins = sessions.filter(x => sessionNet(x) > 0).length;
  const losses = sessions.filter(x => sessionNet(x) < 0).length;
  let profitBB = 0, vpip = 0, pfr = 0, threeBet = 0, n = 0;
  const byPosition = {}, byClass = {};
  const bbValue = (ses) => Number(ses?.bbValue) || 0;
  for (const h of hands) {
    const p = handProfitBB(h);
    profitBB += p; n++;
    const pos = h.positions?.hero || '未知';
    byPosition[pos] = (byPosition[pos] || 0) + p;
    const cls = handClass(h);
    byClass[cls] = (byClass[cls] || 0) + p;
    const pre = (h.actions || []).filter(a => String(a.street).toUpperCase() === 'PREFLOP' && actorSide(h, a.actor) === 'hero');
    if (pre.some(a => ['CALL', 'BET', 'RAISE_TO', 'ALLIN'].includes(a.type))) vpip++;
    let seenRaise = false, did3bet = false;
    for (const a of (h.actions || []).filter(x => String(x.street).toUpperCase() === 'PREFLOP')) {
      if (['BET', 'RAISE_TO', 'ALLIN'].includes(a.type)) {
        if (seenRaise && actorSide(h, a.actor) === 'hero') did3bet = true;
        seenRaise = true;
      }
    }
    if (pre.some(a => ['BET', 'RAISE_TO', 'ALLIN'].includes(a.type))) pfr++;
    if (did3bet) threeBet++;
  }
  const pct = x => n ? Math.round(x / n * 1000) / 10 : 0;
  return {
    period, sessionCount: sessions.length, handCount: n,
    totalNet: Math.round(net * 100) / 100, totalBuyin: Math.round(buyin * 100) / 100,
    avgPerHandBB: n ? Math.round(profitBB / n * 100) / 100 : 0,
    bbPer100: n ? Math.round(profitBB / n * 10000) / 100 : 0,
    wins, losses, maxWin: sessions.length ? Math.max(...sessions.map(x => sessionNet(x))) : 0,
    maxDrawdown: Math.round(maxDD * 100) / 100,
    vpip: pct(vpip), pfr: pct(pfr), threeBet: pct(threeBet),
    curve, bar, byPosition, byClass,
    sampleWarning: n < 100
  };
}

/* ---------------- 导入导出 ---------------- */
export function exportJSON() {
  return JSON.stringify({ format: 'poker-gto-review-backup', version: 1, exportedAt: new Date().toISOString(), data: state() }, null, 2);
}
export function importJSON(text, mode = 'merge') {
  let obj;
  try { obj = JSON.parse(text); } catch (e) { throw new Error('JSON 解析失败：' + e.message); }
  const data = obj && obj.data ? obj.data : obj;
  if (!data || typeof data !== 'object' || !Array.isArray(data.sessions) || !Array.isArray(data.hands)) throw new Error('备份文件格式不正确（缺少 sessions / hands）');
  const incoming = normalizeState(data);
  return commit(s => {
    if (mode === 'overwrite') {
      s.sessions = incoming.sessions; s.hands = incoming.hands; s.jobs = incoming.jobs;
      s.ranges = incoming.ranges; s.tags = incoming.tags; s.settings = { ...s.settings, ...incoming.settings };
    } else {
      const merge = (key) => {
        const ids = new Set(s[key].map(x => x.id));
        for (const item of incoming[key]) if (!ids.has(item.id)) { s[key].push(item); ids.add(item.id); }
      };
      merge('sessions'); merge('hands'); merge('jobs'); merge('ranges');
      for (const t of incoming.tags) if (!s.tags.includes(t)) s.tags.push(t);
    }
    return { sessions: s.sessions.length, hands: s.hands.length };
  });
}
export function exportSessionsCSV() {
  const rows = [['日期', '对局名称', '类型', '盲注', '总买入', '结算', '净盈亏', '手牌数', '备注']];
  for (const s of state().sessions) {
    const hands = state().hands.filter(h => h.sessionId === s.id).length;
    rows.push([s.date, s.name, s.type === 'online' ? '线上' : '线下', `${s.stakes?.sb}/${s.stakes?.bb}`,
      sessionBuyin(s), s.cashout, sessionNet(s), hands, (s.note || '').replace(/[\r\n,]/g, ' ')]);
  }
  return '\ufeff' + rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
}
export function exportHandHH(hand) { return serializeHH(hand); }
export function downloadText(filename, content, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 500);
}
