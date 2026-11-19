/* freq-view.js —— V1.19 图形化频率展示（纯函数 / 无 DOM / 无副作用）
 * 设计目标：把求解结果里的频率按「宽度即数值」可视化，并支持点击下钻到花色组合。
 * 颜色沿用现有策略热力图口径：弃牌灰蓝、跟注蓝、加注红（红=进攻，与 A 股涨色同源）。 */
import { RANKS, SUITS, SUIT_SYM } from './cards.js?v=1.18.3';

export const FREQ_COLORS = {
  fold:  { solid: '#6b7787', soft: '#e8ecf3', fg: '#5a6678', letter: 'F', name: '弃牌' },
  call:  { solid: '#3b5bdb', soft: '#cfe0fb', fg: '#1c4ea8', letter: 'C', name: '跟注' },
  raise: { solid: '#d92b2b', soft: '#f6d4d4', fg: '#b3261e', letter: 'R', name: '加注' }
};

const escv = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = v => (Number(v) * 100).toFixed(1) + '%';
const clamp01 = v => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0; };

/** 动作类型归到三条主色：FOLD→弃，CALL/CHECK→跟，BET/RAISE/ALLIN→加 */
export function actionKind(a) {
  const t = String((a && a.type) || '').toUpperCase();
  if (t === 'FOLD') return 'fold';
  if (t === 'CALL' || t === 'CHECK') return 'call';
  return 'raise';
}

/** 动作数组 → 频率展示项。focus 存在时附带「你的手牌」条件频率。 */
export function freqItems(actions, focus) {
  return (actions || []).map((a, i) => {
    const f = focus && focus.strategy && focus.strategy[i];
    return {
      i, type: a.type, label: a.label || a.type, sizeBB: a.sizeBB, ev: a.ev,
      kind: actionKind(a), freq: clamp01(a.freq),
      focusFreq: f ? clamp01(f.freq) : null
    };
  });
}

/** 手牌类别索引 → 该类别全部合法的花色组合（去掉被公共牌/已知牌阻挡的）。
 * 索引约定与 cards.js::comboClassIndices 一致：i===j 对子，i>j 同花，i<j 非同花。 */
export function comboCodesForClass(i, j, blocked = []) {
  const block = new Set((blocked || []).filter(Boolean).map(x => String(x).slice(0, 3)));
  const out = [], hi = RANKS[i], lo = RANKS[j];
  const add = (a, b) => { if (!block.has(a) && !block.has(b)) out.push(a + b); };
  if (i === j) {
    for (let s1 = 0; s1 < 4; s1++) for (let s2 = s1 + 1; s2 < 4; s2++) add(hi + SUITS[s1], hi + SUITS[s2]);
  } else if (i > j) {
    for (let s = 0; s < 4; s++) add(hi + SUITS[s], lo + SUITS[s]);
  } else {
    for (let s1 = 0; s1 < 4; s1++) for (let s2 = 0; s2 < 4; s2++) if (s1 !== s2) add(lo + SUITS[s1], hi + SUITS[s2]);
  }
  return out;
}
/** 组合码归一：忽略两张牌的先后顺序，便于与 focus.cards 比对 */
export function comboKey(code) { return String(code || '').match(/[2-9TJQKA][cdhs]/g)?.sort().join('') || ''; }
function comboLabel(code) {
  return String(code || '').replace(/([2-9TJQKA])([cdhs])/g, (_, r, s) => r + SUIT_SYM[s]);
}

/** 动作项 → 三路频率（弃 / 跟 / 加） */
export function threeWay(items) {
  const o = { fold: 0, call: 0, raise: 0 };
  (items || []).forEach(it => { o[it.kind] += it.freq; });
  return o;
}
function threeWayFromCell(cell) {
  return { fold: clamp01(cell && cell.fold), call: clamp01(cell && cell.call), raise: clamp01(cell && cell.raise) };
}

