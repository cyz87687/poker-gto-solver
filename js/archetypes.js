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
 */
export const ARCHETYPE_PARAMS = {
  tag: { width: 0.70, aggression: 0.15, bluff: -0.10, foldToBet: 0.00, foldToRaise: 0.05, raiseThreshold: 0.20 },
  lag: { width: 1.40, aggression: 0.25, bluff: 0.20, foldToBet: -0.15, foldToRaise: -0.10, raiseThreshold: 0.00 },
  tp: { width: 0.75, aggression: -0.20, bluff: -0.15, foldToBet: 0.25, foldToRaise: 0.30, raiseThreshold: 0.50 },
  lp: { width: 1.30, aggression: -0.15, bluff: -0.10, foldToBet: 0.05, foldToRaise: 0.15, raiseThreshold: 0.45 },
  cs: { width: 1.60, aggression: -0.30, bluff: -0.25, foldToBet: -0.30, foldToRaise: -0.25, raiseThreshold: 0.85 }
};
