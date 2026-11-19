/* range-by-action.js —— 按行动历史派生「行动一致范围」（纯逻辑，无 DOM / DB 依赖）
 *
 * 背景：求解器收到的范围默认是位置预设（如 BB 防守约前 70%）。当对手在翻前
 * 连续加注（3bet / 4bet / 5bet）后，其真实范围必然远窄于位置预设。若仍用
 * 全范围求解，弱牌（如 33）会被算出虚高权益，进而推出「100% 4bet」这类
 * 明显失真的建议。
 *
 * ── V1.15：宽度口径由「相对位置预设的固定 fraction」改为「绝对全范围百分比」 ──
 * 旧口径：范围 = 位置预设 × fraction(0.40) → BB 3bet 后仍剩 36.5% 全范围
 *         → 33 权益 53.6% → 伪「100% 4bet」
 * 新口径：W% = 位置对基准(L1) × 风格倍率(L2) × 结构修正(L4)
 *
 *   L1 位置对基准：锚点 = BTN 作为再加注方面对 EP 开池 → GTO 8~12%（中值 10%）
 *                   其余位置对由两个可解释乘子推导（opener 越早越宽、responder 越靠后越宽）
 *   L2 风格倍率：复用 ARCHETYPE_PARAMS.width（tag 0.70 / lag 1.40 / lp 1.30 / tp 0.75 / cs 1.60）
 *   L3 加注档位：按「对手最后一次加注在翻前加注链中的序号」判定 3bet / 4bet / 5bet / 6bet+
 *   L4 结构修正：开池尺寸 / 再加注尺寸 / 有效后手
 *
 * 设计约束：仅用于本次求解；不写回 hand.ranges，不改动 IndexedDB 已录数据。
 * Hero 手牌已知，其范围保持原样，避免手牌条件频率因手牌被排除而退化。
 */
import { emptyMatrix, applyRangeWidth, matrixToCombos } from './cards.js?v=1.21.0';
import { ARCHETYPE_PARAMS } from './archetypes.js?v=1.21.0';

/** 52 choose 2 —— 全范围组合总数，宽度百分比以此为分母 */
export const TOTAL_COMBOS = 1326;

/* ---------------- L1 位置对基准（绝对全范围 %） ---------------- */
/** 锚点：BTN 作为再加注方面对 EP 开池，GTO 8~12% 的中值 */
const ANCHOR_PCT = 10;
/** 开池方位置 → 3bet 宽度乘子（开池越早、范围越宽 → 再加注方需要越宽的应对范围） */
const F_OPENER = { EP: 1.00, CO: 0.92, BTN: 0.85, SB: 0.72 };
/** 再加注方位置 → 乘子（位置越靠后，防守压力越小 → 范围越宽） */
const F_RESPONDER = { UTG: 0.85, LJ: 0.87, HJ: 0.88, MP: 0.90, CO: 0.94, BTN: 1.00, SB: 1.08, BB: 1.20 };
/** 位置归类：6max / 9max 统一映射 */
const OPENER_CLASS = { UTG: 'EP', 'UTG+1': 'EP', 'UTG+2': 'EP', LJ: 'EP', HJ: 'EP', MP: 'EP', CO: 'CO', BTN: 'BTN', SB: 'SB', BB: 'BB' };
const RESPONDER_CLASS = { UTG: 'UTG', 'UTG+1': 'UTG', 'UTG+2': 'UTG', LJ: 'LJ', HJ: 'HJ', MP: 'MP', CO: 'CO', BTN: 'BTN', SB: 'SB', BB: 'BB' };

/* ---------------- L3 加注链档位基准宽度（绝对全范围 %） ---------------- */
/** 加注链序号 → 档位：1=开池，2=3bet，3=4bet，4=5bet，5+=6bet+ */
const TIER_WIDTH = { 4: [4, 6], 5: [1.5, 3], 6: [1, 1.5] };
const TIER_CLAMP = { 4: [1.5, 8], 5: [0.8, 4], 6: [0.5, 2] };
const TIER_LABEL = { 2: '开池', 3: '3bet', 4: '4bet', 5: '5bet', 6: '6bet+' };
/** 开池档：各位置的开池范围宽度（GTO 口径，绝对全范围 %） */
const OPEN_WIDTH = { EP: 16.5, CO: 23.5, BTN: 42.5, SB: 37.5, BB: 78 };
const OPEN_CLAMP = [4, 90];