/* ---------- 频率条（宽度 = 数值） ---------- */
function barSegments(parts, opts = {}) {
  const small = opts.small ? ' fd-bar-sm' : '';
  return `<div class="fd-bar${small}">` + parts.map(p => {
    const w = Math.max(0, Math.min(100, p.freq * 100));
    const c = FREQ_COLORS[p.kind];
    const showText = w >= (opts.small ? 22 : 13);
    return `<div class="fd-seg" style="width:${w.toFixed(2)}%;background:${c.solid}" title="${escv(p.label)} ${pct(p.freq)}">${showText ? `<span>${escv(p.label)}</span><b>${pct(p.freq)}</b>` : ''}</div>`;
  }).join('') + '</div>';
}

function barLegend(parts) {
  return `<div class="fd-bar-legend">` + parts.map(p => `<span><i style="background:${FREQ_COLORS[p.kind].solid}"></i>${escv(p.label)} <b>${pct(p.freq)}</b></span>`).join('') + '</div>';
}

function miniBar(three) {
  return `<div class="fd-mini">` + ['fold', 'call', 'raise'].map(k =>
    `<i style="width:${(three[k] * 100).toFixed(2)}%;background:${FREQ_COLORS[k].solid}" title="${FREQ_COLORS[k].name} ${pct(three[k])}"></i>`).join('') + '</div>';
}

function scopeBlock(label, items, hint) {
  const valid = items.filter(x => x.freq > 0);
  const ranked = valid.slice().sort((a, b) => b.freq - a.freq);
  const hi = ranked[0], lo = ranked[ranked.length - 1];
  const tiles = items.map(it => {
    const c = FREQ_COLORS[it.kind];
    const badge = hi && it === hi ? '<em class="ft-badge hi">最高</em>' : (lo && it === lo && it !== hi ? '<em class="ft-badge lo">最低</em>' : '');
    return `<button class="freq-tile" data-act="freqAction" data-v="${it.kind}" data-kind="${it.kind}" style="--tile:${c.solid}" title="${escv(it.label)}：${pct(it.freq)}｜点击查看使用该动作的手牌类别">
      <span class="ft-label">${escv(it.label)}</span><b class="ft-pct">${pct(it.freq)}</b>${badge}</button>`;
  }).join('');
  const gap = hi && lo ? ((hi.freq - lo.freq) * 100).toFixed(1) : '0.0';
  return `<div class="freq-scope"><b>${escv(label)}</b><div class="freq-tiles">${tiles}</div></div>
    ${barSegments(ranked.map(it => ({ kind: it.kind, label: it.label, freq: it.freq })))}
    <div class="freq-summary">${hint ? escv(hint) + ' · ' : ''}最高 <b>${hi ? escv(hi.label) + ' ' + pct(hi.freq) : '—'}</b>${lo && lo !== hi ? ` · 最低非零 <b>${escv(lo.label)} ${pct(lo.freq)}</b> · 高低差 <b>${gap}pp</b>` : ''}</div>`;
}

/** 结果页顶部：全范围 / 你的手牌 两行频率总览 */
export function freqOverviewHtml(itemsRange, focusItems) {
  if (!itemsRange || !itemsRange.length) return '';
  const scopes = [scopeBlock('全范围', itemsRange, '宽度=频率')];
  if (focusItems && focusItems.length) {
    scopes.push(scopeBlock('你的手牌', focusItems.map(it => ({ ...it, freq: it.focusFreq == null ? it.freq : it.focusFreq })), '手牌级条件频率'));
  }
  return `<div class="freq-panel"><div class="freq-hd"><b>动作频率分布</b><span class="tiny muted">色块宽度 = 频率 · 红=加注 / 蓝=跟注 / 灰=弃牌 · 点击色块或热力格看花色分布</span></div>${scopes.join('<div class="freq-divider"></div>')}</div>`;
}

