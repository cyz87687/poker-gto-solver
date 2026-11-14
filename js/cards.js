/* cards.js —— 卡牌编解码、7 张牌牌力评估、范围矩阵与蒙特卡洛权益
 * 纯逻辑模块，无 DOM 依赖，可在 Web Worker / Node 中运行。
 */
export const RANKS = '23456789TJQKA';
export const SUITS = 'cdhs';
export const SUIT_SYM = { c: '\u2663', d: '\u2666', h: '\u2665', s: '\u2660' };

export function parseCard(token) {
  if (typeof token !== 'string') throw new Error('非法牌面: ' + token);
  const t = token.trim();
  if (t.length < 2) throw new Error('非法牌面: ' + token);
  const r = RANKS.indexOf(t[0].toUpperCase());
  const s = SUITS.indexOf(t[1].toLowerCase());
  if (r < 0 || s < 0) throw new Error('非法牌面: ' + token);
  return s * 13 + r;
}
export function cardStr(c) { return RANKS[c % 13] + SUITS[(c / 13) | 0]; }
export function isRed(c) { const s = (c / 13) | 0; return s === 1 || s === 2; }
export function cardLabel(c) { return RANKS[c % 13] + SUIT_SYM[SUITS[(c / 13) | 0]]; }
export function parseCardList(text) {
  const m = String(text || '').replace(/[\[\]]/g, ' ').trim().match(/[2-9TJQKA][cdhs]/gi);
  return m ? m.map(parseCard) : [];
}
export function rankOf(c) { return c % 13; }
export function suitOf(c) { return (c / 13) | 0; }

function packScore(cat, k) {
  let s = cat;
  for (let i = 0; i < 5; i++) s = s * 15 + (k[i] || 0);
  return s;
}
function straightHigh(mask) {
  for (let hi = 14; hi >= 5; hi--) {
    const need = 31 << (hi - 4);
    if ((mask & need) === need) return hi;
  }
  return 0;
}
/** 7 张牌取最佳 5 张；返回可比较的整数（越大越强） */
export function eval7(cards) {
  const rc = new Int32Array(15);
  const sc = [0, 0, 0, 0];
  const sm = [0, 0, 0, 0];
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i], r = (c % 13) + 2, s = (c / 13) | 0;
    rc[r]++; sc[s]++; sm[s] |= 1 << r;
  }
  let mask = 0;
  const desc = [];
  for (let r = 14; r >= 2; r--) {
    if (rc[r]) { mask |= 1 << r; for (let k = 0; k < rc[r]; k++) desc.push(r); }
  }
  if (rc[14]) mask |= 2; // A 亦可作 1，组成轮子顺子
  const kick = (ex, n) => {
    const out = [];
    for (const r of desc) { if (ex.indexOf(r) < 0) { out.push(r); if (out.length === n) break; } }
    return out;
  };
  let fs = -1;
  for (let s = 0; s < 4; s++) if (sc[s] >= 5) { fs = s; break; }
  if (fs >= 0) {
    const fm = sm[fs] | ((sm[fs] & (1 << 14)) ? 2 : 0);
    const sf = straightHigh(fm);
    if (sf) return packScore(8, [sf]);
    const fr = [];
    for (let r = 14; r >= 2; r--) if (sm[fs] & (1 << r)) fr.push(r);
    return packScore(5, fr.slice(0, 5));
  }
  const quads = [], trips = [], pairs = [];
  for (let r = 14; r >= 2; r--) {
    if (rc[r] === 4) quads.push(r);
    else if (rc[r] === 3) trips.push(r);
    else if (rc[r] === 2) pairs.push(r);
  }
  if (quads.length) return packScore(7, [quads[0], ...kick([quads[0]], 1)]);
  if (trips.length) {
    let pr = 0;
    if (trips.length >= 2) pr = trips[1];
    else if (pairs.length) pr = pairs[0];
    if (pr) return packScore(6, [trips[0], pr]);
  }
  const sh = straightHigh(mask);
  if (sh) return packScore(4, [sh]);
  if (trips.length) return packScore(3, [trips[0], ...kick([trips[0]], 2)]);
  if (pairs.length >= 2) return packScore(2, [pairs[0], pairs[1], ...kick([pairs[0], pairs[1]], 1)]);
  if (pairs.length === 1) return packScore(1, [pairs[0], ...kick([pairs[0]], 3)]);
  return packScore(0, desc.slice(0, 5));
}