/* ---------------- L4 结构修正阶梯（按「几个 BB」分段） ---------------- */
const OPEN_SIZE_F = [[2.0, 1.12], [2.5, 1.00], [3.5, 0.88], [Infinity, 0.78]];
const RAISE_SIZE_F = [[3, 1.08], [8, 1.00], [15, 0.92], [Infinity, 0.85]];
const STACK_F = [[40, 0.90], [150, 1.00], [Infinity, 1.06]];
/** 宽度硬边界，防止画像放宽后爆表 */
const W_BASE_CLAMP = [3, 20];
const W_FINAL_CLAMP = [2, 22];

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function stepF(table, v) {
  for (const [lim, f] of table) if (v <= lim) return f;
  return table[table.length - 1][1];
}

/**
 * 把剥削画像宽度作用到对手范围。
 * V1.15：范围宽度已由派生层按「绝对宽度目标」算好（preNarrowed=true），
 * 此处不再重复调整宽度；actionLocked 仍禁止松型复活已剔除组合。
 */
export function applyArchetypeToRange(actionMatrix, width, intensity = 1, actionLocked = false, preNarrowed = false) {
  if (!actionMatrix) return actionMatrix;
  if (preNarrowed) return actionMatrix;
  if (!actionLocked) return applyRangeWidth(actionMatrix, width, intensity);
  const tightened = applyRangeWidth(actionMatrix, Math.min(1, Number(width) || 1), intensity);
  const out = emptyMatrix();
  for (let i = 0; i < 13; i++) for (let j = 0; j < 13; j++) {
    const locked = Number(actionMatrix[i]?.[j]) || 0;
    out[i][j] = locked < 0.02 ? 0 : Math.min(locked, Number(tightened[i]?.[j]) || 0);
  }
  return out;
}

/** 与 cards.js 的 classScore 同源：牌型强度评分（用于按强度保留最强组合） */
function strength(i, j) {
  if (i === j) return 0.50 + i * 0.038;
  const hi = Math.max(i, j), lo = Math.min(i, j);
  const suited = i > j, gap = hi - lo;
  let s = 0.10 + hi * 0.030 + lo * 0.022;
  s += suited ? 0.085 : 0;
  s += gap <= 1 ? 0.05 : gap <= 2 ? 0.03 : gap <= 4 ? 0 : -0.03;
  if (hi === 12 && lo >= 10) s += 0.10;
  if (hi >= 11 && lo >= 9) s += 0.03;
  return Math.min(s, 0.98);
}

/**
 * 统计一方在决策点之前的翻前「再加注级别」：
 *   0 = 未加注（limp / 仅跟注）；1 = 开池加注或 3bet；2 = 4bet；3+ = 5bet 及以上。
 * 仅在对手的加注高于当时桌面最高额时计一级，避免把「加注额被反超后被动跟注」误判。
 * 保留此函数供旧口径与既有断言使用；V1.15 的宽度派生改用 preflopRaiseTier。
 */
export function preflopRaiseLevel(hand, side, decisionIndex = Infinity) {
  const actions = (hand && hand.actions) || [];
  const target = String(side || '').toLowerCase();
  let highest = 1, level = 0;
  const n = Math.max(0, Math.min(Number(decisionIndex) === Infinity ? actions.length : Number(decisionIndex), actions.length));
  for (let i = 0; i < n; i++) {
    const a = actions[i];
    if (String(a.street).toUpperCase() !== 'PREFLOP') continue;
    if (a.type !== 'RAISE_TO' && a.type !== 'ALLIN' && a.type !== 'BET') continue;
    const amt = Number(a.amountBB) || 0;
    if (amt <= highest + 1e-6) continue;
    const actor = String(a.actor || '').toUpperCase();
    const u = actor === 'HERO' || actor === String(hand.positions?.hero || '').toUpperCase() ? 'hero'
      : actor === 'VILLAIN' || actor === String(hand.positions?.villain || '').toUpperCase() ? 'villain' : 'other';
    if (u === target) level++;
    highest = amt;
  }
  return level;
}

/** 旧口径收窄比例（相对位置预设）。V1.15 起不再用于宽度派生，仅保留兼容。 */
export function raiseLevelFraction(level, stackBB) {
  const base = level <= 0 ? 1 : level === 1 ? 0.40 : level === 2 ? 0.20 : level === 3 ? 0.12 : 0.09;
  const deep = Number(stackBB) >= 150 && level >= 2;
  return deep ? Math.max(0.06, Math.round(base * 0.8 * 1000) / 1000) : base;
}

/** 按牌型强度把范围收窄到最强的 fraction 组合数；返回新矩阵，不修改输入 */
export function narrowRangeTop(matrix, fraction, minWeight = 0.02) {
  if (!matrix || !(fraction > 0) || fraction >= 1) return matrix;
  const cells = [];
  let total = 0;
  for (let i = 0; i < 13; i++) for (let j = 0; j < 13; j++) {
    const w = Number(matrix[i]?.[j]) || 0;
    if (w < minWeight) continue;
    const combos = i === j ? 6 : (i > j ? 4 : 12);
    total += combos;
    cells.push({ i, j, w, combos, s: strength(i, j) });
  }
  if (!cells.length) return matrix;
  cells.sort((a, b) => b.s - a.s || b.w - a.w);
  const out = emptyMatrix();
  const limit = total * fraction;
  let acc = 0;
  for (const c of cells) {
    if (acc >= limit) break;
    out[c.i][c.j] = c.w;
    acc += c.combos;
  }
  return out;
}

