/* hand.js —— HH v1 牌谱解析、行动流状态机校验、决策点推导、序列化
 * 纯逻辑模块，无 DOM 依赖。
 */
import { parseCard, parseCardList, cardStr, presetMatrix, emptyMatrix, handClassOfCards } from './cards.js';

export const STREETS = ['PREFLOP', 'FLOP', 'TURN', 'RIVER'];
export const POS6 = ['UTG', 'MP', 'CO', 'BTN', 'SB', 'BB'];
export const POS9 = ['UTG', 'UTG+1', 'UTG+2', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'];
export const ACTION_TYPES = ['FOLD', 'CHECK', 'CALL', 'BET', 'RAISE_TO', 'ALLIN'];
export const BUILTIN_TAGS = ['河杀', '经典诈唬', '大底池', '待复习'];
export const ARCHETYPES = [
  { id: 'tag', name: '紧凶', tag: 'TAG' },
  { id: 'lag', name: '松凶', tag: 'LAG' },
  { id: 'tp', name: '紧弱', tag: 'TP' },
  { id: 'lp', name: '松弱', tag: 'LP' },
  { id: 'cs', name: '跟注站', tag: 'CS' }
];
export function positionsFor(size) { return Number(size) === 9 ? POS9 : POS6; }
export function makeId(prefix = 'id') {
  return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}
export function defaultHand() {
  return {
    id: makeId('hand'), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    sessionId: null, game: 'NLHE', stakes: { sb: 1, bb: 2 }, tableSize: 6,
    positions: { hero: 'BTN', villain: 'BB' },
    heroCards: [], villainCards: [], board: [], deadCards: [],
    actions: [], result: null, stackBB: 100, potBB: null,
    ranges: { hero: presetMatrix('btn'), villain: presetMatrix('bb') },
    rangePresets: { hero: 'btn', villain: 'bb' },
    sizes: [0.33, 0.67, 1], allowCheckRaise: true, preset: 'fast',
    mode: 'gto', archetype: 'tag', intensity: 1,
    tags: [], favorite: false, note: '', solvedJobId: null
  };
}
export function formatAction(a) {
  const noun = { FOLD: '弃牌', CHECK: '过牌', CALL: '跟注', BET: '下注', RAISE_TO: '加注至', ALLIN: '全下' }[a.type] || a.type;
  const amt = a.amountBB != null ? ` ${Number(a.amountBB).toFixed(1)} BB` : '';
  return `${a.actor} ${noun}${amt}`;
}
export function actorSide(hand, actor) {
  const u = String(actor || '').toUpperCase();
  if (u === 'HERO' || u === String(hand.positions.hero).toUpperCase()) return 'hero';
  if (u === 'VILLAIN' || u === String(hand.positions.villain).toUpperCase()) return 'villain';
  return 'other';
}
/** 翻后行动顺序（自 OOP 到 IP）：SB → BB → UTG → … → BTN */
export function postflopOrder(size) {
  const pos = positionsFor(size);
  return ['SB', 'BB', ...pos.filter(p => p !== 'SB' && p !== 'BB')];
}
/** 翻后首位行动者（位置名）：两人中更靠 OOP 的一方先动 */
export function firstToActPostflop(hand) {
  const order = postflopOrder(hand.tableSize);
  const ih = order.indexOf(String(hand.positions.hero).toUpperCase());
  const iv = order.indexOf(String(hand.positions.villain).toUpperCase());
  if (ih < 0 || iv < 0) return hand.positions.villain;
  return ih < iv ? hand.positions.hero : hand.positions.villain;
}
/** Hero 是否处于不利位置（OOP） */
export function heroIsOOP(hand) {
  const order = postflopOrder(hand.tableSize);
  const ih = order.indexOf(String(hand.positions.hero).toUpperCase());
  const iv = order.indexOf(String(hand.positions.villain).toUpperCase());
  if (ih < 0 || iv < 0) return true;
  return ih < iv;
}
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

/** HH v1 解析：返回 { hand, errors:[{line,msg}], warnings:[...] } */
/**
 * 从行动流推断对手位置。
 * HH v1 没有 Villain 位置字段，defaultHand 默认 BB；当 Hero 就是 BB 时会与 Hero 冲突，
 * 导致对手的加注/下注被判为第三方、solveAllowed=false。这里按「非 Hero 的实质行动者」推断。
 */
function inferVillainPosition(hand, explicit) {
  const hero = String(hand.positions.hero || '').toUpperCase();
  const pos = positionsFor(hand.tableSize).map(p => String(p).toUpperCase());
  if (explicit && pos.includes(explicit) && explicit !== hero) return explicit;
  const tally = skipFold => {
    const m = new Map();
    for (const a of hand.actions || []) {
      const u = String(a.actor || '').toUpperCase();
      if (u === 'HERO' || u === hero || !pos.includes(u)) continue;
      if (skipFold && a.type === 'FOLD') continue;
      m.set(u, (m.get(u) || 0) + 1);
    }
    return m;
  };
  for (const skipFold of [true, false]) {
    const counts = tally(skipFold);
    if (!counts.size) continue;
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || pos.indexOf(a[0]) - pos.indexOf(b[0]))[0][0];
    if (best !== hero) return best;
  }
  return pos.find(p => p !== hero) || hand.positions.villain;
}
export function parseHH(text) {
  const lines = String(text || '').split(/\r?\n/);
  const hand = defaultHand();
  const errors = [], warnings = [];
  const potOverrides = {};
  let explicitVillain = null;
  let boardAcc = [], streetSeen = -1, hasStreet = false;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li].trim();
    const ln = li + 1;
    if (!line || line.startsWith('#')) continue;
    let m;
    if (/^Game:/i.test(line)) {
      if (!/NLHE/i.test(line)) errors.push({ line: ln, msg: 'V1.0 仅支持 NLHE' });
      continue;
    }
    if (/^Stakes:/i.test(line)) {
      m = line.match(/SB\s*=\s*([\d.]+)\s+BB\s*=\s*([\d.]+)/i);
      if (!m) errors.push({ line: ln, msg: 'Stakes 格式应为 SB=1 BB=2' });
      else hand.stakes = { sb: num(m[1]), bb: num(m[2]) };
      continue;
    }
    if (/^Table:/i.test(line)) {
      m = line.match(/(\d+)\s*max/i);
      if (!m) errors.push({ line: ln, msg: 'Table 格式应为 6max / 9max' });
      else hand.tableSize = Number(m[1]) === 9 ? 9 : 6;
      continue;
    }
    if (/^Hero:/i.test(line)) {
      m = line.match(/^Hero:\s*(\S+)\s*\[([^\]]*)\]/i);
      if (!m) errors.push({ line: ln, msg: 'Hero 格式应为 Hero: BTN [AsKd]' });
      else {
        hand.positions.hero = m[1].toUpperCase();
        try { hand.heroCards = parseCardList(m[2]); }
        catch (e) { errors.push({ line: ln, msg: e.message }); }
      }
      continue;
    }
    if (/^Villain:/i.test(line)) {
      m = line.match(/\[([^\]]*)\]/);
      // 支持显式位置：Villain: BTN [QhQd]；缺省仅 [QhQd] 时按行动流推断
      const pm = line.match(/^Villain:\s*([A-Za-z+]+)\s*\[/);
      if (pm) explicitVillain = pm[1].toUpperCase();
      if (!m) errors.push({ line: ln, msg: 'Villain 格式应为 Villain: [QhQd] 或 Villain: BTN [QhQd]' });
      else { try { hand.villainCards = parseCardList(m[1]); } catch (e) { errors.push({ line: ln, msg: e.message }); } }
      continue;
    }
    if (/^Stacks:/i.test(line)) {
      m = line.match(/Hero\s*=\s*([\d.]+)/i);
      if (m) hand.stackBB = num(m[1]);
      continue;
    }
    if (/^Dead:/i.test(line)) { try { hand.deadCards = parseCardList(line.slice(5)); } catch (e) { errors.push({ line: ln, msg: e.message }); } continue; }
    if (/^Tags:/i.test(line)) { hand.tags = line.slice(5).split(/[,，]/).map(s => s.trim()).filter(Boolean); continue; }
    if (/^Note:/i.test(line)) { hand.note = line.slice(5).trim(); continue; }
    if (/^Result:/i.test(line)) {
      const r = line.toLowerCase();
      hand.result = /split|平分/.test(r) ? 'split' : /villain|对方|lose|lost/.test(r) ? 'villain' : 'hero';
      continue;
    }
    m = line.match(/^(Preflop|Flop|Turn|River)\s*:/i);
    if (m) {
      hasStreet = true;
      const st = m[1].toUpperCase();
      const si = STREETS.indexOf(st);
      if (si < streetSeen) errors.push({ line: ln, msg: `街序错误：${st} 出现在上一街之前` });
      streetSeen = Math.max(streetSeen, si);
      let rest = line.slice(m[0].length).trim();
      const bm = rest.match(/\[([^\]]*)\]/);
      if (bm) {
        let cards;
        try { cards = parseCardList(bm[1]); }
        catch (e) { errors.push({ line: ln, msg: e.message }); cards = []; }
        const need = st === 'FLOP' ? 3 : st === 'TURN' ? 4 : st === 'RIVER' ? 5 : 0;
        if (st === 'FLOP') boardAcc = cards.slice(0, 3);
        else if (need) {
          if (cards.length >= need) boardAcc = cards.slice(0, need);
          else boardAcc = [...boardAcc, ...cards].slice(0, need);
        }
        rest = rest.replace(bm[0], '').trim();
      }
      const pm = rest.match(/Pot\s*=\s*([\d.]+)/i);
      if (pm) { potOverrides[st] = num(pm[1]); rest = rest.replace(pm[0], '').trim(); }
        const expect = st === 'FLOP' ? 3 : st === 'TURN' ? 4 : st === 'RIVER' ? 5 : 0;
        if (new Set(boardAcc).size !== boardAcc.length) errors.push({ line: ln, msg: `${st} 公共牌内部重复` });
        if (expect && boardAcc.length !== expect) errors.push({ line: ln, msg: `${st} 公共牌应为 ${expect} 张，实际 ${boardAcc.length} 张` });
      rest = rest.replace(/^[,\s]+/, '');
      const tokens = rest ? rest.split(/[,，]/).map(s => s.trim()).filter(Boolean) : [];
      for (const tok of tokens) {
        const p = tok.split(/\s+/);
        const actor = (p[0] || '').toUpperCase();
        const verb = (p[1] || '').toLowerCase();
        const rawAmt = p[2];
        const map = { fold: 'FOLD', check: 'CHECK', call: 'CALL', bet: 'BET', raise: 'RAISE_TO', raiseto: 'RAISE_TO', '3bet': 'RAISE_TO', '4bet': 'RAISE_TO', allin: 'ALLIN' };
        if (!actor || !map[verb]) { errors.push({ line: ln, msg: `无法识别的动作「${tok}」` }); continue; }
        const a = { street: st, actor, type: map[verb], amountBB: null };
        if (rawAmt) {
          if (/%$/.test(rawAmt)) {
            const pct = num(rawAmt.slice(0, -1));
            const pot = potOverrides[st];
            if (pct == null || pot == null) errors.push({ line: ln, msg: `百分比下注「${rawAmt}」需在该行提供 Pot=` });
            else a.amountBB = Math.round(pot * pct / 100 * 10) / 10;
          } else {
            const v = num(rawAmt);
            if (v == null) errors.push({ line: ln, msg: `下注量「${rawAmt}」不是数值` });
            else a.amountBB = Math.round(v * 10) / 10;
          }
        }
        hand.actions.push(a);
      }
      continue;
    }
    errors.push({ line: ln, msg: `未知标记「${line.slice(0, 24)}」` });
  }
  if (!hasStreet) errors.push({ line: 1, msg: '未找到任何街（Preflop/Flop/Turn/River）' });
  hand.board = boardAcc;
  hand.potBB = null;
  if (hand.heroCards.length !== 2) errors.push({ line: 1, msg: 'Hero 必须恰好 2 张手牌' });
  const boardN = (hand.board || []).length;
  if (boardN === 1 || boardN === 2) warnings.push('公共牌需为 0 张（翻前）或 3–5 张（翻后）；当前仅 1–2 张，不输出求解结果（仅可归档）');
  const all = [...hand.heroCards, ...hand.board, ...hand.villainCards, ...hand.deadCards];
  if (new Set(all).size !== all.length) errors.push({ line: 1, msg: '牌面重复（手牌/公共牌/对手手牌/死牌冲突）' });
  // 百分比下注与 Pot 覆盖值落在 hand 上，供 deriveState 使用
  hand.potOverrides = potOverrides;
  // HH v1 缺省 Villain 位置时按行动流推断，避免 Hero=BB 时两家位置冲突导致对手行动被判第三方
  hand.positions.villain = inferVillainPosition(hand, explicitVillain);
  // 位置变化后同步默认范围模板（Hero=BB → BB 防守，对手按开池理解）
  const posPreset = p => ({ BB: 'bb', SB: 'bb', BTN: 'btn' })[p] || 'btn';
  hand.rangePresets.hero = posPreset(hand.positions.hero);
  hand.ranges.hero = presetMatrix(hand.rangePresets.hero);
  hand.rangePresets.villain = posPreset(hand.positions.villain);
  hand.ranges.villain = presetMatrix(hand.rangePresets.villain);
  return { hand, errors, warnings };
}