/** 13x13 范围矩阵：matrix[hi][lo]=权重，hi>lo 为同花，hi<lo 为杂色，hi==lo 为对子 */
export function emptyMatrix() {
  return Array.from({ length: 13 }, () => new Array(13).fill(0));
}
function classScore(i, j) {
  if (i === j) return 0.50 + i * 0.038;
  const hi = Math.max(i, j), lo = Math.min(i, j);
  const suited = i > j;
  const gap = hi - lo;
  let s = 0.10 + hi * 0.030 + lo * 0.022;
  s += suited ? 0.085 : 0;
  s += gap <= 1 ? 0.05 : gap <= 2 ? 0.03 : gap <= 4 ? 0 : -0.03;
  if (hi === 12 && lo >= 10) s += 0.10;
  if (hi >= 11 && lo >= 9) s += 0.03;
  return Math.min(s, 0.98);
}
export const RANGE_PRESETS = [
  { id: 'tag', name: '紧凶（约前 15%）', cut: 0.63 },
  { id: 'btn', name: 'BTN 开池（约前 40%）', cut: 0.46 },
  { id: 'lag', name: '松凶（约前 35%）', cut: 0.49 },
  { id: 'bb', name: 'BB 防守（约前 70%）', cut: 0.33 },
  { id: 'station', name: '跟注站（约前 85%）', cut: 0.24 },
  { id: 'all', name: '全范围（100%）', cut: -1 }
];
export function presetMatrix(id) {
  const p = RANGE_PRESETS.find(x => x.id === id) || RANGE_PRESETS[1];
  const m = emptyMatrix();
  for (let i = 0; i < 13; i++) for (let j = 0; j < 13; j++) {
    m[i][j] = Math.max(0, Math.min(1, (classScore(i, j) - (p.cut - 0.055)) / 0.11));
  }
  return m;
}
/** 对手画像范围宽窄倍率（附录 D），intensity=0.5/1/1.5 */
export function applyRangeWidth(matrix, width, intensity = 1) {
  const w = 1 + (width - 1) * intensity;
  const out = emptyMatrix();
  for (let i = 0; i < 13; i++) for (let j = 0; j < 13; j++) {
    const v = matrix[i][j] || 0;
    out[i][j] = w >= 1
      ? Math.min(1, v + (w - 1) * 0.28 * (1 - v))
      : Math.max(0, v * Math.pow(Math.max(w, 0.2), 1.5));
  }
  return out;
}
export function comboClass(c1, c2) {
  const a = rankOf(c1), b = rankOf(c2), suited = suitOf(c1) === suitOf(c2);
  const hi = Math.max(a, b), lo = Math.min(a, b);
  if (hi === lo) return [hi, lo];
  return suited ? [hi, lo] : [lo, hi];
}
export function classLabel(i, j) {
  if (i === j) return RANKS[i] + RANKS[j];
  return RANKS[Math.max(i, j)] + RANKS[Math.min(i, j)] + (i > j ? 's' : 'o');
}
/** 展开为 1326 组合（剔除与 used 冲突的组合），按权重过滤 */
export function matrixToCombos(matrix, used = [], minWeight = 0.02, cap = 420) {
  const blocked = new Set(used);
  const out = [];
  for (let i = 0; i < 13; i++) for (let j = 0; j < 13; j++) {
    const w = matrix[i][j] || 0;
    if (w < minWeight) continue;
    const hi = i === j ? i : Math.max(i, j);
    const lo = i === j ? i : Math.min(i, j);
    const suited = i > j;
    const pair = i === j;
    for (let s1 = 0; s1 < 4; s1++) for (let s2 = 0; s2 < 4; s2++) {
      if (pair && s2 <= s1) continue;
      if (!pair && suited && s1 !== s2) continue;
      if (!pair && !suited && s1 === s2) continue;
      if (!pair && !suited && hi === lo) continue;
      const c1 = s1 * 13 + hi, c2 = s2 * 13 + lo;
      if (blocked.has(c1) || blocked.has(c2)) continue;
      out.push([c1, c2, w]);
    }
  }
  if (out.length > cap) {
    const step = out.length / cap;
    const sampled = [];
    for (let k = 0; k < cap; k++) sampled.push(out[Math.floor(k * step)]);
    return sampled;
  }
  return out;
}
export function handClassOfCards(cards) {
  if (!cards || cards.length !== 2) return '未知';
  const [a, b] = cards;
  const ra = rankOf(a), rb = rankOf(b), suited = suitOf(a) === suitOf(b);
  if (ra === rb) return '对子';
  const gap = Math.abs(ra - rb);
  if (suited && gap <= 2) return '同花连张';
  if (suited) return '同花散牌';
  if (ra >= 10 && rb >= 10) return '高张';
  return '其他';
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
export function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
export function deckExcluding(used) {
  const b = new Set(used), out = [];
  for (let c = 0; c < 52; c++) if (!b.has(c)) out.push(c);
  return out;
}
function drawCards(pool, n, rng) {
  const out = [];
  for (let k = 0; k < n && pool.length; k++) {
    const i = Math.floor(rng() * pool.length);
    out.push(pool[i]); pool.splice(i, 1);
  }
  return out;
}
function pickWeighted(combos, rng) {
  let total = 0;
  for (const c of combos) total += c[2];
  if (total <= 0) return combos[Math.floor(rng() * combos.length)];
  let x = rng() * total;
  for (const c of combos) { x -= c[2]; if (x <= 0) return c; }
  return combos[combos.length - 1];
}
/** 单一组合对范围的摊牌权益（0..1）；未发完的公共牌用蒙特卡洛 runout 采样 */
export function comboEquityVsRange(combo, villainCombos, board, samples, rng) {
  const blocked = new Set([...combo, ...board]);
  const vc = villainCombos.filter(c => !blocked.has(c[0]) && !blocked.has(c[1]));
  if (!vc.length) return 0.5;
  const full = board.length >= 5;
  const hero7 = [...combo, ...board];
  let eq = 0, n = 0;
  if (full) {
    const hs = eval7(hero7);
    for (const v of vc) { const vs = eval7([...v.slice(0, 2), ...board]); eq += hs > vs ? 1 : hs < vs ? 0 : 0.5; n++; }
  } else {
    const need = 5 - board.length;
    for (let s = 0; s < samples; s++) {
      const pool = deckExcluding([...combo, ...board]);
      const run = drawCards(pool, need, rng);
      const v = pickWeighted(vc.filter(c => !run.includes(c[0]) && !run.includes(c[1])), rng);
      if (!v) continue;
      const b7 = [...board, ...run];
      const hs = eval7([...combo, ...b7]), vs = eval7([v[0], v[1], ...b7]);
      eq += hs > vs ? 1 : hs < vs ? 0 : 0.5; n++;
    }
  }
  return n ? eq / n : 0.5;
}
/** 按权益分位把组合分成 n 档（等数量），返回每组合的档位与分位边界 */
export function bucketize(combos, equities, n) {
  const idx = combos.map((_, i) => i).sort((a, b) => equities[a] - equities[b]);
  const bucketOf = new Array(combos.length).fill(0);
  const bounds = [];
  for (let k = 0; k < idx.length; k++) {
    const b = Math.min(n - 1, Math.floor(k * n / idx.length));
    bucketOf[idx[k]] = b;
    if (k > 0 && b > bucketOf[idx[k - 1]]) bounds.push(equities[idx[k]]);
  }
  return { bucketOf, bounds };
}
/** 档位对档位的摊牌权益矩阵 E[bh][bv] */
export function buildEquityMatrix(heroCombos, villainCombos, hb, vb, board, nBuckets, samplesPerPair, rng) {
  const hg = Array.from({ length: nBuckets }, () => []);
  const vg = Array.from({ length: nBuckets }, () => []);
  heroCombos.forEach((c, i) => hg[hb.bucketOf[i]].push(c));
  villainCombos.forEach((c, i) => vg[vb.bucketOf[i]].push(c));
  const E = Array.from({ length: nBuckets }, () => new Float64Array(nBuckets).fill(0.5));
  const need = Math.max(0, 5 - board.length);
  for (let a = 0; a < nBuckets; a++) for (let b = 0; b < nBuckets; b++) {
    if (!hg[a].length || !vg[b].length) continue;
    let eq = 0, n = 0;
    for (let s = 0; s < samplesPerPair; s++) {
      const h = hg[a][Math.floor(rng() * hg[a].length)];
      const v = vg[b][Math.floor(rng() * vg[b].length)];
      if (!h || !v) continue;
      const used = new Set([h[0], h[1], v[0], v[1]]);
      if (used.size < 4) continue;
      let b7 = board;
      if (need) {
        const pool = deckExcluding([...used, ...board]);
        b7 = [...board, ...drawCards(pool, need, rng)];
      }
      const hs = eval7([h[0], h[1], ...b7]), vs = eval7([v[0], v[1], ...b7]);
      eq += hs > vs ? 1 : hs < vs ? 0 : 0.5; n++;
    }
    E[a][b] = n ? eq / n : 0.5;
  }
  return E;
}