/* ---------------- V1.15：绝对宽度口径 ---------------- */

/** 动作方归属：hero / villain / other */
function actorSide(hand, a) {
  const actor = String(a.actor || '').toUpperCase();
  const hero = String(hand?.positions?.hero || '').toUpperCase();
  const villain = String(hand?.positions?.villain || '').toUpperCase();
  if (actor === 'HERO' || (hero && actor === hero)) return 'hero';
  if (actor === 'VILLAIN' || (villain && actor === villain)) return 'villain';
  return 'other';
}

function sidePos(hand, side) {
  return String(hand?.positions?.[side] || '').toUpperCase();
}

/**
 * 决策点之前的翻前加注链（每次加注额高于当时桌面最高额者入链）。
 * 链序号即加注层级：第 1 位 = 开池，第 2 位 = 3bet，第 3 位 = 4bet，以此类推。
 */
export function preflopRaiseChain(hand, decisionIndex = Infinity) {
  const actions = (hand && hand.actions) || [];
  const n = Math.max(0, Math.min(Number(decisionIndex) === Infinity ? actions.length : Number(decisionIndex), actions.length));
  const chain = [];
  let highest = Number(hand?.stakes?.sb) || 1;
  for (let i = 0; i < n; i++) {
    const a = actions[i];
    if (String(a.street).toUpperCase() !== 'PREFLOP') continue;
    if (a.type !== 'RAISE_TO' && a.type !== 'ALLIN' && a.type !== 'BET') continue;
    const amt = Number(a.amountBB) || 0;
    if (amt <= highest + 1e-6) continue;
    chain.push({ idx: i, side: actorSide(hand, a), amountBB: amt });
    highest = amt;
  }
  return chain;
}

/**
 * 判定某一方在决策点所处的加注档位。
 *   对方是再加注方（链中位置 ≥ 2）→ 3bet / 4bet / 5bet 档，按 L1 位置对表收窄
 *   对方是开池方（链中第 1 位）   → 开池档，按各位置开池宽度收窄
 *   对方完全未加注                → null，维持位置预设
 */
export function preflopRaiseTier(hand, side, decisionIndex = Infinity) {
  const chain = preflopRaiseChain(hand, decisionIndex);
  const s = String(side || 'villain').toLowerCase();
  let last = -1;
  chain.forEach((c, i) => { if (c.side === s) last = i; });
  if (last < 0) return null;
  const chainIndex = last + 1;
  const isOpener = last === 0;
  const tier = isOpener ? 2 : chainIndex <= 2 ? 3 : chainIndex === 3 ? 4 : chainIndex === 4 ? 5 : 6;
  return {
    chain, chainIndex, tier, tierLabel: TIER_LABEL[tier], isOpener,
    opener: chain[0], responderRaise: chain[last],
    openerPos: sidePos(hand, chain[0].side), responderPos: sidePos(hand, s)
  };
}

/** 画像宽度倍率：1 + (width - 1) × intensity */
export function archetypeWidth(archetype, intensity = 1) {
  const A = ARCHETYPE_PARAMS[archetype] || null;
  if (!A) return 1;
  const k = Number(intensity);
  return 1 + (A.width - 1) * (Number.isFinite(k) ? k : 1);
}