/** 行动流状态机校验（附录 A）。返回 {ok, errors, warnings, solveAllowed, potTrace} */
export function validateHand(hand) {
  const errors = [], warnings = [], potTrace = [];
  const boardN = (hand.board || []).length;
  const positions = positionsFor(hand.tableSize).map(p => p.toUpperCase());
  const known = new Set([...positions, 'HERO', 'VILLAIN']);
  const cards = [...(hand.heroCards || []), ...(hand.board || []), ...(hand.villainCards || []), ...(hand.deadCards || [])];
  if (new Set(cards).size !== cards.length) errors.push({ path: 'cards', msg: '牌面重复：手牌/公共牌/对手手牌/死牌存在同一张牌' });
  if ((hand.heroCards || []).length !== 2) errors.push({ path: 'heroCards', msg: 'Hero 手牌必须 2 张' });
  if ((hand.villainCards || []).length && hand.villainCards.length !== 2) errors.push({ path: 'villainCards', msg: 'Villain 手牌必须 0 或 2 张' });
  if ((hand.board || []).length > 5) errors.push({ path: 'board', msg: '公共牌最多 5 张' });
  if (boardN === 1 || boardN === 2) warnings.push('公共牌需为 0 张（翻前）或 3–5 张（翻后）；当前仅 1–2 张，不输出求解结果（仅可归档）');
  const stack = num(hand.stackBB) || 0;
  const sb = num(hand.stakes?.sb) || 1, bb = num(hand.stakes?.bb) || 2;
  const blindsBB = (sb / bb) + 1;
  const heroPosU = String(hand.positions?.hero || '').toUpperCase();
  const villainPosU = String(hand.positions?.villain || '').toUpperCase();
  const posClash = !!heroPosU && heroPosU === villainPosU;
  if (posClash) {
    errors.push({ path: 'positions', msg: `Hero 与对手位置相同（都是 ${heroPosU}），行动流无法区分两家；请在第 1 步改成两个不同的位置` });
  }
  /** 行动者归一：HERO / VILLAIN 别名映射到实际座位名，避免同一人被当成两个投入账户 */
  const normActor = raw => {
    const u = String(raw || '').toUpperCase();
    return u === 'HERO' ? heroPosU : u === 'VILLAIN' ? villainPosU : u;
  };

  let pot = blindsBB;
  const invest = new Map(); // 行动者(归一后) -> 本街累计投入
  let toCall = 1; // 大盲 1BB 视作待跟注额（翻前）
  let lastRaise = 1;
  let streetSeen = -1;
  let allInSides = new Set();
  let postActors = new Set();
  // 行动线合法性（附录 A）：下注轮收口追踪 —— 换街时下注必须已被回应，收口后不得再录入行动
  const participants = new Set([heroPosU, villainPosU].filter(Boolean));
  for (const a of hand.actions || []) participants.add(normActor(a.actor)); // 预扫描：后续才行动的玩家也算本手参与者
  const foldedSet = new Set();
  const allInSet = new Set();
  let actedSet = new Set();
  let roundClosed = false;
  let streetActionCount = 0;
  (hand.actions || []).forEach((a, idx) => {
    const path = `actions[${idx}]`;
    const st = String(a.street || '').toUpperCase();
    const si = STREETS.indexOf(st);
    if (si < 0) { errors.push({ path, msg: '未知街：' + st }); return; }
    if (si < streetSeen) { errors.push({ path, msg: '街序回退' }); return; }
    if (si > streetSeen) {
      if (streetSeen >= 0 && streetActionCount > 0 && !roundClosed) {
        errors.push({
          path,
          msg: `「${STREETS[streetSeen]}」街行动未结束${toCall > 1e-6 ? `：下注 ${toCall.toFixed(1)} BB 未被回应（缺少跟注 / 加注 / 弃牌）` : '：仍有玩家未行动'}就进入了「${st}」`
        });
      }
      streetSeen = si; invest.clear(); toCall = si === 0 ? 1 : 0; lastRaise = 1; allInSides.clear();
      actedSet = new Set(); roundClosed = false; streetActionCount = 0;
    }
    const actor = normActor(a.actor);
    if (si > 0) postActors.add(actor);
    if (roundClosed) {
      const liveP = [...participants].filter(p => !foldedSet.has(p));
      const isWalk = liveP.length <= 1 && (a.type === 'CHECK' || a.type === 'FOLD');
      if (isWalk) {
        warnings.push(`第 ${idx + 1} 条：弃牌收尾后的${a.type === 'CHECK' ? '过牌' : '弃牌'}按 walk 归档`);
        potTrace.push({ idx, street: st, pot: Math.round(pot * 10) / 10, toCall, highest: Math.round(Math.max(0, ...invest.values()) * 10) / 10, lastRaise });
      } else {
        errors.push({ path, msg: `下注轮已结束后又录入了行动（${a.actor} ${a.type}）；请删除或改写该行动` });
      }
      return;
    }
    if (!known.has(String(a.actor || '').toUpperCase())) errors.push({ path, msg: `未知行动者「${a.actor}」` });
    if (!ACTION_TYPES.includes(a.type)) { errors.push({ path, msg: `未知动作「${a.type}」` }); return; }
    if (foldedSet.has(actor)) errors.push({ path, msg: `${a.actor} 已弃牌，不能再行动` });
    const cur = invest.get(actor) || 0;
    const amt = a.amountBB == null ? null : Number(a.amountBB);
    if (amt != null && (!Number.isFinite(amt) || amt < 0)) errors.push({ path, msg: '下注量必须为非负数值' });
    const maxInvest = stack;
    switch (a.type) {
      case 'CHECK':
        if (toCall > 0) errors.push({ path, msg: '有待跟注额时不能过牌' });
        break;
      case 'FOLD':
        if (toCall <= 0) warnings.push(`第 ${idx + 1} 条：无待跟注额却弃牌（已按合法归档处理）`);
        break;
      case 'CALL': {
        const pay = amt != null ? amt : toCall;
        if (toCall <= 0) errors.push({ path, msg: '无待跟注额时不能跟注' });
        if (amt != null && Math.abs(amt - toCall) > 0.6) warnings.push(`第 ${idx + 1} 条：跟注额 ${amt} 与待跟注额 ${toCall.toFixed(1)} 不一致`);
        pot += pay; invest.set(actor, cur + pay); toCall = 0;
        break;
      }
      case 'BET': {
        if (toCall > 0) errors.push({ path, msg: '有待跟注额时应使用 RAISE_TO，不能 BET' });
        if (amt == null) errors.push({ path, msg: 'BET 缺少下注量' });
        else if (amt < 1 - 1e-6) errors.push({ path, msg: `下注 ${amt} BB 低于最小下注 1 BB` });
        else { pot += amt; invest.set(actor, cur + amt); toCall = amt; lastRaise = amt; }
        break;
      }
      case 'RAISE_TO': {
        const highest = Math.max(0, ...invest.values());
        const minTo = highest + lastRaise;
        if (toCall <= 0) errors.push({ path, msg: '无待跟注额时不能加注' });
        if (amt == null) errors.push({ path, msg: 'RAISE_TO 缺少目标额' });
        else if (amt + 1e-6 < minTo) errors.push({ path, msg: `加注至 ${amt} BB 低于最小加注额 ${minTo.toFixed(1)} BB` });
        else { const inc = Math.max(0, amt - cur); pot += inc; invest.set(actor, amt); toCall = Math.max(0, amt - highest); lastRaise = toCall; }
        break;
      }
      case 'ALLIN': {
        const target = amt != null ? amt : Math.max(cur + toCall, maxInvest);
        if (target > maxInvest + 1e-6) errors.push({ path, msg: `全下 ${target} BB 超过有效后手 ${maxInvest} BB` });
        const inc = Math.max(0, target - cur);
        pot += inc; invest.set(actor, target); toCall = Math.max(0, target - Math.max(0, ...[...invest.entries()].filter(([k]) => k !== actor).map(([, v]) => v)));
        lastRaise = toCall; allInSides.add(actorSide(hand, actor));
        break;
      }
    }
    for (const [k, v] of invest) if (v > maxInvest + 1e-6) errors.push({ path, msg: `${k} 累计投入 ${v.toFixed(1)} BB 超过有效后手 ${maxInvest} BB` });
    // 下注轮收口判定：弃牌收尾 / 未出局者全部全下 / 全员已行动且无待跟注
    participants.add(actor);
    if (a.type === 'FOLD') foldedSet.add(actor);
    if (a.type === 'ALLIN') allInSet.add(actor);
    actedSet.add(actor);
    streetActionCount++;
    const liveP = [...participants].filter(p => !foldedSet.has(p));
    const notAllIn = liveP.filter(p => !allInSet.has(p));
    if (liveP.length <= 1 || notAllIn.length === 0 || (toCall <= 1e-6 && liveP.every(p => actedSet.has(p)))) roundClosed = true;
    if (allInSides.size >= 2) warnings.push('双方已全下：后续行动按 runout 自动补牌处理，不再产生新行动');
    potTrace.push({ idx, street: st, pot: Math.round(pot * 10) / 10, toCall, highest: Math.round(Math.max(0, ...invest.values()) * 10) / 10, lastRaise });
  });
  if (hand.potBB != null) {
    const v = Number(hand.potBB);
    if (!Number.isFinite(v) || v < 0) errors.push({ path: 'potBB', msg: '当前底池必须为非负数值' });
    else if (Math.abs(v - pot) > Math.max(2, pot * 0.3)) warnings.push(`录入底池 ${v} BB 与行动流推算 ${pot.toFixed(1)} BB 差异较大，求解将以录入值为准`);
  }
  const others = [...postActors].filter(p => p !== heroPosU && p !== villainPosU && p !== 'HERO' && p !== 'VILLAIN');
  const solveAllowed = (boardN === 0 || boardN >= 3) && others.length === 0 && !posClash;
  if (!solveAllowed && boardN >= 3) warnings.push('V1.0 仅输出单挑底池求解结果（多人底池可录入归档，但求解不可用）');
  // 当前下注局面，供录入界面生成默认金额 / 按钮可用态（与状态机同一套变量）
  const live = {
    pot: Math.round(pot * 10) / 10,
    toCall: Math.round(toCall * 10) / 10,
    lastRaise: Math.round(lastRaise * 10) / 10,
    highest: Math.round(Math.max(0, ...invest.values()) * 10) / 10,
    street: streetSeen >= 0 ? STREETS[streetSeen] : 'PREFLOP',
    invest: Object.fromEntries(invest)
  };
  return { ok: errors.length === 0, errors, warnings, solveAllowed, potTrace, computedPotBB: Math.round(pot * 10) / 10, live, otherActors: others };
}

