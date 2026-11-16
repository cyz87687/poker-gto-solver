/* solver-core.js —— 翻前近似 / 翻后单挑近似均衡求解器
 * 牌力分档抽象 + 街内有限博弈树 + 反事实遗憾最小化(CFR)
 * 翻前：board=0，用蒙特卡洛补全 5 张公共牌估算起手牌范围权益（不展开翻后博弈树）
 * 剥削模式 = 对手画像 -> 节点锁定(Node Locking) -> 求解 Hero 最优应对
 * 纯逻辑，无 DOM 依赖，可在 Web Worker / Node 中运行。
 */
import {
  matrixToCombos, comboEquityVsRange, bucketize, buildEquityMatrix,
  deckExcluding, mulberry32, hashSeed, cardStr, eval7, applyRangeWidth
} from './cards.js';

export const N_BUCKETS = 10;
export const ARCHETYPE_PARAMS = {
  tag: { width: 0.70, aggression: 0.15, bluff: -0.10, foldToBet: 0.00, foldToRaise: 0.05, raiseThreshold: 0.20 },
  lag: { width: 1.40, aggression: 0.25, bluff: 0.20, foldToBet: -0.15, foldToRaise: -0.10, raiseThreshold: 0.00 },
  tp:  { width: 0.75, aggression: -0.20, bluff: -0.15, foldToBet: 0.25, foldToRaise: 0.30, raiseThreshold: 0.50 },
  lp:  { width: 1.30, aggression: -0.15, bluff: -0.10, foldToBet: 0.05, foldToRaise: 0.15, raiseThreshold: 0.45 },
  cs:  { width: 1.60, aggression: -0.30, bluff: -0.25, foldToBet: -0.30, foldToRaise: -0.25, raiseThreshold: 0.85 }
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const other = p => p === 'hero' ? 'villain' : 'hero';
/** 频率四舍五入后把舍入残差并入最大项，保证合计严格 = 100%（PRD U2 验收） */
function roundedFreqs(arr, digits = 4) {
  const f = Math.pow(10, digits);
  const out = arr.map(x => Math.round(x * f) / f);
  const diff = 1 - out.reduce((a, b) => a + b, 0);
  if (Math.abs(diff) > 1e-9 && out.length) {
    let bi = 0;
    for (let i = 1; i < out.length; i++) if (out[i] > out[bi]) bi = i;
    out[bi] = Math.round((out[bi] + diff) * f) / f;
  }
  return out;
}

function normalize(s) {
  const t = s.reduce((a, b) => a + Math.max(0, b), 0);
  if (t <= 1e-12) return s.map(() => 1 / s.length);
  return s.map(v => Math.max(0, v) / t);
}
function redistribute(s, idx, target) {
  const old = s[idx];
  target = clamp(target, 0, 0.98);
  const restTarget = 1 - target;
  const restOld = Math.max(0, 1 - old);
  const out = s.slice();
  if (restOld <= 1e-9) { out[idx] = target; const each = restTarget / Math.max(1, s.length - 1); for (let i = 0; i < s.length; i++) if (i !== idx) out[i] = each; }
  else { for (let i = 0; i < s.length; i++) if (i !== idx) out[i] = s[i] * restTarget / restOld; out[idx] = target; }
  return out;
}

/* ---------------- 街内博弈树 ---------------- */
function makeRoot(req) {
  return {
    key: '', pot: Math.max(0.1, req.pot), hInv: 0, vInv: Math.max(0, req.facingBet),
    toCall: Math.max(0, req.facingBet), toAct: 'hero', raises: req.facingBet > 0 ? 1 : 0,
    checked: { hero: false, villain: !!req.oppChecked }, afterCheck: false,
    allin: false, terminal: null, stack: Math.max(1, req.stack)
  };
}
function inv(s, p) { return p === 'hero' ? s.hInv : s.vInv; }
function setInv(s, p, v) { if (p === 'hero') s.hInv = v; else s.vInv = v; }
function remFor(s, p) { return Math.max(0, s.stack - inv(s, p)); }

function actionList(s, ctx) {
  const hit = ctx.actsCache && ctx.actsCache.get(s.key);
  if (hit) return hit;
  const finish = out => {
    const seen = new Set();
    const res = out.filter(a => { if (seen.has(a.key)) return false; seen.add(a.key); return true; });
    if (ctx.actsCache) ctx.actsCache.set(s.key, res);
    return res;
  };
  const acts = [];
  const rem = Math.min(remFor(s, 'hero'), remFor(s, 'villain'));
  const A = t => acts.push(t);
  if (s.allin) {
    if (s.toCall > 0) { A({ type: 'FOLD', key: 'F', label: '弃牌' }); A({ type: 'CALL', amount: Math.min(s.toCall, rem), key: 'C', label: '跟注' }); }
    else A({ type: 'CHECK', key: 'X', label: '过牌' });
    return finish(acts);
  }
  if (s.toCall > 0) {
    A({ type: 'FOLD', key: 'F', label: '弃牌' });
    A({ type: 'CALL', amount: Math.min(s.toCall, rem), key: 'C', label: '跟注' });
    const canRaise = s.raises < ctx.maxRaises && !(ctx.checkRaise === false && s.afterCheck);
    if (canRaise && rem > s.toCall + 0.5) {
      const pool = s.pot + s.toCall;
      for (const size of ctx.sizes) {
        const inc = clamp(size * pool, s.toCall, Math.max(s.toCall, rem - s.toCall));
        if (inc > s.toCall + 0.2) acts.push({ type: 'RAISE', amount: Math.round(inc * 10) / 10, size, key: 'R' + size, label: `加注 ${Math.round(size * 100)}% 池` });
      }
      if (rem > s.toCall * 2 && rem <= 3.2 * s.pot) acts.push({ type: 'ALLIN', amount: Math.round((rem - 0) * 10) / 10, key: 'AI', label: '全下' });
    }
  } else {
    A({ type: 'CHECK', key: 'X', label: '过牌' });
    if (s.raises < ctx.maxRaises && rem > 0.6) {
      for (const size of ctx.sizes) {
        const amt = clamp(size * s.pot, 1, rem);
        if (amt >= 0.9) acts.push({ type: 'BET', amount: Math.round(amt * 10) / 10, size, key: 'B' + size, label: `下注 ${Math.round(size * 100)}% 池` });
      }
      if (rem <= 3.2 * s.pot && rem > 1.2) acts.push({ type: 'ALLIN', amount: Math.round(rem * 10) / 10, key: 'AI', label: '全下' });
    }
  }
  // 去重（尺度裁剪后可能生成相同 key）
  return finish(acts);
}
function applyAction(s, a) {
  const n = {
    key: s.key ? s.key + '|' + a.key : a.key, pot: s.pot, hInv: s.hInv, vInv: s.vInv,
    toCall: s.toCall, toAct: s.toAct, raises: s.raises,
    checked: { ...s.checked }, afterCheck: s.afterCheck, allin: s.allin, terminal: null, stack: s.stack
  };
  const p = s.toAct;
  const term = (type, winner) => { n.terminal = { type, winner, pot: n.pot, hInv: n.hInv }; };
  switch (a.type) {
    case 'FOLD': term('fold', other(p)); break;
    case 'CHECK':
      n.checked[p] = true;
      if (n.checked.hero && n.checked.villain) term('showdown', null);
      else { n.toAct = other(p); n.afterCheck = true; }
      break;
    case 'CALL': {
      const amt = Math.max(0, Math.min(a.amount, remFor(s, p)));
      n.pot += amt; setInv(n, p, inv(n, p) + amt); term('showdown', null); break;
    }
    case 'BET': {
      const amt = Math.max(0, Math.min(a.amount, remFor(s, p)));
      n.pot += amt; setInv(n, p, inv(n, p) + amt); n.toCall = amt; n.raises++;
      n.checked = { hero: false, villain: false }; n.afterCheck = false; n.toAct = other(p); break;
    }
    case 'RAISE': {
      const call = Math.min(s.toCall, remFor(s, p));
      const inc = Math.max(0, Math.min(a.amount, remFor(s, p) - call));
      n.pot += call + inc; setInv(n, p, inv(n, p) + call + inc); n.toCall = inc; n.raises++;
      n.checked = { hero: false, villain: false }; n.afterCheck = false; n.toAct = other(p); break;
    }
    case 'ALLIN': {
      const amt = Math.max(0, Math.min(a.amount, remFor(s, p)));
      n.pot += amt; setInv(n, p, inv(n, p) + amt); n.toCall = amt; n.raises++; n.allin = true;
      n.checked = { hero: false, villain: false }; n.toAct = other(p); break;
    }
  }
  return n;
}
function payoff(t, bh, bv, ctx) {
  if (!t) return 0;
  if (t.type === 'showdown') return ctx.E[bh][bv] * t.pot - t.hInv;
  return t.winner === 'hero' ? t.pot - t.hInv : -t.hInv;
}

function makeCtx(req, iterations) {
  const sizes = (req.sizes || [0.33, 0.67, 1]).slice(0, 4).map(Number).filter(v => v > 0 && v <= 3);
  return {
    sizes: sizes.length ? sizes : [0.5, 1],
    checkRaise: req.allowCheckRaise !== false,
    maxRaises: req.preset === 'precise' ? 3 : 2,
    iterations, NB: N_BUCKETS, E: null, nodes: new Map(), actsCache: new Map(),
    archetype: req.archetype || 'tag', intensity: clamp(Number(req.intensity) || 1, 0.5, 1.5),
    locked: false, baseNodes: null, cancelled: false
  };
}
function getNode(ctx, key, n) {
  let node = ctx.nodes.get(key);
  if (!node) {
    node = { n, reg: { hero: [], villain: [] }, sum: { hero: [], villain: [] } };
    for (const p of ['hero', 'villain']) for (let b = 0; b < ctx.NB; b++) {
      node.reg[p].push(new Float64Array(n)); node.sum[p].push(new Float64Array(n));
    }
    ctx.nodes.set(key, node);
  }
  return node;
}
function regretMatch(reg, n) {
  const pos = new Float64Array(n); let t = 0;
  for (let a = 0; a < n; a++) { pos[a] = Math.max(0, reg[a]); t += pos[a]; }
  if (t <= 1e-12) return new Float64Array(n).fill(1 / n);
  for (let a = 0; a < n; a++) pos[a] /= t;
  return pos;
}
function avgStrat(node, p, bucket, n) {
  if (!node) return new Float64Array(n).fill(1 / n);
  const s = node.sum[p][bucket];
  return normalize(Array.from(s));
}
function lockedStrategy(ctx, state, bucket, acts) {
  const n = acts.length;
  const base = ctx.baseNodes ? avgStrat(ctx.baseNodes.get(state.key), 'villain', bucket, n) : new Float64Array(n).fill(1 / n);
  let s = Array.from(base);
  const A = ARCHETYPE_PARAMS[ctx.archetype] || ARCHETYPE_PARAMS.tag;
  const k = ctx.intensity;
  const facing = state.toCall > 0;
  if (facing) {
    const fi = acts.findIndex(a => a.type === 'FOLD');
    if (fi >= 0) {
      const shift = (state.raises > 1 ? A.foldToRaise : A.foldToBet) * k;
      s = redistribute(s, fi, s[fi] + shift);
    }
    const ri = acts.findIndex(a => a.type === 'RAISE' || a.type === 'ALLIN');
    if (ri >= 0 && bucket < ctx.NB * 0.5) {
      s[ri] *= (1 - Math.min(0.9, A.raiseThreshold * k));
      s = normalize(s);
    }
  } else {
    const betIdx = [];
    acts.forEach((a, i) => { if (a.type === 'BET' || a.type === 'ALLIN') betIdx.push(i); });
    if (betIdx.length) {
      const m = betIdx.reduce((acc, i) => acc + s[i], 0);
      const shift = (A.aggression + (bucket < 4 ? A.bluff : 0)) * k;
      const nm = clamp(m + shift, 0, 0.97);
      if (m > 1e-9) betIdx.forEach(i => { s[i] *= nm / m; });
      else betIdx.forEach(i => { s[i] = nm / betIdx.length; });
      const ci = acts.findIndex(a => a.type === 'CHECK');
      if (ci >= 0) s[ci] = Math.max(0, 1 - nm);
      s = normalize(s);
    }
  }
  return normalize(s);
}

function cfr(state, bh, bv, reachH, reachV, pD, ctx) {
  if (state.terminal) return payoff(state.terminal, bh, bv, ctx);
  const acts = actionList(state, ctx);
  if (!acts.length) return payoff({ type: 'showdown', pot: state.pot, hInv: state.hInv, winner: null }, bh, bv, ctx);
  const n = acts.length, player = state.toAct, bucket = player === 'hero' ? bh : bv;
  const node = getNode(ctx, state.key, n);
  const strat = (player === 'villain' && ctx.locked)
    ? lockedStrategy(ctx, state, bucket, acts)
    : regretMatch(node.reg[player][bucket], n);
  const utils = new Float64Array(n);
  for (let a = 0; a < n; a++) {
    const child = applyAction(state, acts[a]);
    const rH = reachH * (player === 'hero' ? strat[a] : 1);
    const rV = reachV * (player === 'villain' ? strat[a] : 1);
    utils[a] = cfr(child, bh, bv, rH, rV, pD, ctx);
  }
  let u = 0;
  for (let a = 0; a < n; a++) u += strat[a] * utils[a];
  const cf = pD * (player === 'hero' ? reachV : reachH);
  if (player === 'hero' || !ctx.locked) {
    const reg = node.reg[player][bucket];
    const sign = player === 'hero' ? 1 : -1; // Hero 最大化 EV，Villain 最小化 Hero EV
    for (let a = 0; a < n; a++) reg[a] += sign * cf * (utils[a] - u);
  }
  const own = pD * (player === 'hero' ? reachH : reachV);
  const sums = node.sum[player][bucket];
  for (let a = 0; a < n; a++) sums[a] += own * strat[a];
  return u;
}

function evaluate(state, bh, bv, pD, ctx, opts) {
  if (state.terminal) return payoff(state.terminal, bh, bv, ctx);
  const acts = actionList(state, ctx);
  if (!acts.length) return payoff({ type: 'showdown', pot: state.pot, hInv: state.hInv, winner: null }, bh, bv, ctx);
  const n = acts.length, player = state.toAct, bucket = player === 'hero' ? bh : bv;
  let strat;
  if (state.key === '' && opts.rootIdx != null) {
    strat = new Float64Array(n); strat[Math.min(opts.rootIdx, n - 1)] = 1;
  } else {
    const provider = player === 'hero' ? opts.heroStrat : opts.villainStrat;
    strat = provider ? provider(state, bucket, acts, ctx) : avgStrat(ctx.nodes.get(state.key), player, bucket, n);
  }
  let v = 0;
  for (let a = 0; a < n; a++) v += strat[a] * evaluate(applyAction(state, acts[a]), bh, bv, pD, ctx, { heroStrat: opts.heroStrat, villainStrat: opts.villainStrat });
  return v;
}
/** 最优应对（BR）：策略只能依赖自身牌力档，不得偷看对手档位。
 * 返回按「对手档位」索引的收益向量；在 BR 玩家节点先对对手档位取期望再选动作。 */
function bestResponseVector(state, ownBucket, pOpp, ctx, brPlayer, oppProvider, isHeroBR) {
  const term = t => pOpp.map((_, ob) => payoff(t, isHeroBR ? ownBucket : ob, isHeroBR ? ob : ownBucket, ctx));
  if (state.terminal) return term(state.terminal);
  const acts = actionList(state, ctx);
  if (!acts.length) return term({ type: 'showdown', pot: state.pot, hInv: state.hInv, winner: null });
  const n = acts.length;
  const vecs = acts.map(a => bestResponseVector(applyAction(state, a), ownBucket, pOpp, ctx, brPlayer, oppProvider, isHeroBR));
  const score = vec => vec.reduce((acc, x, i) => acc + pOpp[i] * x, 0);
  if (state.toAct === brPlayer) {
    const scores = vecs.map(score);
    let bi = 0;
    for (let a = 1; a < n; a++) if (isHeroBR ? scores[a] > scores[bi] : scores[a] < scores[bi]) bi = a;
    return vecs[bi];
  }
  const out = new Array(pOpp.length).fill(0);
  for (let ob = 0; ob < pOpp.length; ob++) {
    const strat = oppProvider(state, ob, acts, ctx);
    for (let a = 0; a < n; a++) out[ob] += strat[a] * vecs[a][ob];
  }
  return out;
}
function brRootChoice(root, bh, ctx, oppProvider) {
  const acts = actionList(root, ctx), pOpp = Array.from(ctx.pV);
  const vecs = acts.map(a => bestResponseVector(applyAction(root, a), bh, pOpp, ctx, 'hero', oppProvider, true));
  const scores = vecs.map(v => v.reduce((acc, x, i) => acc + pOpp[i] * x, 0));
  let bi = 0;
  for (let a = 1; a < acts.length; a++) if (scores[a] > scores[bi]) bi = a;
  return bi;
}
function heroBRValue(root, ctx, oppProvider) {
  const pOpp = Array.from(ctx.pV);
  let total = 0;
  for (let bh = 0; bh < ctx.NB; bh++) {
    if (ctx.pH[bh] <= 0) continue;
    const vec = bestResponseVector(root, bh, pOpp, ctx, 'hero', oppProvider, true);
    total += ctx.pH[bh] * vec.reduce((acc, x, i) => acc + pOpp[i] * x, 0);
  }
  return total;
}
function villainBRValue(root, ctx, oppProvider) {
  const pOpp = Array.from(ctx.pH);
  let total = 0;
  for (let bv = 0; bv < ctx.NB; bv++) {
    if (ctx.pV[bv] <= 0) continue;
    const vec = bestResponseVector(root, bv, pOpp, ctx, 'villain', oppProvider, false);
    total += ctx.pV[bv] * vec.reduce((acc, x, i) => acc + pOpp[i] * x, 0);
  }
  return total;
}

function countTree(ctx, root) {
  let count = 0; const queue = [root]; const seen = new Set();
  while (queue.length) {
    const s = queue.pop();
    if (s.terminal || seen.has(s.key)) continue;
    seen.add(s.key); count++;
    if (count > 900) return count;
    for (const a of actionList(s, ctx)) queue.push(applyAction(s, a));
  }
  return count;
}
function dealLoop(ctx, root, fn) {
  let total = 0, weight = 0;
  const { pH, pV } = ctx;
  for (let bh = 0; bh < ctx.NB; bh++) for (let bv = 0; bv < ctx.NB; bv++) {
    const pD = pH[bh] * pV[bv];
    if (pD <= 0) continue;
    total += pD * fn(bh, bv, pD); weight += pD;
  }
  return weight > 0 ? total / weight : 0;
}
/* 迭代口径（V1.8）：1 次迭代 = 1 次 CFR 遍历（遍历 1 组 Hero/Villain 牌力档组合），
 * 与 PioSolver 等商业解算器的 iteration 口径一致。界面显示的次数 = 实际执行的遍历次数。 */
export const SOLVE_ITER = { fast: 100000, precise: 500000 };
function runCFR(ctx, root, onProgress, label) {
  const { pH, pV } = ctx;
  const pairs = [];
  for (let bh = 0; bh < ctx.NB; bh++) for (let bv = 0; bv < ctx.NB; bv++) {
    const pD = pH[bh] * pV[bv];
    if (pD > 0) pairs.push([bh, bv, pD]);
  }
  if (!pairs.length) return 0;
  const iters = Math.max(1, Math.floor(ctx.iterations) || 0);
  const step = Math.max(10, Math.floor(iters / 120));
  for (let it = 0; it < iters; it++) {
    if (ctx.cancelled) throw new Error('CANCELLED');
    const pr = pairs[it % pairs.length]; // 轮转覆盖全部牌力档组合，等价于按序全量扫描
    cfr(root, pr[0], pr[1], 1, 1, pr[2], ctx);
    if (onProgress && (it % step === 0 || it === iters - 1)) onProgress((it + 1) / iters, label);
  }
  return iters; // 实际执行的迭代次数（用于界面统计，保证显示与执行一致）
}
function heatFor(ctx, root, heroCombos, hb, villainCombos, vb, who) {
  const heat = Array.from({ length: 13 }, () => new Array(13).fill(0));
  const cnt = Array.from({ length: 13 }, () => new Array(13).fill(0));
  const isHero = who === 'hero';
  const combos = isHero ? heroCombos : villainCombos;
  const buckets = isHero ? hb : vb;
  const actsAtRoot = actionList(root, ctx);
  const stateForStrat = (() => {
    for (const a of actsAtRoot) {
      const child = applyAction(root, a);
      if (!child.terminal && child.toAct === (isHero ? 'hero' : 'villain')) return child;
    }
    return root;
  })();
  const acts = actionList(stateForStrat, ctx);
  const node = ctx.nodes.get(stateForStrat.key);
  combos.forEach((c, i) => {
    const [ci, cj] = comboClassIndices(c[0], c[1]);
    const b = buckets.bucketOf[i];
    const s = avgStrat(node, isHero ? 'hero' : 'villain', b, acts.length);
    let score = 0;
    acts.forEach((a, k) => {
      if (a.type === 'BET' || a.type === 'RAISE' || a.type === 'ALLIN') score += s[k];
    });
    if (!isHero && acts.some(a => a.type === 'FOLD')) {
      const fi = acts.findIndex(a => a.type === 'FOLD');
      score = 1 - s[fi];
    }
    heat[ci][cj] += score; cnt[ci][cj]++;
  });
  for (let i = 0; i < 13; i++) for (let j = 0; j < 13; j++) if (cnt[i][j]) heat[i][j] /= cnt[i][j];
  return heat;
}
function comboClassIndices(c1, c2) {
  const a = c1 % 13, b = c2 % 13, suited = ((c1 / 13) | 0) === ((c2 / 13) | 0);
  const hi = Math.max(a, b), lo = Math.min(a, b);
  if (hi === lo) return [hi, lo];
  return suited ? [hi, lo] : [lo, hi];
}

/** 主入口：求解一个决策点 */
export function solveCore(req, onProgress = () => {}) {
  const t0 = Date.now();
  const board = (req.board || []).slice(0, 5);
  if (board.length === 1 || board.length === 2) throw new Error('公共牌需为 0 张（翻前）或 3–5 张（翻后）；当前 1–2 张无法求解');
  const phase = board.length === 0 ? 'preflop' : 'postflop';
  if ((req.sizes || []).length > 4) throw new Error('每街下注尺度最多 4 个，请压缩尺度集合');
  // 正式求解（未显式指定迭代数）按档位默认，且至少 10,000 次；显式 iterations 仅供预览/测试
  const iterations = Math.max(1, Math.floor(req.iterations) || (req.preset === 'precise' ? SOLVE_ITER.precise : SOLVE_ITER.fast));
  const ctx = makeCtx(req, iterations);
  const root = makeRoot(req);
  const treeSize = countTree(ctx, root);
  if (treeSize > 600) throw new Error('分支过大：请压缩下注尺度集合或收窄对手范围后重试');

  const seed = hashSeed(JSON.stringify([board, req.heroRange, req.villainRange, req.pot, req.stack, req.sizes, req.mode, req.archetype, req.intensity]));
  const rng = mulberry32(seed);
  onProgress(0.03, '展开范围与计算摊牌权益');
  const used = [...board, ...(req.heroCards || []), ...(req.villainCards || []), ...(req.deadCards || [])];
  let heroRange = req.heroRange, villainRange = req.villainRange;
  if (req.mode === 'exploit') {
    const A = ARCHETYPE_PARAMS[req.archetype] || ARCHETYPE_PARAMS.tag;
    villainRange = applyRangeWidth(villainRange, A.width, ctx.intensity);
  }
  const heroCombos = matrixToCombos(heroRange, used, 0.02, 380);
  const villainCombos = matrixToCombos(villainRange, used, 0.02, 380);
  if (!heroCombos.length || !villainCombos.length) throw new Error('范围为空：与手牌/公共牌/死牌冲突后无可用组合，请放宽范围');

  const samples = board.length >= 5 ? 0 : board.length === 0 ? 96 : 84;
  const heroEq = heroCombos.map(c => comboEquityVsRange([c[0], c[1]], villainCombos, board, samples, rng));
  const villainEq = villainCombos.map(c => comboEquityVsRange([c[0], c[1]], heroCombos, board, samples, rng));
  const hb = bucketize(heroCombos, heroEq, N_BUCKETS);
  const vb = bucketize(villainCombos, villainEq, N_BUCKETS);
  ctx.E = buildEquityMatrix(heroCombos, villainCombos, hb, vb, board, N_BUCKETS, board.length === 0 ? 28 : 20, rng);
  const pH = new Float64Array(N_BUCKETS), pV = new Float64Array(N_BUCKETS);
  heroCombos.forEach((_, i) => { pH[hb.bucketOf[i]] += 1; });
  villainCombos.forEach((_, i) => { pV[vb.bucketOf[i]] += 1; });
  for (let b = 0; b < N_BUCKETS; b++) { pH[b] /= heroCombos.length; pV[b] /= villainCombos.length; }
  ctx.pH = pH; ctx.pV = pV;

  onProgress(0.18, '求解均衡策略');
  const itersRun = runCFR(ctx, root, (p) => onProgress(0.18 + p * 0.62, '求解均衡策略'), 'gto');

  const rootActs = actionList(root, ctx);
  const avgHero = (state, bucket, acts, c) => avgStrat(c.nodes.get(state.key), 'hero', bucket, acts.length);
  const avgVillain = (state, bucket, acts, c) => avgStrat(c.nodes.get(state.key), 'villain', bucket, acts.length);
  const eqEV = dealLoop(ctx, root, (bh, bv, pD) => evaluate(root, bh, bv, pD, ctx, { heroStrat: avgHero, villainStrat: avgVillain }));
  const brHero = heroBRValue(root, ctx, avgVillain);
  const brVillain = villainBRValue(root, ctx, avgHero);
  const gainH = Math.max(0, brHero - eqEV), gainV = Math.max(0, eqEV - brVillain);
  const exploitabilityMbb = Math.max(0, Math.round((gainH + gainV) * 1000 * 10) / 10);

  const rootNode = ctx.nodes.get('');
  const gtoFreq = new Array(rootActs.length).fill(0);
  for (let b = 0; b < N_BUCKETS; b++) {
    const s = avgStrat(rootNode, 'hero', b, rootActs.length);
    for (let a = 0; a < rootActs.length; a++) gtoFreq[a] += pH[b] * s[a];
  }
  const gtoFreqRounded = roundedFreqs(gtoFreq);
  const gtoEV = rootActs.map((_, idx) => dealLoop(ctx, root, (bh, bv, pD) => evaluate(root, bh, bv, pD, ctx, { rootIdx: idx, heroStrat: avgHero, villainStrat: avgVillain })));
  const bestEV = Math.max(...gtoEV);
  const userIdx = matchUserAction(rootActs, req.userAction);
  const evLossBB = userIdx >= 0 ? Math.max(0, Math.round((bestEV - gtoEV[userIdx]) * 100) / 100) : null;

  const base = {
    mode: 'gto', archetype: null, phase, boardCount: board.length,
    decisionNode: req.decisionNode || (phase === 'preflop' ? 'PREFLOP|HERO' : 'FLOP|HERO'),
    pot: Math.round(req.pot * 10) / 10, stacks: Math.round(req.stack * 10) / 10,
    actions: rootActs.map((a, i) => ({ type: a.type, sizeBB: a.amount != null ? a.amount : null, label: a.label, freq: gtoFreqRounded[i], ev: Math.round(gtoEV[i] * 100) / 100 })),
    userAction: req.userAction || null, evLossBB,
    exploitGainBB: null, exploitabilityMbb, iterations: itersRun, iterationsExploit: null, treeSize,
    durationMs: Date.now() - t0,
    convergenceNote: phase === 'preflop'
      ? '翻前近似：起手牌范围对抗权益分档（蒙特卡洛补全 5 张公共牌）+ 街内 CFR；未展开翻后博弈树，不等同商业 Solver 的翻前解，仅供范围对抗参考。迭代口径：1 次迭代 = 1 次 CFR 遍历，统计次数 = 实际执行次数'
      : '近似均衡：10 档牌力抽象 + 街内有限博弈树 + CFR 线性平均；可剥削度按牌力分档先验下的最优应对增益估计，非 PioSolver 级精度。迭代口径：1 次迭代 = 1 次 CFR 遍历，统计次数 = 实际执行次数',
    ranges: { hero: req.heroRange, villain: villainRange, heroCombos: heroCombos.length, villainCombos: villainCombos.length },
    heatmap: {
      hero: heatFor(ctx, root, heroCombos, hb, villainCombos, vb, 'hero'),
      villain: heatFor(ctx, root, heroCombos, hb, villainCombos, vb, 'villain')
    },
    focus: focusStrategy(req, rootNode, rootActs, heroCombos, hb, heroEq, pH),
    eqEV: Math.round(eqEV * 100) / 100,
    convergence: {
      equilibriumEV: Math.round(eqEV * 100) / 100,
      heroBestResponseEV: Math.round(brHero * 100) / 100,
      villainBestResponseEV: Math.round(brVillain * 100) / 100,
      gapBB: Math.round((brHero - brVillain) * 100) / 100
    }
  };

  if (req.mode !== 'exploit') return base;

  onProgress(0.83, '节点锁定并求解剥削路线');
  const lockedProvider = (state, bucket, acts, c) => lockedStrategy({ ...ctx, baseNodes: ctx.nodes, locked: true }, state, bucket, acts);
  const exp = makeCtx(req, Math.max(8000, Math.round(itersRun * 0.6)));
  exp.E = ctx.E; exp.pH = pH; exp.pV = pV; exp.locked = true; exp.baseNodes = ctx.nodes;
  const expRoot = makeRoot(req);
  const expItersRun = runCFR(exp, expRoot, (p) => onProgress(0.83 + p * 0.15, '节点锁定并求解剥削路线'), 'exploit');

  const expHeroStrat = (state, bucket, acts) => avgStrat(exp.nodes.get(state.key), 'hero', bucket, acts.length);
  const gtoVsLocked = dealLoop(ctx, root, (bh, bv, pD) => evaluate(root, bh, bv, pD, ctx, { heroStrat: avgHero, villainStrat: lockedProvider }));
  const expVsLocked = dealLoop(ctx, root, (bh, bv, pD) => evaluate(root, bh, bv, pD, exp, { heroStrat: expHeroStrat, villainStrat: lockedProvider }));
  const exploitGainBB = Math.round(Math.max(0, expVsLocked - gtoVsLocked) * 100) / 100;

  const expRootNode = exp.nodes.get('');
  const brChoice = new Array(rootActs.length).fill(0);
  for (let b = 0; b < N_BUCKETS; b++) {
    const s = avgStrat(expRootNode, 'hero', b, rootActs.length);
    for (let a = 0; a < rootActs.length; a++) brChoice[a] += pH[b] * s[a];
  }
  const expEV = rootActs.map((a, idx) => Math.round(dealLoop(ctx, root, (bh, bv, pD) =>
    evaluate(root, bh, bv, pD, exp, { rootIdx: idx, heroStrat: expHeroStrat, villainStrat: lockedProvider })) * 100) / 100);
  const expFreqRounded = roundedFreqs(brChoice);
  const expBest = Math.max(...expEV);
  const expUserLoss = userIdx >= 0 ? Math.max(0, Math.round((expBest - expEV[userIdx]) * 100) / 100) : null;

  return {
    ...base, mode: 'exploit', archetype: req.archetype, intensity: ctx.intensity,
    exploitGainBB, archetypeLabel: (req.archetype || '').toUpperCase(),
    iterationsExploit: expItersRun,
    actions: rootActs.map((a, i) => ({ type: a.type, sizeBB: a.amount != null ? a.amount : null, label: a.label, freq: expFreqRounded[i], ev: expEV[i] })),
    evLossBB: expUserLoss,
    gtoActions: base.actions,
    gtoEvLossBB: base.evLossBB,
    exploitabilityMbb: null,
    lockedInfo: { params: ARCHETYPE_PARAMS[req.archetype] || ARCHETYPE_PARAMS.tag, widthApplied: true },
    durationMs: Date.now() - t0
  };
}
function matchUserAction(acts, user) {
  if (!user) return -1;
  const t = String(user.type || '').toUpperCase();
  let idx = acts.findIndex(a => a.type === t);
  if (idx < 0 && (t === 'RAISE_TO' || t === '3BET' || t === '4BET')) idx = acts.findIndex(a => a.type === 'RAISE' || a.type === 'ALLIN');
  if (idx < 0 && t === 'BET') idx = acts.findIndex(a => a.type === 'ALLIN');
  if (user.amountBB != null && idx >= 0) {
    let best = idx, d = Infinity;
    acts.forEach((a, i) => { if (a.type !== acts[idx].type) return; const dd = Math.abs((a.amount || 0) - user.amountBB); if (dd < d) { d = dd; best = i; } });
    idx = best;
  }
  return idx;
}
function focusStrategy(req, rootNode, acts, combos, hb, eq, pH) {
  const hc = req.heroCards || [];
  if (hc.length !== 2) return null;
  const target = combos.findIndex(c => c[0] === hc[0] && c[1] === hc[1]);
  let b;
  if (target >= 0) b = hb.bucketOf[target];
  else {
    const avg = eq.reduce((a, x) => a + x, 0) / Math.max(1, eq.length);
    b = clamp(Math.floor(avg * N_BUCKETS), 0, N_BUCKETS - 1);
  }
  const s = avgStrat(rootNode, 'hero', b, acts.length);
  const sr = roundedFreqs(Array.from(s));
  return { cards: hc.map(cardStr), bucket: b, equityVsVillainRange: Math.round((eq[target >= 0 ? target : 0] || 0.5) * 1000) / 1000, strategy: acts.map((a, i) => ({ type: a.type, label: a.label, freq: sr[i] })) };
}

/** 路线预览：在采样 runout 后的下一条街重新快解 */
export function previewCore(req, chosenActionLabel, onProgress = () => {}) {
  const board = (req.board || []).slice(0, 5);
  if (board.length >= 5) return { available: false, reason: '已是河牌，无后续街可预览' };
  const pool = deckExcluding([...board, ...(req.heroCards || []), ...(req.villainCards || [])]);
  if (!pool.length) return { available: false, reason: '无可用的后续公共牌' };
  const rng = mulberry32(hashSeed('preview|' + JSON.stringify(board) + chosenActionLabel));
  // 翻前一次补齐 3 张翻牌；翻后每次补 1 张
  const need = board.length === 0 ? 3 : 1;
  const bag = pool.slice(), drawn = [];
  for (let k = 0; k < need && bag.length; k++) drawn.push(bag.splice(Math.floor(rng() * bag.length), 1)[0]);
  if (drawn.length < need) return { available: false, reason: '无可用的后续公共牌' };
  const newBoard = [...board, ...drawn];
  const extra = (req.sizes || [0.5])[0] * Math.max(1, req.pot) * 2;
  const sub = solveCore({
    ...req, board: newBoard, pot: Math.max(1, req.pot + extra),
    stack: Math.max(1, req.stack - extra / 2), facingBet: 0, oppChecked: true,
    iterations: 30000, preset: 'fast', mode: 'gto', userAction: null,
    decisionNode: (newBoard.length === 3 ? 'FLOP' : newBoard.length === 4 ? 'TURN' : 'RIVER') + '|HERO'
  }, onProgress);
  return {
    available: true, street: newBoard.length === 3 ? 'FLOP' : newBoard.length === 4 ? 'TURN' : 'RIVER',
    newCard: drawn.map(cardStr).join(' '), board: newBoard.map(cardStr),
    actions: sub.actions, exploitabilityMbb: sub.exploitabilityMbb, iterations: sub.iterations
  };
}
