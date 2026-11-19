/* archetypes.js —— 对手画像参数（唯一来源）
 *
 * V1.15：solver-core.js 与 range-by-action.js 共用同一份画像参数。
 * 原因：范围派生层要用「风格倍率」修正对手绝对宽度（lag 放宽、tag 收紧），
 * 若两边各留一份常量，一旦调整画像参数就会出现两套口径不一致。
 *
 * width = 对手范围宽窄倍率：
 *   >1 放宽（松型对手范围更宽）、<1 收紧（紧型对手范围更窄）。
 *   V1.15 起该倍率作用在「绝对宽度目标」上（见 range-by-action.js），
 *   而不再作用在已收窄的矩阵上。
 *
 * V1.16 新增三个「范围条件化」字段（用于区分 call 面对的下注范围与 raise 被跟注范围）：
 *   betValueFrac     = 下注范围中价值牌占比（按翻后权益从高到低取）
 *   betBluffFrac     = 下注范围中诈唬牌占比（按翻后权益从低到高取）
 *   callContinueFrac = 面对我方加注时对手继续（跟注/再加注）的范围占比
 * 三者均为占「对手翻前范围」的比例，且 betValueFrac + betBluffFrac 可 < 1（其余 check）。
 */
export const ARCHETYPE_PARAMS = {
  tag: { width: 0.70, aggression: 0.15, bluff: -0.10, foldToBet: 0.00, foldToRaise: 0.05, raiseThreshold: 0.20, betValueFrac: 0.55, betBluffFrac: 0.05, callContinueFrac: 0.45 },
  lag: { width: 1.40, aggression: 0.25, bluff: 0.20, foldToBet: -0.15, foldToRaise: -0.10, raiseThreshold: 0.00, betValueFrac: 0.65, betBluffFrac: 0.35, callContinueFrac: 0.45 },
  tp:  { width: 0.75, aggression: -0.20, bluff: -0.15, foldToBet: 0.25, foldToRaise: 0.30, raiseThreshold: 0.50, betValueFrac: 0.50, betBluffFrac: 0.10, callContinueFrac: 0.40 },
  lp:  { width: 1.30, aggression: -0.15, bluff: -0.10, foldToBet: 0.05, foldToRaise: 0.15, raiseThreshold: 0.45, betValueFrac: 0.60, betBluffFrac: 0.20, callContinueFrac: 0.70 },
  cs:  { width: 1.60, aggression: -0.30, bluff: -0.25, foldToBet: -0.30, foldToRaise: -0.25, raiseThreshold: 0.85, betValueFrac: 0.40, betBluffFrac: 0.05, callContinueFrac: 0.88 }
};

/* V1.16 GTO 默认范围条件化参数（mode === 'gto' 时使用）。
 * 平衡诈唬比例对齐底池赔率：bet 8.8 / (pot 26.4 + bet 8.8) = 25%，
 * 故诈唬占下注范围 25%、价值 75%；面对加注的跟注范围取 65%。 */
export const GTO_RANGE_CONDITION = { betValueFrac: 0.75, betBluffFrac: 0.25, callContinueFrac: 0.65 };

/** 取范围条件化参数：GTO 用固定平衡值；剥削模式用画像参数（受 intensity 强度调节）。
 *  intensity 只放大诈唬占比与跟注意愿，不放大价值牌（保持物理上限）。 */
export function rangeConditionParams(mode, archetype, intensity = 1) {
  if (String(mode || 'gto').toLowerCase() !== 'exploit') return { ...GTO_RANGE_CONDITION };
  const A = ARCHETYPE_PARAMS[archetype] || ARCHETYPE_PARAMS.tag;
  const k = Math.max(0.5, Math.min(1.5, Number(intensity) || 1));
  return {
    betValueFrac: A.betValueFrac,
    betBluffFrac: Math.min(0.5, A.betBluffFrac * k),
    callContinueFrac: Math.min(0.95, A.callContinueFrac * k)
  };
}