/**
 * 行动流推导（V1.4）：当前街由谁行动、待跟注额、本街是否已结束。
 * 规则：
 *  - 翻前除 Hero / 对手外的位置一律视为「默认弃牌」，不参与行动顺位；
 *  - 翻后仅 Hero 与对手两家交替（首位由位置决定，OOP 先动）；
 *  - 本街结束 = 有人弃牌 / 最后一次下注被跟注 / 双方都过牌 / 双方全下。
 * 返回 { actor, closed, handOver, closedReason, pot, toCall, highest, lastRaise, live, facing, first, v }。
 */
export function actionFlow(hand, street) {
  const st = String(street || 'PREFLOP').toUpperCase();
  const si = STREETS.indexOf(st);
  const v = validateHand(hand);
  const traces = v.potTrace || [];
  const onStreet = traces.filter(t => t.street === st);
  const prev = traces.filter(t => STREETS.indexOf(t.street) < si);
  const sb = num(hand.stakes?.sb) || 1, bb = num(hand.stakes?.bb) || 2;
  const blinds = sb / bb + 1;
  const basePot = prev.length ? prev[prev.length - 1].pot : blinds;
  const last = onStreet[onStreet.length - 1];
  const pot = last ? last.pot : Math.round(basePot * 10) / 10;
  const toCall = last ? last.toCall : (si === 0 ? 1 : 0);
  const highest = last ? last.highest : (si === 0 ? 1 : 0);
  const lastRaise = last ? last.lastRaise : 1;

  const hero = String(hand.positions?.hero || 'BTN').toUpperCase();
  let villain = String(hand.positions?.villain || 'BB').toUpperCase();
  // 位置冲突（如 Hero 改成 BB 后对手仍是 BB）：从行动流推断真实对手，
  // 否则对手的加注/下注会被当成第三方忽略，出现「己方下注后本街直接结束、没有跟注选项」的错误状态
  if (villain === hero) villain = inferVillainPosition(hand, null);
  const norm = raw => {
    const u = String(raw || '').toUpperCase();
    return u === 'HERO' ? hero : u === 'VILLAIN' ? villain : u;
  };
  const sideOf = raw => {
    const u = norm(raw);
    return u === hero ? 'HERO' : u === villain ? 'VILLAIN' : u;
  };
  const allActs = hand.actions || [];
  // 参与者 = Hero / 对手 + 所有出现过的行动者；弃牌后从 live 剔除（其余位置的弃牌仅记录出局）
  const participants = new Set([hero, villain].filter(Boolean));
  for (const a of allActs) participants.add(norm(a.actor));
  const order = (si === 0 ? positionsFor(hand.tableSize) : postflopOrder(hand.tableSize)).map(p => String(p).toUpperCase());
  const rank = p => { const i = order.indexOf(String(p).toUpperCase()); return i < 0 ? 99 : i; };
  const live = [...participants].sort((a, b) => rank(a) - rank(b));

  const acts = allActs.filter(a => String(a.street || '').toUpperCase() === st);
  const folded = new Set(), acted = new Set(), responded = new Set();
  let lastAgg = null, handOver = false;
  // 之前街已弃牌的玩家持续出局
  for (const a of allActs) {
    if (STREETS.indexOf(String(a.street || '').toUpperCase()) >= si) break;
    if (a.type === 'FOLD') folded.add(sideOf(a.actor));
  }
  for (const a of acts) {
    const k = sideOf(a.actor);
    acted.add(k);
    if (a.type === 'FOLD') { folded.add(k); responded.add(k); continue; }
    if (a.type === 'BET' || a.type === 'RAISE_TO' || a.type === 'ALLIN') { lastAgg = k; responded.clear(); }
    else if (lastAgg === null) acted.add(k);
    else if (k !== lastAgg) responded.add(k);
  }
  const liveP = live.filter(p => !folded.has(sideOf(p)));
  if (liveP.length < 2) handOver = true;
  let closed = false, closedReason = '';
  if (handOver) { closed = true; closedReason = '本手已有一方弃牌'; }
  else if (lastAgg) {
    closed = liveP.every(p => sideOf(p) === lastAgg || responded.has(sideOf(p)));
    if (closed) closedReason = '下注已被跟注，本街行动结束';
  } else {
    closed = liveP.every(p => acted.has(sideOf(p)));
    if (closed) closedReason = '双方均已行动，本街结束';
  }
  const allInActors = new Set(allActs.filter(a => a.type === 'ALLIN').map(a => sideOf(a.actor)));
  if (!handOver && liveP.length >= 2 && liveP.every(p => allInActors.has(p))) {
    closed = true; closedReason = '双方全下，后续自动发牌';
  }
  const first = liveP[0] || live[0] || hero;
  let actor = null;
  if (!closed) {
    // 顺位：从上一位行动者按座位顺序轮到下一位未弃牌玩家
    const lastLive = [...acts].reverse().find(a => a.type !== 'FOLD') || acts[acts.length - 1];
    if (lastLive) {
      const lastSide = sideOf(lastLive.actor);
      const start = liveP.findIndex(p => sideOf(p) === lastSide);
      for (let i = 1; i <= liveP.length; i++) {
        const p = liveP[(start + i + liveP.length) % liveP.length];
        if (sideOf(p) !== lastSide) { actor = p; break; }
      }
      if (actor == null) actor = first;
    } else actor = first;
  }
  return {
    street: st, actor, first, closed, handOver, closedReason,
    pot, toCall: Math.max(0, toCall), highest, lastRaise,
    live, folded: [...folded], facing: toCall > 0, v
  };
}

