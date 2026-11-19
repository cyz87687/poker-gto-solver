/* archetypes.js —— 对手画像参数（唯一来源）
 *
 * V1.15：solver-core.js 与 range-by-action.js 共用同一份画像参数。
 *   width = 对手范围宽窄倍率（>1 放宽 / <1 收紧），作用在「绝对宽度目标」上。
 *
 * V1.17（本版）：把「翻后弃牌率」与「被跟注范围强度」彻底解耦，并加入跨街逐步收窄：
 *   foldToRaise          翻前面对再加注的弃牌率修正（TAG 弱牌果断弃→高；LAG 翻前宽→低）
 *   postflopFoldToRaise  翻后面对加注的弃牌率修正（TAG 主动开枪=强范围→少弃/负；LAG cbet 空气多→多弃/正）
 *   postflopContinueFrac 翻后面对 Hero 加注的「继续率」= 1 − 翻后弃牌倾向，决定加注能打走多少（foldP）
 *   continueValueFrac    面对加注仍继续的范围 = cbet 价值子集内的 top X（不再是全范围 top），决定被跟注后面对多强的牌（eqCont）
 *   betValueFrac/betBluffFrac  翻后下注范围中价值/诈唬占比（占翻前范围）
 *   streetNarrowPerBet   每多打一条街，继续范围再乘该系数（<1 → 越往后越窄）
 *   streetBluffDecay     每多打一条街，诈唬占比乘该系数（<1 → 诈唬被逐步打掉 → 范围更极化）
 *
 * 物理动机（用户 K4 场景洞察）：TAG 翻前面对 3bet/4bet 弱牌果断弃（弃牌率高），
 * 但翻后主动 cbet 是筛选后的强范围、诈唬少（弃牌率低）；LAG 恰好相反。
 * 连打三条街时，诈唬已被前街打掉、跟注到底只剩强价值 → 价值/诈唬比单调上升（极化）。
 */
export const ARCHETYPE_PARAMS = {
  // 翻前 foldToRaise：TAG +0.08（弱牌果断弃） vs LAG −0.12（翻前宽）
  // 翻后 postflopFoldToRaise：TAG −0.16（强范围少弃） vs LAG +0.22（空气多易弃）
  tag: {
    width: 0.70, aggression: 0.15, bluff: -0.10,
    foldToBet: 0.00, foldToRaise: 0.08, postflopFoldToRaise: -0.16, raiseThreshold: 0.20,
    betValueFrac: 0.55, betBluffFrac: 0.05,
    postflopContinueFrac: 0.82, continueValueFrac: 0.52,
    streetNarrowPerBet: 0.72, streetBluffDecay: 0.50
  },
  lag: {
    width: 1.40, aggression: 0.25, bluff: 0.20,
    foldToBet: -0.15, foldToRaise: -0.12, postflopFoldToRaise: 0.22, raiseThreshold: 0.00,
    betValueFrac: 0.65, betBluffFrac: 0.35,
    postflopContinueFrac: 0.28, continueValueFrac: 0.60,
    streetNarrowPerBet: 0.78, streetBluffDecay: 0.65
  },
  tp: {
    width: 0.75, aggression: -0.20, bluff: -0.15,
    foldToBet: 0.25, foldToRaise: 0.30, postflopFoldToRaise: 0.05, raiseThreshold: 0.50,
    betValueFrac: 0.50, betBluffFrac: 0.10,
    postflopContinueFrac: 0.58, continueValueFrac: 0.58,
    streetNarrowPerBet: 0.80, streetBluffDecay: 0.60
  },
  lp: {
    width: 1.30, aggression: -0.15, bluff: -0.10,
    foldToBet: 0.05, foldToRaise: 0.15, postflopFoldToRaise: -0.05, raiseThreshold: 0.45,
    betValueFrac: 0.60, betBluffFrac: 0.20,
    postflopContinueFrac: 0.66, continueValueFrac: 0.62,
    streetNarrowPerBet: 0.82, streetBluffDecay: 0.68
  },
  cs: {
    width: 1.60, aggression: -0.30, bluff: -0.25,
    foldToBet: -0.30, foldToRaise: -0.25, postflopFoldToRaise: -0.30, raiseThreshold: 0.85,
    betValueFrac: 0.40, betBluffFrac: 0.05,
    postflopContinueFrac: 0.90, continueValueFrac: 0.68,
    streetNarrowPerBet: 0.88, streetBluffDecay: 0.75
  }
};