/* ---------- 点击下钻：手牌类别 → 花色组合 ---------- */
/** 点击 13×13 热力格后的详情：主频率条 + 每个花色组合的小频率条 */
export function freqCellHtml(opts = {}) {
  const { label = '', cell, gtoCell, items, combos = [], focusCode = '', mode = 'gto', note = '' } = opts;
  const three = threeWayFromCell(cell);
  const parts = [['fold', '弃牌', three.fold], ['call', '跟注', three.call], ['raise', '加注', three.raise]].map(([kind, label2, freq]) => ({ kind, label: label2, freq }));
  const main = FREQ_COLORS[cell && cell.main] || FREQ_COLORS.fold;
  const gtoThree = gtoCell ? threeWayFromCell(gtoCell) : null;
  const gtoParts = gtoThree ? [['fold', '弃牌', gtoThree.fold], ['call', '跟注', gtoThree.call], ['raise', '加注', gtoThree.raise]].map(([kind, label2, freq]) => ({ kind, label: label2, freq })) : null;
  const focusKey = comboKey(focusCode);
  const focusThree = items && items.length ? threeWay(items) : null;
  const comboCards = combos.map(code => {
    const isFocus = focusKey && comboKey(code) === focusKey;
    const t = isFocus && focusThree ? focusThree : three;
    return `<div class="fd-combo${isFocus ? ' is-focus' : ''}">
      <div class="fd-combo-hd"><span class="fd-cards">${comboLabel(code)}</span>${isFocus ? '<em class="fd-tag">你的手牌</em>' : ''}</div>
      ${miniBar(t)}
      <div class="fd-combo-vals"><span>弃 ${pct(t.fold)}</span><span>跟 ${pct(t.call)}</span><span>加 ${pct(t.raise)}</span></div>
    </div>`;
  }).join('') || '<div class="empty tiny">该类别的花色组合均被公共牌 / 已知牌阻挡</div>';
  return `<div class="freq-detail">
    <div class="fd-hd"><div><div class="fd-title">${escv(label)} <span class="tiny muted">频率详情</span></div>
      <div class="fd-sub">${escv(mode === 'exploit' ? '剥削路线' : 'GTO 均衡')} · ${cell && cell.n ? cell.n : 0} 个组合 · 主策略 <b style="color:${main.fg}">${escv(main.name)}</b>${cell && cell.mix ? '（混合）' : '（纯策略）'}</div></div>
      <button class="btn sm" data-act="closeModal">关闭</button></div>
    <div class="fd-main"><div class="fd-main-label">动作频率 · ${escv(label)}</div>${barSegments(parts)}${barLegend(parts)}</div>
    ${gtoParts ? `<div class="fd-compare"><div class="fd-cmp-row"><b>剥削路线</b>${barSegments(parts, { small: true })}</div><div class="fd-cmp-row"><b>GTO 基线</b>${barSegments(gtoParts, { small: true })}</div></div>` : ''}
    <div class="fd-combos-title">花色组合 <span class="tiny muted">${combos.length} 种 · 蓝框=你的手牌</span></div>
    <div class="fd-combos">${comboCards}</div>
    <div class="fd-note">${escv(note || '同一种手牌类别的不同花色牌力等价，故类别聚合频率相同；被公共牌或已知牌阻挡的组合不会列出。你的手牌一项用手牌级条件频率，可能与类别聚合略有差异。')}</div>
  </div>`;
}

/** 点击频率色块后的详情：按该动作频率排序的手牌类别清单，可继续点进花色详情 */
export function freqActionHtml(opts = {}) {
  const { kind = 'raise', rows = [], title = '' } = opts;
  const c = FREQ_COLORS[kind] || FREQ_COLORS.raise;
  const list = rows.map(r => `<button class="fd-class-row" data-act="freqCell" data-i="${r.i}" data-j="${r.j}" title="点击查看 ${escv(r.label)} 的花色组合频率">
      <span class="fd-class-name">${escv(r.label)}</span>${miniBar(threeWayFromCell(r.cell))}
      <b>${pct(r.freq)}</b></button>`).join('') || '<div class="empty tiny">该动作在当前策略中没有手牌类别使用</div>';
  return `<div class="freq-detail">
    <div class="fd-hd"><div><div class="fd-title"><span style="color:${c.fg}">${escv(c.name)}</span> <span class="tiny muted">手牌类别分布</span></div>
      <div class="fd-sub">${escv(title)} · 按该动作频率从高到低 · 共 ${rows.length} 类</div></div>
      <button class="btn sm" data-act="closeModal">关闭</button></div>
    <div class="fd-class-list">${list}</div>
    <div class="fd-note">点击任一手牌类别，查看它的完整花色组合与三路频率。</div>
  </div>`;
}
