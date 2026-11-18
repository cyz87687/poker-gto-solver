/* ui-sizes.js —— 展示层尺度工具（纯函数，无 DOM / 无持久化依赖）
 * 目的：实时预览出结果后，选项档位直接取求解器动作金额，与「为什么推荐」同源同值。
 * 数据保护：只读求解结果，不修改 hand / job / session 任何已录数据。
 */

/**
 * 从求解结果动作列表提取下注 / 加注尺度档。
 * solver result.actions[].sizeBB：RAISE = 加注至（本街总投入），BET = 下注额。
 * @param {Array} acts displayActs(res) 结果（含 type / sizeBB / freq / ev）
 * @param {'RAISE'|'BET'} type 动作类型
 * @param {number} cap 允许的最大金额（RAISE=本街全下总投入，BET=行动者剩余后手）
 * @param {number} min 允许的最小金额（RAISE=最小加注至，BET=0）
 * @returns {Array<{amt:number,label:string}>|null} 无可用求解尺度时返回 null，由调用方回退规则档
 */
export function solverSizeOptions(acts, type, cap, min = 0) {
  if (!Array.isArray(acts) || !acts.length) return null;
  const list = acts.filter(a => a && a.type === type && Number.isFinite(Number(a.sizeBB)) && Number(a.sizeBB) > 0);
  if (!list.length) return null;
  const out = [], seen = new Set();
  for (const a of list) {
    const amt = Math.round(Number(a.sizeBB) * 10) / 10;
    if (!(amt > 0) || amt > Number(cap) + 1e-9 || amt + 1e-9 < Number(min) || seen.has(amt)) continue;
    seen.add(amt);
    out.push({ amt, label: '均衡档' });
  }
  return out.length ? out.sort((x, y) => x.amt - y.amt) : null;
}