/* V1.17 GTO 平衡口径：
 * 平衡诈唬比例对齐底池赔率（bet 8.8 / (26.4+8.8) = 25%）→ 价值 75% / 诈唬 25%。
 * continueValueFrac 0.85 ⇒ 全范围继续分位 0.75×0.85≈0.64（对齐 V1.16 的 0.65），
 * 使 GTO 档 eqCont 不因结构改造漂移（NashConv 回归口径稳定）。
 * 跨街系数设 1.0：GTO 平衡诈唬比例本身就是为单街底池赔率设计，不再额外衰减。 */
export const GTO_RANGE_CONDITION = {
  betValueFrac: 0.75, betBluffFrac: 0.25,
  postflopContinueFrac: 0.65, continueValueFrac: 0.85,
  streetNarrowPerBet: 1.0, streetBluffDecay: 1.0,
  callContinueFrac: 0.65 // 兼容别名（旧消费者读翻后继续率）
};

const _clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** 取范围条件化参数：GTO 用固定平衡值；剥削模式取画像参数（受 intensity 调节）。
 *  intensity 只放大「偏离平衡 0.5」的程度，不放大 continueValueFrac（保护被跟注范围物理上限）。 */
export function rangeConditionParams(mode, archetype, intensity = 1) {
  if (String(mode || 'gto').toLowerCase() !== 'exploit') return { ...GTO_RANGE_CONDITION };
  const A = ARCHETYPE_PARAMS[archetype] || ARCHETYPE_PARAMS.tag;
  const k = _clamp(Number(intensity) || 1, 0.5, 1.5);
  const bluff = _clamp(A.betBluffFrac * k, 0, 0.5);
  // 继续率以 0.5 为轴按 k 外推：k>1 更极端，k<1 向平衡收敛。
  const cont = _clamp(0.5 + (A.postflopContinueFrac - 0.5) * k, 0.05, 0.95);
  return {
    betValueFrac: A.betValueFrac,
    betBluffFrac: bluff,
    postflopContinueFrac: cont,
    continueValueFrac: A.continueValueFrac,
    streetNarrowPerBet: A.streetNarrowPerBet,
    streetBluffDecay: A.streetBluffDecay,
    callContinueFrac: cont // 兼容别名（翻后口径）
  };
}

/** 按街选用「面对加注的弃牌率修正」（V1.17 翻前/翻后解耦）。 */
export function foldToRaiseByStreet(archetype, postflop, intensity = 1) {
  const A = ARCHETYPE_PARAMS[archetype] || ARCHETYPE_PARAMS.tag;
  const k = _clamp(Number(intensity) || 1, 0.5, 1.5);
  return (postflop ? A.postflopFoldToRaise : A.foldToRaise) * k;
}

/** 跨街逐步收窄（V1.17）：board 张数 3=翻牌 / 4=转牌 / 5=河牌。
 *  每多打一条街：诈唬占比 × streetBluffDecay（诈唬被前街打掉），
 *  「面对加注继续范围」× streetNarrowPerBet（范围收窄）→ 价值/诈唬比单调上升（极化）。
 *  下注价值范围 betValueFrac 不衰减（强价值本就持续下注），只收紧「继续范围」。
 *  GTO 两系数均为 1.0 → 跨街无额外漂移，平衡口径保持稳定。 */
export function streetAdjustedRangeCondition(rc, boardLen) {
  if (!rc) return rc;
  const steps = boardLen <= 3 ? 0 : _clamp(boardLen - 3, 0, 2); // 翻牌 0 / 转牌 1 / 河牌 2
  const bluffDecay = Math.pow(rc.streetBluffDecay != null ? rc.streetBluffDecay : 1, steps);
  const narrow = Math.pow(rc.streetNarrowPerBet != null ? rc.streetNarrowPerBet : 1, steps);
  const bluff = _clamp(rc.betBluffFrac * bluffDecay, 0, 0.5);
  const cv = _clamp(rc.continueValueFrac * narrow, 0.15, 0.95);
  // 被跟注范围的全范围分位 = 价值子集 × 价值子集内继续比例（两者解耦）
  const contTopFrac = _clamp(rc.betValueFrac * cv, 0.05, 0.95);
  return {
    ...rc,
    boardLen,
    streetSteps: steps,
    betBluffFrac: bluff,
    continueValueFrac: cv,
    contTopFrac,
    polarization: rc.betValueFrac / Math.max(0.02, bluff) // 价值/诈唬比，跨街单调上升
  };
}
