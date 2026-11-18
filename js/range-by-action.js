/* range-by-action.js —— 按行动历史派生「行动一致范围」（纯逻辑，无 DOM / DB 依赖）
 *
 * 背景：求解器收到的范围默认是位置预设（如 BB 防守约前 70%）。当对手在翻前
 * 连续加注（3bet / 4bet / 5bet）后，其真实范围必然远窄于位置预设。若仍用
 * 全范围求解，弱牌（如 33）会被算出虚高权益，进而在深码下得出「100% 全下」
 * 这类明显失真的建议。
 *
 * 设计：在求解请求构造时派生收窄后的范围，仅用于本次求解；不写回 hand.ranges，
 * 不改动 IndexedDB 已录数据。Hero 手牌已知，其范围保持原样，避免手牌条件频率
 * 因手牌被排除而退化成平均档位。
 */
import { emptyMatrix } from './cards.js';

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
 * 统计某一方在决策点之前的翻前「再加注级别」：
 *   0 = 未加注（limp / 仅跟注）；1 = 开池加注或 3bet；2 = 4bet；3+ = 5bet 及以上。
 * 仅在对手的加注高于当时桌面最高额时计一级，避免把「加注额被反超后被动跟注」误判。
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

/** 收窄比例：级别越高范围越窄；深码再加严一档（深码再加注需要更强牌力） */
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

/**
 * 为本次求解派生双方范围。仅收窄对手（对手手牌未知，需从行动反推）；
 * Hero 手牌已知，保持其范围原样，确保手牌条件频率可用。
 * 返回 { hero, villain, villainLevel, fraction, note }。
 */
export function rangesForDecision(hand, decisionIndex = Infinity) {
  const hero = hand?.ranges?.hero || null;
  const villain = hand?.ranges?.villain || null;
  const level = preflopRaiseLevel(hand, 'villain', decisionIndex);
  const fraction = raiseLevelFraction(level, hand?.stackBB);
  const narrowed = narrowRangeTop(villain, fraction);
  return {
    hero,
    villain: narrowed,
    villainLevel: level,
    fraction,
    note: level > 0
      ? `对手翻前加注级别 ${level}，范围按行动收窄至原范围约 ${Math.round(fraction * 100)}%`
      : ''
  };
}