/** 按已录入公共牌数推断当前所处的街阶段 */
export function stageFromBoard(n) {
  return n >= 5 ? 'RIVER' : n >= 4 ? 'TURN' : n >= 3 ? 'FLOP' : 'PREFLOP';
}
/** 各街阶段所需的公共牌张数 */
export function stageBoardCount(stage) {
  return stage === 'FLOP' ? 3 : stage === 'TURN' ? 4 : stage === 'RIVER' ? 5 : 0;
}
/**
 * 解算就绪度：把「为什么还不能解算」拆成可逐条修复的清单。
 * stage 为当前录入阶段（可选，缺省按公共牌数推断）。
 * 返回 { ready, items:[{key,ok,label,hint,step}], phase, stage }。
 */
export function solveReadiness(hand, stage = null) {
  const v = validateHand(hand);
  const items = [];
  const push = (key, ok, label, hint, step) => items.push({ key, ok: !!ok, label, hint: ok ? '' : (hint || ''), step });
  const heroN = (hand.heroCards || []).length;
  const boardN = (hand.board || []).length;
  const villainN = (hand.villainCards || []).length;
  const stack = Number(hand.stackBB) || 0;
  const target = stage || stageFromBoard(boardN);
  const need = stageBoardCount(target);
  const preflop = target === 'PREFLOP';

  push('heroCards', heroN === 2, 'Hero 手牌 2 张', heroN === 0 ? '尚未选择' : `当前 ${heroN} 张`, 1);
  push('board', boardN >= need,
    preflop ? '翻前场景 · 无需公共牌' : `公共牌 ≥ ${need} 张（${STREETS.indexOf(target) > 0 ? { FLOP: '翻牌', TURN: '转牌', RIVER: '河牌' }[target] : '翻后'}）`,
    boardN === 0 ? '尚未选择' : `当前 ${boardN} 张，需 ${need} 张`, 2);
  push('villainCards', villainN === 0 || villainN === 2, '对手手牌为空或 2 张', `当前 ${villainN} 张`, 1);
  push('unique', !v.errors.some(e => e.path === 'cards'), '牌面无重复', '手牌 / 公共牌 / 死牌中存在同一张牌', 1);
  const heroU = String(hand.positions?.hero || '').toUpperCase();
  const villainU = String(hand.positions?.villain || '').toUpperCase();
  push('positions', heroU !== villainU, 'Hero 与对手位置不同',
    heroU === villainU ? `两家都设成了 ${heroU || '空'}，会分不清谁在行动；请在第 1 步分开` : '', 1);
  push('stack', stack > 0, '有效后手 > 0 BB', '筹码深度缺失', 1);
  const actErrs = v.errors.filter(e => String(e.path).startsWith('actions'));
  push('actions', actErrs.length === 0, '行动流通过状态机校验', actErrs[0] ? actErrs[0].msg : '', 2);
  const others = v.otherActors || [];
  push('headsUp', preflop || others.length === 0,
    preflop ? '翻前按单挑范围对抗求解' : '翻后仅 Hero 与对手两家',
    others.length ? `翻后出现第三方位置：${others.join('、')}` : '', 2);

  return {
    ready: items.every(i => i.ok) && v.solveAllowed,
    items, errors: v.errors, warnings: v.warnings, solveAllowed: v.solveAllowed,
    phase: preflop ? 'preflop' : 'postflop', stage: target, boardNeeded: need
  };
}

