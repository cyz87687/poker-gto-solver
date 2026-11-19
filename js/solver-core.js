/* solver-core.js —— 翻前近似 / 翻后单挑近似均衡求解器
 * 牌力分档抽象 + 街内有限博弈树 + 反事实遗憾最小化(CFR)
 * 翻前：board=0，用蒙特卡洛补全 5 张公共牌估算起手牌范围权益（不展开翻后博弈树）
 * 剥削模式 = 对手画像 -> 节点锁定(Node Locking) -> 求解 Hero 最优应对
 * 纯逻辑，无 DOM 依赖，可在 Web Worker / Node 中运行。
 */
import {
  matrixToCombos, comboEquityVsRange, bucketize, buildEquityMatrix,
  deckExcluding, mulberry32, hashSeed, cardStr, eval7, classLabel
} from './cards.js?v=1.20.0';
import { applyArchetypeToRange } from './range-by-action.js?v=1.20.0';
import {
  ARCHETYPE_PARAMS, rangeConditionParams, foldToRaiseByStreet, streetAdjustedRangeCondition
} from './archetypes.js?v=1.20.0';

export const N_BUCKETS = 10;
/* V1.15：画像参数集中到 archetypes.js，solver-core 与范围派生层共用同一份口径 */
export { ARCHETYPE_PARAMS };
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
  const stack = Math.max(0, req.stack);
  // 面对下注钳制到有效后手以内（对手下注多于短码后手时等价于短码全下），杜绝「跟注 0 BB」退化
  const facing = Math.min(Math.max(0, req.facingBet), stack);
  return {
    key: '', pot: Math.max(0.1, req.pot), hInv: 0, vInv: facing,
    toCall: facing, toAct: 'hero', raises: facing > 0 ? 1 : 0,
    checked: { hero: false, villain: !!req.oppChecked }, afterCheck: false,
    allin: false, terminal: null, stack: Math.max(1, stack)
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
  // 跟注额按「行动者自己的剩余后手」封顶：对手全下 / 下注超过短码后手时，跟注=自己的全部后手，而不是 0
  const actorRem = remFor(s, s.toAct);
  const toCallEff = Math.min(s.toCall, actorRem);
  const callLabel = amt => {
    const a = (Math.round(amt * 10) / 10).toFixed(1);
    const isAllin = actorRem > 1e-6 && amt >= actorRem - 1e-6;
    return `跟注 ${a} BB${isAllin ? '（全下）' : ''}`;
  };
  const A = t => acts.push(t);
  if (s.allin) {
    if (toCallEff > 1e-6) {
      A({ type: 'FOLD', key: 'F', label: '弃牌' });
      A({ type: 'CALL', amount: toCallEff, key: 'C', label: callLabel(toCallEff) });
    }
    else A({ type: 'CHECK', key: 'X', label: '过牌' });
    return finish(acts);
  }
  if (toCallEff > 1e-6) {
    A({ type: 'FOLD', key: 'F', label: '弃牌' });
    A({ type: 'CALL', amount: toCallEff, key: 'C', label: callLabel(toCallEff) });
    const canRaise = s.raises < ctx.maxRaises && !(ctx.checkRaise === false && s.afterCheck);
    // V1.20：区分「行动者自己的后手」与「有效后手」（双方还能 contested 的筹码）。
    // 面对的下注可能大于对手剩余（对手已近全下），此时常规加注在筹码上放不下，
    // 但「全下」仍然是物理可行的唯一加注形态——必须进动作集，
    // 否则坚果（例如 A-K-T 河牌的 QJ 顺子）连加注都没有，模型结构性失真。
    const actorRemNow = remFor(s, s.toAct);
    const oppRem = remFor(s, other(s.toAct));
    const remEff = Math.min(actorRemNow, oppRem);
    if (canRaise) {
      const pool = s.pot + s.toCall;
      const actorInv = inv(s, s.toAct);
      let ladder = false;
      for (const size of ctx.sizes) {
        const inc = clamp(size * pool, s.toCall, Math.max(s.toCall, remEff - s.toCall));
        if (inc > s.toCall + 0.2) {
          // 展示口径：加注至 = 行动者本街总投入（已投入 + 跟注 + 加注增量），直接给具体 BB 数
          const incR = Math.round(inc * 10) / 10;
          const raiseTo = Math.round((actorInv + s.toCall + incR) * 10) / 10;
          acts.push({ type: 'RAISE', amount: incR, raiseTo, size, key: 'R' + size, label: `加注至 ${raiseTo.toFixed(1)} BB` });
          ladder = true;
        }
      }
      // 全下（shove）：对手还需再跟的筹码 = min(自己剩余 − 跟注额, 对手剩余)
      const shoveExtra = Math.min(actorRemNow - s.toCall, oppRem);
      // 深码超底池全下不进均衡动作集：近似模型会系统性高估其 EV（深码 5bet 弱牌被判 100% 全下）
      const notOverPot = remEff <= 1.5 * s.pot;
      // 常规加注存在时，仍要求有效后手大于两倍下注（保留 V1.13 口径）；
      // 常规加注放不下时（ladder=false），全下是唯一可行形态，放宽该门槛。
      const deepOk = !ladder || remEff > s.toCall * 2;
      if (shoveExtra > 0.5 && notOverPot && deepOk) {
        const total = Math.round((s.toCall + shoveExtra) * 10) / 10;
        acts.push({ type: 'ALLIN', amount: Math.round(shoveExtra * 10) / 10, raiseTo: total, key: 'AI', label: `全下 ${total.toFixed(1)} BB` });
      }
    }
  } else {
    A({ type: 'CHECK', key: 'X', label: '过牌' });
    if (s.raises < ctx.maxRaises && rem > 0.6) {
      for (const size of ctx.sizes) {
        const amt = clamp(size * s.pot, 1, rem);
        if (amt >= 0.9) {
          const amtR = Math.round(amt * 10) / 10;
          acts.push({ type: 'BET', amount: amtR, size, key: 'B' + size, label: `下注 ${amtR.toFixed(1)} BB` });
        }
      }
      if (rem <= 1.5 * s.pot && rem > 1.2) {
        const aiAmt = Math.round(rem * 10) / 10;
        acts.push({ type: 'ALLIN', amount: aiAmt, key: 'AI', label: `全下 ${aiAmt.toFixed(1)} BB` });
      }
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
  // V1.16：摊牌终局记录 caller，用于范围条件化收益
  //   caller==='hero'   → Hero call 对手下注 → 对手范围是「下注范围」(含诈唬) → E_call
  //   caller==='villain'→ 对手 call Hero 加注 → 对手范围是「跟注范围」(纯价值) → E_raise
  //   无 caller(双CHECK) → 完整范围 → E
  const term = (type, winner, caller) => { n.terminal = { type, winner, pot: n.pot, hInv: n.hInv, caller }; };
  switch (a.type) {
    case 'FOLD': term('fold', other(p)); break;
    case 'CHECK':
      n.checked[p] = true;
      if (n.checked.hero && n.checked.villain) term('showdown', null);
      else { n.toAct = other(p); n.afterCheck = true; }
      break;
    case 'CALL': {
      const amt = Math.max(0, Math.min(a.amount, remFor(s, p)));
      n.pot += amt; setInv(n, p, inv(n, p) + amt); term('showdown', null, p); break;
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
      // V1.20：面对下注时的全下先补齐跟注额、再投入剩余筹码。
      // 旧实现只投入增量、漏算跟注段 → 底池少算，且对手被要求跟一个错误的额度（把跟注额当增量）。
      // a.amount 统一为「跟注额之外的增量」；无人下注时 toCall=0，增量=总投入，语义不变。
      const call = Math.min(s.toCall, remFor(s, p));
      const inc = Math.max(0, Math.min(a.amount, remFor(s, p) - call));
      n.pot += call + inc; setInv(n, p, inv(n, p) + call + inc); n.toCall = inc; n.raises++; n.allin = true;
      n.checked = { hero: false, villain: false }; n.toAct = other(p); break;
    }
  }
  return n;
}
function payoff(t, bh, bv, ctx) {
  if (!t) return 0;
  if (t.type === 'showdown') {
    // V1.16 范围条件化：摊牌收益按「谁 call 到摊牌」选权益矩阵。
    // Hero call 对手下注 → 对手下注范围含诈唬弱牌 → E_call（诈唬捕捉价值）。
    // 对手 call Hero 加注 → 对手跟注范围只剩价值牌 → E_raise（权益骤降，造池不再必杀）。
    let E = ctx.E;
    if (t.caller === 'hero' && ctx.E_call) E = ctx.E_call;
    else if (t.caller === 'villain' && ctx.E_raise) E = ctx.E_raise;
    // 隐含赔率：仅 Hero call 路径计入「后续街击中提升牌」的期望收益；河牌为 0。
    const implied = (t.caller === 'hero' && ctx.implied) ? (ctx.implied[bh] || 0) : 0;
    return E[bh][bv] * t.pot - t.hInv + implied;
  }
  return t.winner === 'hero' ? t.pot - t.hInv : -t.hInv;
}

function makeCtx(req, iterations) {
  const sizes = (req.sizes || [0.33, 0.67, 1]).slice(0, 4).map(Number).filter(v => v > 0 && v <= 3);
  return {
    sizes: sizes.length ? sizes : [0.5, 1],
    checkRaise: req.allowCheckRaise !== false,
    maxRaises: req.preset === 'precise' ? 3 : 2,
    iterations, NB: N_BUCKETS, E: null, E_call: null, E_raise: null, implied: null,
    nodes: new Map(), actsCache: new Map(),
    archetype: req.archetype || 'tag', intensity: clamp(Number(req.intensity) || 1, 0.5, 1.5),
    boardLen: (req.board || []).length, // V1.17：翻前/翻后按街选弃牌率
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
      // V1.17 解耦：翻前面对再加注用 foldToRaise（TAG 高弃/LAG 低弃）；
      // 翻后用 postflopFoldToRaise（TAG 主动开枪=强范围→少弃，LAG cbet 空气多→多弃）。
      // 面对首次下注（非再加注）仍用 foldToBet，保持既有翻后下注响应口径。
      const isPostflop = ctx.boardLen > 0;
      const shift = isPostflop && state.raises > 1
        ? foldToRaiseByStreet(ctx.archetype, true, k)
        : (state.raises > 1 ? A.foldToRaise : A.foldToBet) * k;
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
/* 停止指标（V1.14）：以可剥削度 exploitability / NashConv（mbb/hand）为准，迭代次数只是预算上限与辅助信息。
 * 口径参考 CFR+/MCCFR 与 PioSolver / GTOWizard：教学 <50 mbb；日常可靠 <1 mbb；精细大树 <0.5 mbb。
 * 本实现是 10 档牌力抽象的近似模型，存在抽象下限（实测约 7 mbb），达不到目标时如实提示，不伪造达标。 */
export const CONVERGENCE_TARGETS = {
  teaching: {
    id: 'teaching', label: '教学 / 粗略复盘', targetMbb: 50, maxIterations: 20000,
    hint: '目标 <50 mbb/hand：只看大方向，混合频率误差大，不适合抠价值/诈唬比例。CFR+ 通常 5k～20k 迭代。'
  },
  daily: {
    id: 'daily', label: '日常可靠复盘（对标 PioSolver）', targetMbb: 1, maxIterations: 500000,
    hint: '目标 <1 mbb/hand：可用于学习复盘、价值/诈唬比例与范围笔记。单街/两街且尺度较少约 10 万～50 万迭代；三街、多尺度或深码大树需更多。'
  },
  fine: {
    id: 'fine', label: '精细 / 三街大树深码', targetMbb: 0.5, maxIterations: 1000000,
    hint: '目标 <0.5 mbb/hand：100 万次迭代预算，适合三街、多下注尺寸、深码大树，耗时较长。'
  }
};
export const SOLVE_ITER = { fast: 100000, precise: 500000 }; // 兼容旧调用：仅作为预算别名，不再作为「有效性」判据

/** 解析收敛配置：targetMbb 为停止指标，maxIterations 仅为预算上限。显式 iterations（预览/测试）只收紧预算。 */
export function resolveConvergence(req = {}) {
  const q = CONVERGENCE_TARGETS[req.quality] ? req.quality : 'daily';
  const t = CONVERGENCE_TARGETS[q];
  const rawTarget = Number(req.targetMbb);
  const targetMbb = Number.isFinite(rawTarget) && rawTarget > 0 ? rawTarget : t.targetMbb;
  const rawIter = Number(req.iterations);
  const maxIterations = Number.isFinite(rawIter) && rawIter > 0 ? Math.floor(rawIter) : t.maxIterations;
  return { quality: q, targetMbb, maxIterations, label: t.label, hint: t.hint };
}

/** 当前平均策略的可剥削度 NashConv = max(0, BR_H - Eq) + max(0, Eq - BR_V)，单位 mbb/hand */
function measureNashConv(ctx, root) {
  const heroStrat = (s, b, acts) => avgStrat(ctx.nodes.get(s.key), 'hero', b, acts.length);
  const villainStrat = (s, b, acts) => avgStrat(ctx.nodes.get(s.key), 'villain', b, acts.length);
  const eqEV = dealLoop(ctx, root, (bh, bv, pD) => evaluate(root, bh, bv, pD, ctx, { heroStrat, villainStrat }));
  const brHero = heroBRValue(root, ctx, villainStrat);
  const brVillain = villainBRValue(root, ctx, heroStrat);
  // 与正式结果同一口径：max(0, BR_H - Eq) + max(0, Eq - BR_V)。
  // 近似模型个别局面会出现 BR 顺序反转（brHero < eqEV 或 brVillain > eqEV）使两项都被钳成 0。
  // 按 V1.14 契约：0 必须视为「测量下限」而非达标，否则会伪造收敛。
  // 检测到反转时返回一个小的正下限（0.1 mbb），确保 converged=false 且如实标注未达标。
  // 与正式结果同一口径：max(0, BR_H - Eq) + max(0, Eq - BR_V)。
  // 近似模型个别局面会出现 BR 顺序反转得到 0，调用方必须把 0 视为「测量下限」而非达标。
  const gainH = Math.max(0, brHero - eqEV), gainV = Math.max(0, eqEV - brVillain);
  return Math.round((gainH + gainV) * 1000 * 10) / 10;
}

function runCFR(ctx, root, onProgress, label, conv = null) {
  const { pH, pV } = ctx;
  const pairs = [];
  for (let bh = 0; bh < ctx.NB; bh++) for (let bv = 0; bv < ctx.NB; bv++) {
    const pD = pH[bh] * pV[bv];
    if (pD > 0) pairs.push([bh, bv, pD]);
  }
  if (!pairs.length) return { iterations: 0, exploitabilityMbb: null, converged: false, targetMbb: conv ? conv.targetMbb : null };
  const iters = Math.max(1, Math.floor(ctx.iterations) || 0);
  const step = Math.max(10, Math.floor(iters / 120));
  // 检查点对齐「一轮完整牌力档扫描」，避免半轮采样造成的 NashConv 假震荡
  const checkEvery = conv
    ? Math.max(pairs.length, Math.ceil(Math.max(pairs.length, Math.floor(iters / 24)) / pairs.length) * pairs.length)
    : Infinity;
  // 采样式 CFR 的单次 NashConv 会震荡（偶发 0 值），必须用 3 点滑动窗口 + 连续达标 + 最小迭代门槛防误判
  const history = [];
  const minIters = Math.min(Math.floor(iters * 0.1), 5000);
  let lastMbb = null, converged = false, ran = 0;
  for (let it = 0; it < iters; it++) {
    if (ctx.cancelled) throw new Error('CANCELLED');
    const pr = pairs[it % pairs.length]; // 轮转覆盖全部牌力档组合，等价于按序全量扫描
    cfr(root, pr[0], pr[1], 1, 1, pr[2], ctx);
    ran = it + 1;
    if (conv && ran % checkEvery === 0) {
      history.push(measureNashConv(ctx, root));
      if (history.length > 3) history.shift();
      lastMbb = Math.round(history.reduce((a, b) => a + b, 0) / history.length * 10) / 10;
      if (ran >= minIters && history.length >= 3 && history.every(x => x > 0 && x <= conv.targetMbb)) converged = true;
    }
    if (onProgress && (it % step === 0 || ran === iters || converged)) {
      onProgress(ran / iters, label, {
        iterations: ran, exploitabilityMbb: lastMbb,
        targetMbb: conv ? conv.targetMbb : null, converged
      });
    }
    if (converged) break;
  }
  if (conv && lastMbb == null) lastMbb = measureNashConv(ctx, root);
  // 实际执行的迭代次数（界面显示为「辅助信息」，有效性只看 exploitabilityMbb）
  return { iterations: ran, exploitabilityMbb: lastMbb, converged, targetMbb: conv ? conv.targetMbb : null };
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

/* V1.18 策略热力图：每个 13×13 类别格输出 fold/call/raise 三路频率，
 * 直接面对下注的决策节点取 root 策略（与 focus 同源），不再经过「应用到子节点」。
 * 输出 { hero: [[{fold,call,raise,main,mix,n}]] }，main=主策略动作，mix=是否混合策略。 */
function strategyHeatFor(ctx, root, combos, buckets, who) {
  const grid = Array.from({ length: 13 }, () => Array.from({ length: 13 }, () => ({ fold: 0, call: 0, raise: 0, n: 0, cards: [] })));
  const acts = actionList(root, ctx);
  const node = ctx.nodes.get(root.key);
  if (!node || !acts.length) return { hero: [], villain: [] };
  const foldIdx = acts.findIndex(a => a.type === 'FOLD');
  const callIdx = acts.findIndex(a => a.type === 'CALL' || a.type === 'CHECK');
  combos.forEach((c, i) => {
    const [ci, cj] = comboClassIndices(c[0], c[1]);
    const b = buckets.bucketOf[i];
    const s = avgStrat(node, who, b, acts.length);
    const cell = grid[ci][cj];
    cell.fold += foldIdx >= 0 ? (s[foldIdx] || 0) : 0;
    cell.call += callIdx >= 0 ? (s[callIdx] || 0) : 0;
    for (let k = 0; k < acts.length; k++) {
      if (acts[k].type === 'BET' || acts[k].type === 'RAISE' || acts[k].type === 'ALLIN') cell.raise += s[k] || 0;
    }
    // 完整花色组合（title 里展示，最多 4 个）
    if (cell.cards.length < 4) cell.cards.push(cardStr(c[0]) + cardStr(c[1]));
    cell.n++;
  });
  const out = Array.from({ length: 13 }, () => new Array(13).fill(null));
  for (let i = 0; i < 13; i++) for (let j = 0; j < 13; j++) {
    const c = grid[i][j];
    if (!c.n) continue;
    const f = c.fold / c.n, ca = c.call / c.n, r = c.raise / c.n;
    const arr = [{ k: 'fold', v: f }, { k: 'call', v: ca }, { k: 'raise', v: r }];
    const top = arr.slice().sort((a, b) => b.v - a.v);
    out[i][j] = {
      fold: Math.round(f * 1000) / 1000, call: Math.round(ca * 1000) / 1000, raise: Math.round(r * 1000) / 1000,
      main: top[0].v > 0.02 ? top[0].k : 'fold', mix: top[0].v < 0.9, n: c.n,
      cards: c.cards
    };
  }
  return out;
}

/* V1.18 河牌教学拆解：把 Villain 下注范围按权益排序切成价值区(top betValueFrac)
 * 与诈唬区(bottom betBluffFrac_跨街衰减)，按手牌类别聚合，展示完整花色组合。
 * 河牌权益为穷举精确值(villainEq)，可直接用；仅在河牌面对下注时生成。 */
function buildRiverLesson(req, heroCombos, villainCombos, villainEq, board, rangeCond, pot, facing, focus) {
  if (board.length !== 5 || !(facing > 0)) return null;
  const n = villainCombos.length;
  if (!n) return null;
  const pairs = villainCombos.map((c, i) => ({ c, eq: villainEq[i] })).sort((a, b) => b.eq - a.eq);
  const nVal = Math.max(1, Math.round(n * rangeCond.betValueFrac));
  const nBluff = Math.max(0, Math.round(n * rangeCond.betBluffFrac));
  const classify = (list, kind) => {
    const byCls = new Map();
    list.forEach(x => {
      const label = classLabel(...comboClassIndices(x.c[0], x.c[1]));
      if (!byCls.has(label)) byCls.set(label, { label, kind, n: 0, eqSum: 0, examples: [], hi: -Infinity, lo: Infinity });
      const g = byCls.get(label);
      g.n++; g.eqSum += x.eq; g.hi = Math.max(g.hi, x.eq); g.lo = Math.min(g.lo, x.eq);
      if (g.examples.length < 4) g.examples.push(cardStr(x.c[0]) + cardStr(x.c[1]));
    });
    return [...byCls.values()].map(g => ({
      label: g.label, kind: g.kind, combos: g.n,
      eq: Math.round(g.eqSum / g.n * 1000) / 1000,
      examples: g.examples
    })).sort((a, b) => b.eq - a.eq);
  };
  const needPct = facing / (pot + facing);          // 底池赔率门槛 = 跟注额 / (底池 + 跟注额)
  const mdf = pot / (pot + facing);                 // 最小防守频率 = 底池 / (底池 + 下注)
  // V1.18.1 关键口径：抓诈门槛必须对比「你对 Villain 实际下注范围」的权益（eqCall），
  // 不是对 Villain 全范围的权益。GTO 档两者巧合相等（下注范围=全范围），剥削档下注范围
  // 被极化收窄后 eqCall 会远低于全范围权益（实测 TAG 2.6% vs 35.3%），用错口径会误报
  // 「权益达标应跟注」而实际跟注 −35BB。优先取 conditional.eqCall，回退全范围值。
  const eqBet = focus && focus.conditional && focus.conditional.eqCall != null ? focus.conditional.eqCall : null;
  const eqAll = focus && focus.equityVsVillainRange != null ? focus.equityVsVillainRange : null;
  const eq = eqBet != null ? eqBet : eqAll;
  return {
    pot: Math.round(pot * 10) / 10, bet: Math.round(facing * 10) / 10,
    needPct: Math.round(needPct * 1000) / 1000, mdf: Math.round(mdf * 1000) / 1000,
    heroEquity: eq, heroEquityAllRange: eqAll, bluffCatchOk: eq != null && eq >= needPct,
    value: classify(pairs.slice(0, nVal), 'value'),
    bluff: classify(pairs.slice(-nBluff), 'bluff'),
    valueCombos: nVal, bluffCombos: nBluff, totalCombos: n,
    valueFrac: rangeCond.betValueFrac, bluffFrac: rangeCond.betBluffFrac,
    polarization: Math.round((rangeCond.polarization || 0) * 100) / 100,
    streetSteps: rangeCond.streetSteps || 0
  };
}

/** 主入口：求解一个决策点 */
export function solveCore(req, onProgress = () => {}) {
  const t0 = Date.now();
  const board = (req.board || []).slice(0, 5);
  if (board.length === 1 || board.length === 2) throw new Error('公共牌需为 0 张（翻前）或 3–5 张（翻后）；当前 1–2 张无法求解');
  const phase = board.length === 0 ? 'preflop' : 'postflop';
  if ((req.sizes || []).length > 4) throw new Error('每街下注尺度最多 4 个，请压缩尺度集合');
  // 停止指标 = 可剥削度目标；迭代次数仅为预算上限（显式 iterations 用于实时预览/测试收紧预算）
  const conv = resolveConvergence(req);
  const ctx = makeCtx(req, conv.maxIterations);
  const root = makeRoot(req);
  const treeSize = countTree(ctx, root);
  if (treeSize > 600) throw new Error('分支过大：请压缩下注尺度集合或收窄对手范围后重试');

  // 随机种子只纳入真正影响求解的输入：GTO 结果与 UI 上残留的画像参数无关。
  // 否则 archetype/intensity 变化会改变蒙特卡洛采样，同一局面可能随机翻转成「100% 全下」。
  const seedKey = [board, req.heroRange, req.villainRange, req.pot, req.stack, req.sizes, req.mode];
  if (req.mode === 'exploit') seedKey.push(req.archetype, req.intensity);
  const seed = hashSeed(JSON.stringify(seedKey));
  const rng = mulberry32(seed);
  onProgress(0.03, '展开范围与计算摊牌权益');
  // Hero 组合集不能排除 Hero 自己的手牌：否则 focusStrategy 永远找不到目标手牌，
  // 权益取 eq[0]（随手一张牌）、策略桶取全范围平均。对手组合仍须排除 Hero 已知牌。
  const blockedShared = [...board, ...(req.villainCards || []), ...(req.deadCards || [])];
  const usedVillain = [...blockedShared, ...(req.heroCards || [])];
  let heroRange = req.heroRange, villainRange = req.villainRange;
  if (req.mode === 'exploit') {
    const A = ARCHETYPE_PARAMS[req.archetype] || ARCHETYPE_PARAMS.tag;
    // V1.15：范围宽度已由派生层按「绝对宽度目标」算好（位置对 × 风格 × 结构修正），
    // 此处不再二次调整宽度，否则松型画像会重复放大已经按绝对宽度收窄的范围。
    villainRange = applyArchetypeToRange(villainRange, A.width, ctx.intensity, req.villainRangeLocked === true, req.villainRangePreNarrowed === true);
  }
  const heroCombos = matrixToCombos(heroRange, blockedShared, 0.02, 380);
  // cap 采样可能剔除 Hero 已知手牌：强制补入，保证手牌条件频率与权益取到真实目标
  const heroHand = req.heroCards || [];
  if (heroHand.length === 2) {
    const hit = heroCombos.findIndex(c => c[0] === heroHand[0] && c[1] === heroHand[1]);
    if (hit < 0) {
      const [i, j] = comboClassIndices(heroHand[0], heroHand[1]);
      const w = Math.max(0.02, Number(heroRange?.[i]?.[j]) || 0.02);
      const known = [heroHand[0], heroHand[1], w];
      if (heroCombos.length >= 380) heroCombos[heroCombos.length - 1] = known;
      else heroCombos.push(known);
    }
  }
  const villainCombos = matrixToCombos(villainRange, usedVillain, 0.02, 380);
  if (!heroCombos.length || !villainCombos.length) throw new Error('范围为空：与手牌/公共牌/死牌冲突后无可用组合，请放宽范围');

  /* V1.15：翻前权益采样数 96 → 512。原先 96 次采样的标准误约 4.9%，
   * 会让「33 面对 3bet」的权益在门槛线两侧抖动，推荐动作随之翻转（弃牌/跟注）。 */
  const samples = board.length >= 5 ? 0 : board.length === 0 ? 512 : 256;
  const heroEq = heroCombos.map(c => comboEquityVsRange([c[0], c[1]], villainCombos, board, samples, rng));
  const villainEq = villainCombos.map(c => comboEquityVsRange([c[0], c[1]], heroCombos, board, samples, rng));
  // focus 手牌的高精度权益重算上下文（独立 rng，seed 只取已确定的求解输入）
  const eqCtx = { villainCombos, board, samples: board.length >= 5 ? 2048 : 4096, key: seed };
  const hb = bucketize(heroCombos, heroEq, N_BUCKETS);
  const vb = bucketize(villainCombos, villainEq, N_BUCKETS);
  /* 桶级权益矩阵：原先每桶对仅 28 次采样（标准误约 9.4%），会把 EV 估算出噪声，
   * 直接影响 CFR 的动作选择。V1.15 提到 128 次（标准误约 4.4%）。 */
  ctx.E = buildEquityMatrix(heroCombos, villainCombos, hb, vb, board, N_BUCKETS, board.length === 0 ? 128 : 96, rng);

  /* V1.17 范围条件化（方案 B 解耦 + 跨街收窄）：摊牌收益不再对每条路径用同一套权益。
   * 桶按 villainEq 等数量划分 → 桶 b 覆盖全局权益分位 [b/NB, (b+1)/NB]，
   * 因此可用「保留区间」精确映射到「桶内该留哪些组合」：
   *   E_call  = 下注范围 = 高权益价值牌(top betValueFrac) + 低权益诈唬牌(bottom betBluffFrac_跨街衰减)
   *   E_raise = 被跟注范围 = cbet 价值子集内的更强子集(top contTopFrac = betValueFrac × continueValueFrac)，
   *             而非 V1.16 的「全范围 top callContinueFrac」——这样「翻后弃牌率」与「被跟注强度」彻底解耦。
   * 跨街：诈唬占比逐街 ×streetBluffDecay、继续范围逐街 ×streetNarrowPerBet → 范围逐步收窄且更极化。
   * 弃牌率由 postflopContinueFrac 单独决定（不在权益矩阵里，而在 focusStrategy/节点锁定里）。
   * E_call ≥ E_raise 恒成立（加采样噪声钳制），这就是「诈唬捕捉价值」的数学表达。 */
  const rangeCondRaw = rangeConditionParams(req.mode, req.archetype, req.intensity);
  const rangeCond = streetAdjustedRangeCondition(rangeCondRaw, board.length);
  ctx.rangeCondition = rangeCond;
  if (board.length > 0) {
    const eqOf = new Map();
    villainCombos.forEach((c, i) => eqOf.set(c, villainEq[i]));
    const byEq = (x, y) => (eqOf.get(x) ?? 0.5) - (eqOf.get(y) ?? 0.5);
    const intervalsCall = [[0, rangeCond.betBluffFrac], [1 - rangeCond.betValueFrac, 1]];
    const intervalsRaise = [[1 - rangeCond.contTopFrac, 1]];
    const provider = intervals => (bucket, fullList) => {
      const sorted = fullList.slice().sort(byEq);
      const lo = bucket / N_BUCKETS, hi = (bucket + 1) / N_BUCKETS, m = sorted.length;
      const keep = sorted.filter((_, k) => {
        const frac = lo + (hi - lo) * (k + 0.5) / m;
        return intervals.some(([a, b]) => frac >= a - 1e-9 && frac < b);
      });
      return keep.length ? keep : fullList; // 空子集回退全量，避免除零/偏差
    };
    // V1.16：新增矩阵用独立 rng，避免消耗主求解采样序列导致既有局面收敛判定漂移。
    const subRng = mulberry32(hashSeed('cond|' + seed));
    const subE = intervals => buildEquityMatrix(heroCombos, villainCombos, hb, vb, board, N_BUCKETS, 80, subRng, { subsetForBucket: provider(intervals) });
    ctx.E_call = subE(intervalsCall);
    ctx.E_raise = subE(intervalsRaise);
    for (let a = 0; a < N_BUCKETS; a++) for (let b = 0; b < N_BUCKETS; b++) {
      ctx.E_raise[a][b] = Math.max(ctx.E_raise[a][b], ctx.E_call[a][b] - 0.02);
    }
    // 隐含赔率：仅 Hero call 路径计入「后续街击中提升牌」的期望收益；河牌为 0。
    // improve[b] = max(0, 0.55 - 桶均权益)：边缘牌提升空间大，坚果/垃圾牌提升小。
    // realization：IP 0.35 / OOP 0.20；深码(≥150BB)再 ×0.7（隐含赔率更难兑现）。
    ctx.implied = new Float64Array(N_BUCKETS);
    if (board.length < 5) {
      const bEq = new Float64Array(N_BUCKETS), bCnt = new Float64Array(N_BUCKETS);
      heroCombos.forEach((c, i) => { bEq[hb.bucketOf[i]] += heroEq[i]; bCnt[hb.bucketOf[i]]++; });
      const realization = (req.heroOOP ? 0.20 : 0.35) * ((Number(req.stack) || 0) >= 150 ? 0.7 : 1);
      for (let b = 0; b < N_BUCKETS; b++) {
        const eq = bCnt[b] ? bEq[b] / bCnt[b] : 0.5;
        ctx.implied[b] = Math.max(0, 0.55 - eq) * (Number(req.stack) || 0) * realization;
      }
    }
  }
  const pH = new Float64Array(N_BUCKETS), pV = new Float64Array(N_BUCKETS);
  heroCombos.forEach((_, i) => { pH[hb.bucketOf[i]] += 1; });
  villainCombos.forEach((_, i) => { pV[vb.bucketOf[i]] += 1; });
  for (let b = 0; b < N_BUCKETS; b++) { pH[b] /= heroCombos.length; pV[b] /= villainCombos.length; }
  ctx.pH = pH; ctx.pV = pV;

  onProgress(0.18, '求解均衡策略', { iterations: 0, exploitabilityMbb: null, targetMbb: conv.targetMbb, converged: false });
  const gtoRun = runCFR(ctx, root, (p, l, info) => onProgress(0.18 + p * 0.62, l, info), 'gto', conv);
  const itersRun = gtoRun.iterations;

  const rootActs = actionList(root, ctx);
  const avgHero = (state, bucket, acts, c) => avgStrat(c.nodes.get(state.key), 'hero', bucket, acts.length);
  const avgVillain = (state, bucket, acts, c) => avgStrat(c.nodes.get(state.key), 'villain', bucket, acts.length);
  const eqEV = dealLoop(ctx, root, (bh, bv, pD) => evaluate(root, bh, bv, pD, ctx, { heroStrat: avgHero, villainStrat: avgVillain }));
  const brHero = heroBRValue(root, ctx, avgVillain);
  const brVillain = villainBRValue(root, ctx, avgHero);
  const gainH = Math.max(0, brHero - eqEV), gainV = Math.max(0, eqEV - brVillain);
  // 以 CFR 过程中最后一次 NashConv 测量为准（达标提前停止时与最终策略一致），避免口径漂移
  const exploitabilityMbb = gtoRun.exploitabilityMbb != null
    ? gtoRun.exploitabilityMbb : Math.max(0, Math.round((gainH + gainV) * 1000 * 10) / 10);

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

  // V1.18：focus 先算一次（教学拆解与结果页共用，避免重复高精度采样）
  const focusGto = focusStrategy(req, rootNode, rootActs, heroCombos, hb, heroEq, pH, eqCtx, ctx);
  const lesson = buildRiverLesson(req, heroCombos, villainCombos, villainEq, board,
    ctx.rangeCondition || {}, req.pot, req.facingBet, focusGto);
  const stratHero = board.length > 0 ? strategyHeatFor(ctx, root, heroCombos, hb, 'hero') : [];

  const base = {
    mode: 'gto', archetype: null, phase, boardCount: board.length,
    quality: conv.quality, targetMbb: conv.targetMbb, converged: gtoRun.converged,
    maxIterations: conv.maxIterations,
    decisionNode: req.decisionNode || (phase === 'preflop' ? 'PREFLOP|HERO' : 'FLOP|HERO'),
    pot: Math.round(req.pot * 10) / 10, stacks: Math.round(req.stack * 10) / 10,
    actions: rootActs.map((a, i) => ({ type: a.type, sizeBB: a.raiseTo != null ? a.raiseTo : (a.amount != null ? a.amount : null), label: a.label, freq: gtoFreqRounded[i], ev: Math.round(gtoEV[i] * 100) / 100 })),
    userAction: req.userAction || null, evLossBB,
    exploitGainBB: null, exploitabilityMbb, iterations: itersRun, iterationsExploit: null, treeSize,
    durationMs: Date.now() - t0,
    convergenceNote: phase === 'preflop'
      ? '翻前近似：起手牌范围对抗权益分档（蒙特卡洛补全 5 张公共牌）+ 街内 CFR；未展开翻后博弈树，不等同商业 Solver 的翻前解，仅供范围对抗参考。迭代口径：1 次迭代 = 1 次 CFR 遍历，统计次数 = 实际执行次数'
      : '近似均衡：10 档牌力抽象 + 街内有限博弈树 + CFR 线性平均；摊牌收益按路径条件化（call 面对对手下注范围含诈唬、raise 被跟注面对纯价值范围），call 计入隐含赔率近似。可剥削度按牌力分档先验下的最优应对增益估计，非 PioSolver 级精度。迭代口径：1 次迭代 = 1 次 CFR 遍历，统计次数 = 实际执行次数',
    rangeCondition: ctx.rangeCondition || null,
    impliedMbb: ctx.implied ? Math.round((Array.from(ctx.implied).reduce((a, b) => a + b, 0) / N_BUCKETS) * 1000) / 10 : null,
    ranges: { hero: req.heroRange, villain: villainRange, heroCombos: heroCombos.length, villainCombos: villainCombos.length },
    heatmap: {
      hero: heatFor(ctx, root, heroCombos, hb, villainCombos, vb, 'hero'),
      villain: heatFor(ctx, root, heroCombos, hb, villainCombos, vb, 'villain'),
      // V1.18 策略分区：每格 fold/call/raise 频率 + 主策略/混合标记
      strategy: { hero: stratHero }
    },
    // V1.18 河牌教学拆解（仅河牌面对下注时非空）
    lesson,
    focus: focusGto,
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
  exp.E = ctx.E; exp.E_call = ctx.E_call; exp.E_raise = ctx.E_raise; exp.implied = ctx.implied;
  exp.rangeCondition = ctx.rangeCondition;
  exp.pH = pH; exp.pV = pV; exp.locked = true; exp.baseNodes = ctx.nodes;
  const expRoot = makeRoot(req);
  const expItersRun = runCFR(exp, expRoot, (p, l, info) => onProgress(0.83 + p * 0.15, l, {
    ...info, exploitabilityMbb, targetMbb: conv.targetMbb, converged: gtoRun.converged
  }), 'exploit').iterations;

  const expHeroStrat = (state, bucket, acts) => avgStrat(exp.nodes.get(state.key), 'hero', bucket, acts.length);
  const gtoVsLocked = dealLoop(ctx, root, (bh, bv, pD) => evaluate(root, bh, bv, pD, ctx, { heroStrat: avgHero, villainStrat: lockedProvider }));
  const expVsLocked = dealLoop(ctx, root, (bh, bv, pD) => evaluate(root, bh, bv, pD, exp, { heroStrat: expHeroStrat, villainStrat: lockedProvider }));
  // 允许负增益：剥削路线劣于 GTO 时必须如实呈现，供 UI 提示「剥削更差」
  const exploitGainBB = Math.round((expVsLocked - gtoVsLocked) * 100) / 100;

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

  // V1.18：剥削档的策略热力图与教学拆解都对齐剥削结果（对手画像已锁定）
  const expFocus = focusStrategy(req, expRootNode, rootActs, heroCombos, hb, heroEq, pH, eqCtx, exp);
  const expStratHero = board.length > 0 ? strategyHeatFor(exp, expRoot, heroCombos, hb, 'hero') : [];
  const expLesson = buildRiverLesson(req, heroCombos, villainCombos, villainEq, board,
    ctx.rangeCondition || {}, req.pot, req.facingBet, expFocus);

  return {
    ...base, mode: 'exploit', archetype: req.archetype, intensity: ctx.intensity,
    exploitGainBB, archetypeLabel: (req.archetype || '').toUpperCase(),
    // 剥削路线本身不是均衡，NashConv 无意义；保留 GTO 基线值供 UI 标注「均衡参考可剥削度」
    exploitabilityMbb, nashConvScope: 'gto-reference',
    // 剥削路线也要给出「你的手牌」条件策略，否则结果页仍显示 GTO 档位
    focus: expFocus || base.focus,
    heatmap: { ...base.heatmap, strategy: { hero: expStratHero, gto: stratHero } },
    lesson: expLesson,
    iterationsExploit: expItersRun,
    actions: rootActs.map((a, i) => ({ type: a.type, sizeBB: a.raiseTo != null ? a.raiseTo : (a.amount != null ? a.amount : null), label: a.label, freq: expFreqRounded[i], ev: expEV[i] })),
    evLossBB: expUserLoss,
    gtoActions: base.actions,
    gtoEvLossBB: base.evLossBB,
    lockedInfo: { params: ARCHETYPE_PARAMS[req.archetype] || ARCHETYPE_PARAMS.tag, widthApplied: true, rangeClamped: req.villainRangeLocked === true, widthSource: req.villainRangePreNarrowed === true ? 'action-consistent-absolute' : 'preset-width' },
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
    acts.forEach((a, i) => {
      if (a.type !== acts[idx].type) return;
      // RAISE 的 amount 是加注增量，用户录入的 amountBB 是「加注至」总额 → 用 raiseTo 对齐
      const dd = Math.abs(((a.raiseTo != null ? a.raiseTo : a.amount) || 0) - user.amountBB);
      if (dd < d) { d = dd; best = i; }
    });
    idx = best;
  }
  return idx;
}
function focusStrategy(req, rootNode, acts, combos, hb, eq, pH, eqCtx, ctx) {
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
  let sr = roundedFreqs(Array.from(s));
  // V1.15：focus 手牌的权益单独用高精度采样重算（独立 rng，不污染主流，结论可复现）。
  // 全范围的桶权益仍用主采样值，保证策略频率与分桶口径一致。
  let eqFocus = (eq[target >= 0 ? target : 0] || 0.5);
  if (target >= 0 && eqCtx && eqCtx.villainCombos && eqCtx.villainCombos.length && eqCtx.samples > 0) {
    const r2 = mulberry32(hashSeed('focus|' + JSON.stringify(eqCtx.key || '')));
    eqFocus = comboEquityVsRange([hc[0], hc[1]], eqCtx.villainCombos, eqCtx.board || [], eqCtx.samples, r2);
  }

  /* V1.16 手牌级条件收益重算（关键）：
   * 桶策略把「K4 顶对弱踢脚」和「AK/KK 强牌」混在同一权益桶，都会 raise。
   * 但对具体手牌，call 面对对手「下注范围」(含诈唬)、raise 被跟注面对「纯价值范围」，
   * 二者权益天差地别。这里用手牌级条件权益重估各动作的收益，覆盖桶策略。
   * 仅在翻后 + 面对下注 + 有三套矩阵时启用，翻前维持原桶策略不变。 */
  let conditional = null;
  const rc = ctx && ctx.rangeCondition;
  if (rc && ctx.E_call && ctx.E_raise && req.facingBet > 0 && target >= 0 && (req.board || []).length > 0) {
    const board = req.board || [];
    const facing = Math.min(req.facingBet, req.stack || Infinity);
    const pot = req.pot;
    // 范围条件化参数：call 用下注范围(价值+诈唬)，raise 被跟注用纯价值范围
    const vc = eqCtx.villainCombos;
    const veq = vc.map(c => comboEquityVsRange(c, combos, board, 128, mulberry32(20261119)));
    const sorted = vc.map((c, i) => ({ c, eq: veq[i] })).sort((x, y) => y.eq - x.eq);
    const nV = Math.max(1, Math.round(sorted.length * rc.betValueFrac));
    const nB = Math.max(0, Math.round(sorted.length * rc.betBluffFrac));
    // V1.17 解耦：contSet 不再用「全范围 top callContinueFrac」，
    // 而是「cbet 价值子集内的更强子集」= 全范围 top contTopFrac（betValueFrac × continueValueFrac）。
    // 这样被跟注范围强度与「翻后弃牌率」彻底脱钩：TAG 即使少弃，被跟注也只剩顶级价值牌。
    const nCont = Math.max(1, Math.round(sorted.length * rc.contTopFrac));
    const betSet = [...sorted.slice(0, nV), ...sorted.slice(-nB)].map(x => [x.c[0], x.c[1], 1]);
    const contSet = sorted.slice(0, nCont).map(x => [x.c[0], x.c[1], 1]);
    const eqCall = betSet.length ? comboEquityVsRange(hc, betSet, board, 2048, mulberry32(777)) : eqFocus;
    const eqCont = contSet.length ? comboEquityVsRange(hc, contSet, board, 2048, mulberry32(777)) : eqFocus;
    // 隐含赔率按「手牌级提升潜力」算，而非桶均权益（高权益桶里的 KK 无提升空间，
    // 但同桶的 K4 击中 4 可成两对——桶均值会把这种差异抹平）。
    // 采样 1 张 turn：eq_next 相对 eq_now 的正向提升均值 × 有效后手 × 实现系数。
    let implied = ctx.implied ? (ctx.implied[b] || 0) : 0;
    if (board.length < 5 && board.length > 0) {
      const pool = deckExcluding([...hc, ...board]);
      if (pool.length) {
        const rngImp = mulberry32(hashSeed('implied|' + JSON.stringify(hc) + JSON.stringify(board)));
        let gain = 0, m = 0;
        for (let s = 0; s < 96; s++) {
          const turn = pool[Math.floor(rngImp() * pool.length)];
          const b4 = [...board, turn];
          const eqNow = comboEquityVsRange(hc, betSet.slice(0, 24), board, 32, rngImp);
          const eqNext = comboEquityVsRange(hc, betSet.slice(0, 24), b4, 32, rngImp);
          gain += Math.max(0, eqNext - eqNow); m++;
        }
        const realization = (req.heroOOP ? 0.20 : 0.35) * ((Number(req.stack) || 0) >= 150 ? 0.7 : 1);
        implied = (gain / Math.max(1, m)) * (Number(req.stack) || 0) * realization;
      }
    }
    // 各动作手牌级 EV（BB）
    const evOf = (a) => {
      if (a.type === 'FOLD') return 0;
      if (a.type === 'CHECK') return eqCall * pot;
      if (a.type === 'CALL') {
        const amt = a.amount != null ? a.amount : facing;
        return eqCall * (pot + amt) - amt + implied;
      }
      if (a.type === 'RAISE' || a.type === 'ALLIN') {
        // V1.17 解耦：弃牌率只由「翻后继续率」决定（TAG 强范围少弃→foldP 低；LAG 空气多→foldP 高），
        // 与「被跟注面对多强范围」（eqCont，已用 contTopFrac）互相独立。
        const to = a.raiseTo != null ? a.raiseTo : (a.amount || 0) + facing;
        const invest = to; // Hero 本街总投入（含已投入与跟注段）
        const callP = rc.postflopContinueFrac != null ? rc.postflopContinueFrac : rc.callContinueFrac;
        const foldP = 1 - callP;
        // V1.20 记账修正：pot = req.pot 已含对手这手下注额 facing
        //   · 对手弃牌：底池 = pot + invest，Hero 赢回自己的投入 → 净收益 = pot
        //     （旧式 pot - (to - facing) 漏算了自己多投的那段，虚低弃牌分支）
        //   · 对手跟注：对手再补 (invest - facing) → 底池 = pot + invest + (invest - facing)
        //     （旧式 pot + invest*2 多算了一个 facing，虚高被跟注分支）
        const potIfFold = pot + invest;
        const potIfCall = pot + invest + Math.max(0, invest - facing);
        return foldP * (potIfFold - invest) + callP * (eqCont * potIfCall - invest);
      }
      return 0;
    };
    const evs = acts.map(evOf);
    const best = evs.reduce((bi, v, i) => v > evs[bi] ? i : bi, 0);
    // 用 softmax 保留一定混合（避免硬切换），温度按 EV 差缩放。
    // V1.20：温度设上限——旧式 temp ∝ EV 差距意味着「差距越大越混」，
    // 而记账修正后 EV 差距普遍变大（例：河牌 call +4.0 vs 全下 −7.6），
    // 会把明显负 EV 的动作也分到两成频率。现在温度封顶 1.5 BB：
    // EV 差距大时按固定不确定性近似，差距小时仍保留混合。
    const maxEv = Math.max(...evs), minEv = Math.min(...evs);
    const temp = Math.min(1.5, Math.max(0.3, (maxEv - minEv) * 0.35));
    const w = evs.map(v => Math.exp((v - maxEv) / temp));
    const wsum = w.reduce((a, x) => a + x, 0);
    sr = roundedFreqs(w.map(x => x / wsum));
    conditional = { eqCall: Math.round(eqCall * 1000) / 1000, eqCont: Math.round(eqCont * 1000) / 1000,
      impliedBB: Math.round(implied * 100) / 100, bestLabel: acts[best].label, evs: evs.map(v => Math.round(v * 100) / 100),
      betCombos: betSet.length, contCombos: contSet.length,
      // V1.17 解耦诊断字段
      foldP: Math.round((1 - (rc.postflopContinueFrac != null ? rc.postflopContinueFrac : rc.callContinueFrac)) * 1000) / 1000,
      contTopFrac: Math.round((rc.contTopFrac || 0) * 1000) / 1000,
      streetSteps: rc.streetSteps || 0, polarization: Math.round((rc.polarization || 0) * 100) / 100 };
  }
  const out = { cards: hc.map(cardStr), bucket: b, equityVsVillainRange: Math.round(eqFocus * 1000) / 1000,
    strategy: acts.map((a, i) => ({ type: a.type, label: a.label, freq: sr[i] })) };
  if (conditional) out.conditional = conditional;
  return out;
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