/** 由档位与结构修正算出目标绝对宽度（占全范围 %） */
export function targetWidthPct(info, opts = {}) {
  const bb = Number(opts.bb) || 2;
  const styleWidth = Number(opts.styleWidth) || 1;
  const openRel = (Number(info.opener?.amountBB) || 0) / bb;
  const raiseRel = (Number(info.responderRaise?.amountBB) || 0) / bb;
  const stackBB = Number(opts.stackBB) || 0;
  let base;
  if (info.tier === 2) {
    // 开池档：对手自己开的池 → 范围宽度由其位置决定（BTN 约 42%、CO 约 24%、EP 约 16%）
    base = clamp(OPEN_WIDTH[OPENER_CLASS[info.openerPos]] ?? 20, OPEN_CLAMP[0], OPEN_CLAMP[1]);
  } else if (info.tier === 3) {
    const fo = F_OPENER[OPENER_CLASS[info.openerPos]] ?? 1;
    const fr = F_RESPONDER[RESPONDER_CLASS[info.responderPos]] ?? 1;
    base = clamp(ANCHOR_PCT * fo * fr, W_BASE_CLAMP[0], W_BASE_CLAMP[1]);
  } else {
    const t = TIER_WIDTH[info.tier] || TIER_WIDTH[6];
    const c = TIER_CLAMP[info.tier];
    base = clamp((t[0] + t[1]) / 2, c[0], c[1]);
  }
  const f = stepF(OPEN_SIZE_F, openRel)
    * (info.tier === 2 ? 1 : stepF(RAISE_SIZE_F, raiseRel))
    * stepF(STACK_F, stackBB);
  let pct = base * f * styleWidth;
  if (info.tier === 2) pct = clamp(pct, OPEN_CLAMP[0], OPEN_CLAMP[1]);
  else if (info.tier === 3) pct = clamp(pct, W_FINAL_CLAMP[0], W_FINAL_CLAMP[1]);
  else {
    const c = TIER_CLAMP[info.tier];
    pct = clamp(pct, c[0], c[1]);
  }
  return { pct, basePct: base, f, styleWidth, openRel, raiseRel };
}

/**
 * 为本次求解派生最终对手范围（绝对宽度口径）。
 * 返回 null 表示「无需收窄」（对手不是再加注方 / 无加注）。
 */
export function buildPreflopRangeMatrix(hand, decisionIndex = Infinity, opts = {}) {
  const info = preflopRaiseTier(hand, opts.side || 'villain', decisionIndex);
  if (!info) return null;
  const base = hand?.ranges?.villain || null;
  if (!base) return null;
  const presetCombos = matrixToCombos(base, [], 0.02, TOTAL_COMBOS).length;
  if (!presetCombos) return null;
  const t = targetWidthPct(info, {
    bb: hand?.stakes?.bb, stackBB: opts.stackBB, styleWidth: opts.styleWidth
  });
  const targetCombos = Math.max(1, Math.round(t.pct / 100 * TOTAL_COMBOS));
  const matrix = narrowRangeTop(base, targetCombos / presetCombos);
  return {
    matrix, info, target: t, targetCombos, presetCombos,
    actualCombos: matrixToCombos(matrix, [], 0.02, TOTAL_COMBOS).length
  };
}

/**
 * 为本次求解派生双方范围。仅收窄对手（对手手牌未知，需从行动反推）；
 * Hero 手牌已知，保持其范围原样，确保手牌条件频率可用。
 * 返回 { hero, villain, villainLevel, fraction, note, widthInfo }。
 *
 * opts: { mode, archetype, intensity, stackBB }
 *   mode=exploit 时按画像宽度修正对手范围；GTO 模式不假设对手风格。
 */
export function rangesForDecision(hand, decisionIndex = Infinity, opts = {}) {
  const hero = hand?.ranges?.hero || null;
  const villainBase = hand?.ranges?.villain || null;
  const level = preflopRaiseLevel(hand, 'villain', decisionIndex);
  const mode = String(opts.mode || 'gto').toLowerCase();
  const styleWidth = mode === 'exploit' ? archetypeWidth(opts.archetype, opts.intensity) : 1;
  const built = buildPreflopRangeMatrix(hand, decisionIndex, { side: 'villain', styleWidth, stackBB: opts.stackBB });
  if (!built) {
    return {
      hero, villain: villainBase, villainLevel: level, fraction: 1,
      note: '', widthInfo: null
    };
  }
  const t = built.target;
  const info = built.info;
  const head = info.tier === 2
    ? `对手 ${info.openerPos} 开池（${t.openRel.toFixed(2)}x）`
    : `对手 ${info.tierLabel}（对 ${info.openerPos} ${t.openRel.toFixed(2)}x 开池）`;
  const note = `${head}· 范围收窄至全范围 ${t.pct.toFixed(1)}%`
    + `（GTO 基准 ${t.basePct.toFixed(1)}% × 结构修正 ${t.f.toFixed(2)} × 风格 ×${t.styleWidth.toFixed(2)}）`
    + `· 实际 ${built.actualCombos} 组合 / ${TOTAL_COMBOS}`;
  return {
    hero, villain: built.matrix, villainLevel: level,
    fraction: built.targetCombos / built.presetCombos,
    note, widthInfo: {
      pct: t.pct, basePct: t.basePct, styleWidth: t.styleWidth, f: t.f,
      tier: info.tierLabel, tierCode: info.tier, chainIndex: info.chainIndex,
      openerPos: info.openerPos, responderPos: info.responderPos,
      openRel: t.openRel, raiseRel: t.raiseRel,
      targetCombos: built.targetCombos, actualCombos: built.actualCombos, totalCombos: TOTAL_COMBOS
    }
  };
}