/** 批量录入：解析简写行动流。每行 `Preflop: UTG fold, BTN raise 5, BB call 5`；金额可省略。 */
export function parseActionText(text, hand) {
  const actions = [], errors = [], warnings = [];
  const known = new Set([...positionsFor(hand?.tableSize || 6).map(p => p.toUpperCase()), 'HERO', 'VILLAIN']);
  const verbs = {
    fold: 'FOLD', f: 'FOLD', 弃牌: 'FOLD', 盖牌: 'FOLD',
    check: 'CHECK', x: 'CHECK', 过牌: 'CHECK', 让牌: 'CHECK',
    call: 'CALL', c: 'CALL', 跟注: 'CALL',
    bet: 'BET', b: 'BET', 下注: 'BET',
    raise: 'RAISE_TO', raiseto: 'RAISE_TO', r: 'RAISE_TO', '3bet': 'RAISE_TO', '4bet': 'RAISE_TO',
    加注: 'RAISE_TO', 加注至: 'RAISE_TO', 再加注: 'RAISE_TO',
    allin: 'ALLIN', all: 'ALLIN', 全下: 'ALLIN', 全推: 'ALLIN'
  };
  let seen = -1;
  String(text || '').split(/\r?\n/).forEach((raw, li) => {
    const line = raw.trim();
    const ln = li + 1;
    if (!line || /^(#|\/\/)/.test(line)) return;
    const m = line.match(/^(Preflop|Flop|Turn|River)\s*[:：]/i);
    if (!m) { errors.push({ line: ln, msg: `无法识别的行「${line.slice(0, 28)}」；每行需以 Preflop:/Flop:/Turn:/River: 开头` }); return; }
    const st = m[1].toUpperCase(), si = STREETS.indexOf(st);
    if (si < seen) errors.push({ line: ln, msg: `街序回退：${st} 不能出现在上一街之后` });
    seen = Math.max(seen, si);
    // 兼容 HH v1 的 [公共牌] 与 Pot= 前缀，批量录入时忽略其内容
    let rest = line.slice(m[0].length).trim().replace(/\[[^\]]*\]/g, '').replace(/Pot\s*=\s*[\d.]+\s*/ig, '').replace(/^[,\s;；]+/, '');
    const tokens = rest ? rest.split(/[,，;；]/).map(s => s.trim()).filter(Boolean) : [];
    for (const tok of tokens) {
      const p = tok.split(/\s+/);
      const actor = (p[0] || '').toUpperCase();
      const type = verbs[(p[1] || '').toLowerCase()];
      if (!actor || !type) { errors.push({ line: ln, msg: `无法识别的动作「${tok}」；格式为「位置 动作 [金额]」` }); continue; }
      if (!known.has(actor)) errors.push({ line: ln, msg: `未知行动者「${actor}」` });
      let amountBB = null;
      if (p[2]) {
        const n = num(p[2]);
        if (n == null || n < 0) errors.push({ line: ln, msg: `下注量「${p[2]}」不是合法数值` });
        else amountBB = Math.round(n * 10) / 10;
      }
      actions.push({ street: st, actor, type, amountBB });
    }
  });
  if (!actions.length && !errors.length) errors.push({ line: 1, msg: '未解析到任何动作' });
  if (actions.some(a => a.type === 'CALL' && a.amountBB == null)) warnings.push('部分跟注未填金额，已按当前待跟注额自动补齐');
  return { actions, errors, warnings };
}

/** 批量录入：重放状态机，为省略金额的动作补齐合法默认值（CALL/BET/RAISE_TO/ALLIN）。 */
export function normalizeActionAmounts(actions, hand) {
  const stack = num(hand?.stackBB) || 100;
  const sb = num(hand?.stakes?.sb) || 1, bb = num(hand?.stakes?.bb) || 2;
  const r1 = x => Math.round(x * 10) / 10;
  let pot = sb / bb + 1, toCall = 1, lastRaise = 1, streetSeen = -1;
  const invest = new Map();
  return (actions || []).map(raw => {
    const a = { ...raw, street: String(raw.street || '').toUpperCase(), actor: String(raw.actor || '').toUpperCase() };
    const si = STREETS.indexOf(a.street);
    if (si > streetSeen) { streetSeen = si; invest.clear(); toCall = si === 0 ? 1 : 0; lastRaise = 1; }
    const cur = invest.get(a.actor) || 0;
    const highest = Math.max(0, ...invest.values());
    if (a.amountBB == null) {
      if (a.type === 'CALL') a.amountBB = r1(toCall);
      else if (a.type === 'BET') a.amountBB = r1(Math.max(1, pot * 0.67));
      else if (a.type === 'RAISE_TO') a.amountBB = r1(Math.max(3, highest + lastRaise, highest + lastRaise * 3));
      else if (a.type === 'ALLIN') a.amountBB = r1(stack);
    }
    const amt = a.amountBB == null ? null : Number(a.amountBB);
    if (a.type === 'CHECK') { /* 无投入变化 */ }
    else if (a.type === 'CALL') { const pay = amt != null ? amt : toCall; pot += pay; invest.set(a.actor, cur + pay); toCall = 0; }
    else if (a.type === 'BET' && amt != null) { pot += amt; invest.set(a.actor, cur + amt); toCall = amt; lastRaise = amt; }
    else if (a.type === 'RAISE_TO' && amt != null) { pot += Math.max(0, amt - cur); invest.set(a.actor, amt); toCall = Math.max(0, amt - highest); lastRaise = toCall; }
    else if (a.type === 'ALLIN' && amt != null) { const target = Math.min(amt, stack); pot += Math.max(0, target - cur); invest.set(a.actor, target); toCall = Math.max(0, target - Math.max(0, ...[...invest.entries()].filter(([k]) => k !== a.actor).map(([, val]) => val))); lastRaise = toCall; }
    return a;
  });
}

/** 推导某个 Hero 决策点之前的局面 */
export function deriveState(hand, decisionIndex) {
  const sb = num(hand.stakes?.sb) || 1, bb = num(hand.stakes?.bb) || 2;
  let pot = (sb / bb) + 1;
  const invest = new Map();
  const totalInvest = { hero: 0, villain: 0, other: 0 };
  let toCall = 1, lastRaise = 1, streetSeen = -1, lastAggSide = null, lastStreet = 'PREFLOP';
  const actions = hand.actions || [];
  const n = Math.max(0, Math.min(decisionIndex, actions.length));
  for (let i = 0; i < n; i++) {
    const a = actions[i];
    const st = String(a.street).toUpperCase();
    const si = STREETS.indexOf(st);
    if (si > streetSeen) { streetSeen = si; invest.clear(); toCall = si === 0 ? 1 : 0; lastRaise = 1; lastAggSide = null; }
    lastStreet = st;
    const side = actorSide(hand, a.actor);
    const actor = String(a.actor).toUpperCase();
    const cur = invest.get(actor) || 0;
    const amt = a.amountBB == null ? null : Number(a.amountBB);
    let pay = 0;
    if (a.type === 'CALL') pay = amt != null ? amt : toCall;
    else if (a.type === 'BET') pay = amt || 0;
    else if (a.type === 'RAISE_TO') pay = amt != null ? Math.max(0, amt - cur) : toCall;
    else if (a.type === 'ALLIN') pay = amt != null ? Math.max(0, amt - cur) : Math.max(0, toCall);
    pot += pay; invest.set(actor, cur + pay); totalInvest[side] += pay;
    if (a.type === 'BET' || a.type === 'RAISE_TO' || a.type === 'ALLIN') {
      const highest = Math.max(0, ...[...invest.entries()].filter(([k]) => k !== actor).map(([, v]) => v));
      toCall = Math.max(0, (cur + pay) - highest);
      lastRaise = Math.max(1, toCall); lastAggSide = side;
    } else if (a.type === 'CALL') toCall = 0;
  }
  const street = STREETS[Math.max(0, streetSeen)];
  const boardLen = street === 'PREFLOP' ? 0 : street === 'FLOP' ? 3 : street === 'TURN' ? 4 : 5;
  const board = (hand.board || []).slice(0, boardLen);
  const stack = Math.max(0, (num(hand.stackBB) || 0) - Math.max(totalInvest.hero, totalInvest.villain));
  const facingBet = street === 'PREFLOP'
    // 翻前大盲 1BB 视作待跟注额：无主动加注方时仍需跟注，不能过牌
    ? (lastAggSide === 'villain' ? Math.max(0, toCall) : lastAggSide === null ? (toCall > 0 ? toCall : 1) : 0)
    : (lastAggSide === 'villain' ? Math.max(0, toCall) : 0);
  const potUse = hand.potBB != null && Number.isFinite(Number(hand.potBB)) ? Number(hand.potBB) : pot;
  const heroOOP = heroIsOOP(hand);
  return {
    street, board, pot: Math.max(0.1, potUse), stack, facingBet,
    heroOOP, oppChecked: !heroOOP && !facingBet,
    decisionIndex: n, lastStreet, totalInvest
  };
}
export function heroDecisionIndices(hand) {
  const out = [];
  // 翻前牌谱（无公共牌）复盘翻前 Hero 动作；翻后牌谱仍以翻后动作作为决策点
  const preflopScene = (hand.board || []).length === 0;
  (hand.actions || []).forEach((a, i) => {
    const si = STREETS.indexOf(String(a.street).toUpperCase());
    const allowed = preflopScene ? si === 0 : si > 0;
    if (actorSide(hand, a.actor) === 'hero' && allowed) out.push(i);
  });
  return out;
}
/**
 * 待应对决策点：牌谱以对手的下注/加注/全下结束、且本街尚未闭合（Hero 还没跟注/弃牌）时，
 * 真实要复盘的是「还没录入的下一步」——即 actions.length 这个虚拟决策点。
 * 例如 Preflop BTN raise, BB call / Flop BB check, BTN bet  ← 应解算 Hero 面对这个 bet。
 * 返回 { index, street, toCall, pot } 或 null。
 */
export function pendingHeroDecision(hand) {
  const acts = hand.actions || [];
  if (!acts.length) return null;
  const last = acts[acts.length - 1];
  const st = String(last.street || '').toUpperCase();
  const si = STREETS.indexOf(st);
  if (si < 0) return null;
  const flow = actionFlow(hand, st);
  if (flow.closed || flow.handOver || !flow.actor) return null;
  const hero = String(hand.positions?.hero || '').toUpperCase();
  const actor = String(flow.actor).toUpperCase();
  if (actor !== hero && actor !== 'HERO') return null;
  if (actorSide(hand, last.actor) !== 'villain') return null;
  if (!['BET', 'RAISE_TO', 'ALLIN'].includes(last.type)) return null;
  return { index: acts.length, street: st, toCall: flow.toCall, pot: flow.pot };
}
export function handProfitBB(hand) {
  if (!hand.result) return 0;
  const st = deriveState(hand, (hand.actions || []).length);
  const pot = st.pot;
  const heroInv = st.totalInvest.hero;
  const share = hand.result === 'hero' ? 1 : hand.result === 'split' ? 0.5 : 0;
  return Math.round((share * pot - heroInv) * 10) / 10;
}
export function handClass(hand) { return handClassOfCards(hand.heroCards); }

/** 序列化为 HH v1（附录 B 格式） */
export function serializeHH(hand) {
  const lines = ['# PokerGTO HH v1', 'Game: NLHE', `Stakes: SB=${hand.stakes.sb} BB=${hand.stakes.bb}`, `Table: ${hand.tableSize}max`,
    `Hero: ${hand.positions.hero} [${(hand.heroCards || []).map(cardStr).join('')}]`];
  if ((hand.villainCards || []).length === 2) lines.push(`Villain: [${hand.villainCards.map(cardStr).join('')}]`);
  lines.push(`Stacks: Hero=${hand.stackBB} Villain=${hand.stackBB} (BB)`);
  const byStreet = {};
  for (const a of hand.actions || []) { (byStreet[a.street] = byStreet[a.street] || []).push(a); }
  let cumulative = [];
  for (const st of STREETS) {
    const acts = byStreet[st];
    if (!acts) continue;
    const cap = st.charAt(0) + st.slice(1).toLowerCase();
    let prefix = `${cap}:`;
    const need = st === 'FLOP' ? 3 : st === 'TURN' ? 4 : st === 'RIVER' ? 5 : 0;
    if (need) {
      cumulative = (hand.board || []).slice(0, need);
      prefix += ` [${cumulative.map(cardStr).join('')}]`;
    }
    const verb = { FOLD: 'fold', CHECK: 'check', CALL: 'call', BET: 'bet', RAISE_TO: 'raise', ALLIN: 'allin' };
    const parts = acts.map(a => `${a.actor} ${verb[a.type]}${a.amountBB != null ? ' ' + Number(a.amountBB).toFixed(1) : ''}`);
    lines.push(prefix + (parts.length ? '  ' + parts.join(', ') : ''));
  }
  if (hand.result) lines.push(`Result: ${hand.result === 'hero' ? 'Hero wins' : hand.result === 'split' ? 'Split' : 'Villain wins'}`);
  if ((hand.tags || []).length) lines.push('Tags: ' + hand.tags.join(','));
  if (hand.note) lines.push('Note: ' + hand.note);
  return lines.join('\n');
}
