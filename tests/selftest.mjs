/* selftest.mjs —— 纯逻辑自测（Node 运行：npm test / node tests/selftest.mjs） */
import {
  parseCard, cardStr, eval7, presetMatrix, emptyMatrix, matrixToCombos,
  comboEquityVsRange, mulberry32, applyRangeWidth
} from '../js/cards.js';
import {
  parseHH, validateHand, deriveState, serializeHH, defaultHand, heroDecisionIndices, pendingHeroDecision,
  handProfitBB, handClass, positionsFor, parseActionText, normalizeActionAmounts,
  postflopOrder, firstToActPostflop, heroIsOOP, solveReadiness,
  stageFromBoard, stageBoardCount, actionFlow
} from '../js/hand.js';
import { solveCore, previewCore, ARCHETYPE_PARAMS } from '../js/solver-core.js';
import {
  initDB, state, commit, upsertSession, upsertHand, sessionNet, computeStats,
  escapeHtml, exportJSON, importJSON, exportSessionsCSV
} from '../js/db.js';
import { rangesForDecision, preflopRaiseLevel, raiseLevelFraction, narrowRangeTop } from '../js/range-by-action.js';

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
}
function near(a, b, eps = 1e-6) { return Math.abs(a - b) <= eps; }
const C = (...arr) => arr.map(parseCard);
const H7 = arr => eval7(arr);

console.log('\n[1] 卡牌编解码与 7 张牌评估器');
{
  let allOk = true;
  for (let c = 0; c < 52; c++) if (parseCard(cardStr(c)) !== c) allOk = false;
  ok('52 张牌编解码往返一致', allOk);
  const royal = C('As', 'Ks', 'Qs', 'Js', 'Ts', '2c', '3d');
  const straightFlush = C('Kh', 'Qh', 'Jh', 'Th', '9h', '2c', '3d');
  const quads = C('As', 'Ad', 'Ah', 'Ac', 'Kd', '2c', '3d');
  const fullHouse = C('As', 'Ad', 'Ah', 'Kc', 'Kd', '2c', '3d');
  const flush = C('As', 'Js', '8s', '5s', '2s', 'Kc', '3d');
  const straight = C('As', 'Kd', 'Qh', 'Jc', 'Ts', '2c', '3d');
  const straightBroadway = C('As', 'Kd', 'Qh', 'Jc', 'Ts', '2c', '3d');
  const wheel = C('As', '2d', '3h', '4c', '5s', 'Kc', '9d');
  const twoPair = C('As', 'Ad', 'Kh', 'Kc', '2s', '3c', '4d');
  const pair = C('As', 'Ad', 'Kh', 'Qc', '2s', '3c', '4d');
  const high = C('As', 'Kd', 'Qh', 'Jc', '9s', '2c', '3d');
  ok('同花顺 > 四条 > 葫芦 > 同花 > 顺子 > 两对 > 一对 > 高张',
    H7(royal) > H7(quads) && H7(quads) > H7(fullHouse) && H7(fullHouse) > H7(flush) &&
    H7(flush) > H7(straightBroadway) && H7(straightBroadway) > H7(twoPair) &&
    H7(twoPair) > H7(pair) && H7(pair) > H7(high));
  ok('皇家同花顺 > K 高同花顺', H7(royal) > H7(straightFlush));
  ok('A2345 轮子顺子成立且 > 高张', H7(wheel) > H7(high) && H7(wheel) < H7(flush));
  ok('同花判定（5 张同花色）', H7(flush) > H7(straight));
  ok('A 可作 1 组成轮子但不误判为 Broadway', H7(wheel) < H7(straightBroadway));
}

console.log('\n[2] 范围矩阵与权益');
{
  const all = presetMatrix('all');
  const combos = matrixToCombos(all, [], 0.02, 1400);
  ok('全范围展开 1326 组合', combos.length === 1326, '实际 ' + combos.length);
  const tag = presetMatrix('tag'), tight = matrixToCombos(tag, [], 0.02, 1400);
  ok('紧凶范围显著窄于全范围', tight.length < combos.length * 0.35, `${tight.length} / 1326`);
  const widened = applyRangeWidth(tag, 1.6, 1);
  ok('画像范围宽度倍率生效（松范围变宽）', matrixToCombos(widened, [], 0.02, 1400).length > tight.length);

  const km = emptyMatrix(); km[11][11] = 1; // KK
  const kk = matrixToCombos(km, [], 0.02, 100);
  const board = C('2c', '7d', '8h', '9s', 'Jc');
  const hero = C('As', 'Ad');
  const eq = comboEquityVsRange(hero, kk, board, 0, mulberry32(1));
  ok('河牌圈 AA vs KK 权益 ≈ 1', eq > 0.95, 'eq=' + eq.toFixed(3));
  const eq2 = comboEquityVsRange(C('As', 'Kd'), kk, board, 0, mulberry32(2));
  ok('河牌圈 AK 高张 vs KK 权益 ≈ 0', eq2 < 0.05, 'eq=' + eq2.toFixed(3));
}

const HH_EXAMPLE = `# PokerGTO HH v1
Game: NLHE
Stakes: SB=1 BB=2
Table: 6max
Hero: BTN [AsKd]
Stacks: Hero=100 Villain=100 (BB)
Preflop: UTG fold, MP fold, CO fold, BTN raise 5, SB fold, BB call 5
Flop: [Kc7h2s]  BB check, BTN bet 3.3, BB call 3.3
Turn: [Kc7h2s5d]  BB check, BTN bet 11, BB fold
Result: Hero wins`;

console.log('\n[3] HH v1 解析与序列化');
{
  const r = parseHH(HH_EXAMPLE);
  ok('示例牌谱解析无错误', r.errors.length === 0, JSON.stringify(r.errors));
  ok('公共牌 4 张（转牌）', r.hand.board.length === 4);
  ok('行动 12 条', r.hand.actions.length === 12, '实际 ' + r.hand.actions.length);
  ok('Hero 手牌 AsKd', r.hand.heroCards.map(cardStr).join('') === 'AsKd');
  const v = validateHand(r.hand);
  ok('示例牌谱状态机校验通过', v.ok, JSON.stringify(v.errors));
  ok('单挑可求解', v.solveAllowed === true);
  ok('推算底池 > 0', v.computedPotBB > 0, v.computedPotBB + ' BB');
  const back = parseHH(serializeHH(r.hand));
  ok('序列化 → 解析往返一致', back.errors.length === 0 && back.hand.board.length === 4 && back.hand.actions.length === 12,
    JSON.stringify(back.errors));
  ok('Hero 决策点可识别', heroDecisionIndices(r.hand).length === 2, JSON.stringify(heroDecisionIndices(r.hand)));
  const st = deriveState(r.hand, heroDecisionIndices(r.hand)[0]);
  ok('决策点局面：翻牌 3 张 / 后手 > 0', st.board.length === 3 && st.stack > 0, JSON.stringify({ pot: st.pot, stack: st.stack, street: st.street }));
  ok('手牌盈亏为数值', Number.isFinite(handProfitBB(r.hand)));
  ok('牌型分类可用', typeof handClass(r.hand) === 'string');
  ok('9 人桌位置 9 个 / 6 人桌 6 个', positionsFor(9).length === 9 && positionsFor(6).length === 6);
}

console.log('\n[4] 状态机边界与异常拦截');
{
  const dup = parseHH(HH_EXAMPLE.replace('[Kc7h2s]', '[KcKc2s]'));
  ok('公共牌重复被拦截', dup.errors.some(e => /重复/.test(e.msg)), JSON.stringify(dup.errors));
  const unknown = parseHH(HH_EXAMPLE + '\nFoobar: xyz');
  ok('未知标记返回行号', unknown.errors.some(e => e.line > 0 && /未知标记/.test(e.msg)));
  const h = defaultHand();
  h.heroCards = C('As', 'Kd'); h.board = C('Kc', '7h', '2s');
  h.actions = [{ street: 'FLOP', actor: 'BB', type: 'BET', amountBB: 3 }, { street: 'FLOP', actor: 'BTN', type: 'CHECK', amountBB: null }];
  let v = validateHand(h);
  ok('有待跟注额时 CHECK 被拦截', v.errors.some(e => /不能过牌/.test(e.msg)), JSON.stringify(v.errors));
  h.actions = [{ street: 'FLOP', actor: 'BB', type: 'BET', amountBB: 3 }, { street: 'FLOP', actor: 'BTN', type: 'RAISE_TO', amountBB: 3.5 }];
  v = validateHand(h);
  ok('低于最小加注额被拦截', v.errors.some(e => /最小加注额/.test(e.msg)), JSON.stringify(v.errors));
  h.actions = [{ street: 'FLOP', actor: 'BB', type: 'BET', amountBB: 0.2 }];
  v = validateHand(h);
  ok('低于最小下注 1BB 被拦截', v.errors.some(e => /最小下注/.test(e.msg)));
  h.board = C('Kc', '7h'); h.actions = [];
  v = validateHand(h);
  ok('翻前（公共牌 <3）禁止求解但允许归档', v.ok && v.solveAllowed === false && v.warnings.some(w => /不输出求解/.test(w)));
  const multi = parseHH(HH_EXAMPLE);
  multi.hand.actions.push({ street: 'TURN', actor: 'UTG', type: 'CHECK', amountBB: null });
  v = validateHand(multi.hand);
  ok('翻后多人底池不输出求解结果', v.solveAllowed === false && v.warnings.some(w => /单挑/.test(w)));
  const pct = parseHH('Game: NLHE\nStakes: SB=1 BB=2\nTable: 6max\nHero: BTN [AsKd]\nFlop: [Kc7h2s] Pot=10  BB bet 50%, BTN call');
  ok('百分比下注 + Pot= 正确换算为 BB', pct.errors.length === 0 && near(pct.hand.actions[0].amountBB, 5), JSON.stringify(pct.errors));
  const pctBad = parseHH('Game: NLHE\nStakes: SB=1 BB=2\nTable: 6max\nHero: BTN [AsKd]\nFlop: [Kc7h2s]  BB bet 50%');
  ok('百分比下注缺少 Pot= 时报错', pctBad.errors.some(e => /Pot=/.test(e.msg)));
}

console.log('\n[5] 求解引擎（GTO / 剥削 / 路线预览 / 边界）');
function makeReq(over = {}) {
  const h = parseHH(HH_EXAMPLE).hand;
  const idx = heroDecisionIndices(h)[0];
  const st = deriveState(h, idx);
  return {
    board: st.board, heroCards: h.heroCards, villainCards: [], deadCards: [],
    heroRange: presetMatrix('btn'), villainRange: presetMatrix('bb'),
    pot: 10, stack: 90, facingBet: 0, heroOOP: false, oppChecked: true,
    sizes: [0.33, 0.67, 1], allowCheckRaise: true, preset: 'fast',
    mode: 'gto', archetype: 'tag', intensity: 1,
    userAction: { type: h.actions[idx].type, amountBB: h.actions[idx].amountBB },
    decisionNode: 'FLOP|BTN|vs_check', decisionIndex: idx, iterations: 70, ...over
  };
}
{
  const t = Date.now();
  const r = solveCore(makeReq(), () => {});
  const sum = r.actions.reduce((a, x) => a + x.freq, 0);
  ok('GTO 频率合计 = 100% ±0.1%', Math.abs(sum - 1) <= 0.001, 'sum=' + sum.toFixed(4));
  ok('动作 EV 全部为有限数值', r.actions.every(a => Number.isFinite(a.ev)));
  ok('输出符合 PRD 8.1 字段', ['mode', 'decisionNode', 'pot', 'stacks', 'actions', 'evLossBB', 'exploitabilityMbb', 'iterations', 'durationMs', 'ranges', 'heatmap'].every(k => k in r));
  ok('可剥削度非负', r.exploitabilityMbb >= 0, r.exploitabilityMbb + ' mbb/hand');
  ok('实现 EV 差非负且有界', r.evLossBB == null || (r.evLossBB >= 0 && r.evLossBB < 100));
  ok('范围热力图为 13×13', r.heatmap.hero.length === 13 && r.heatmap.hero[0].length === 13);
  ok('求解耗时可接受', Date.now() - t < 12000, (Date.now() - t) + ' ms');

  const r2 = solveCore(makeReq(), () => {});
  ok('相同参数求解结果可复现（确定性种子）', JSON.stringify(r.actions) === JSON.stringify(r2.actions));

  const e = solveCore(makeReq({ mode: 'exploit', archetype: 'tp', intensity: 1 }), () => {});
  ok('剥削模式字段完整', e.mode === 'exploit' && e.archetype === 'tp' && e.gtoActions && e.exploitGainBB != null);
  ok('剥削增益为有限数值', Number.isFinite(e.exploitGainBB), e.exploitGainBB + ' BB');
  ok('剥削路线频率合计 = 100% ±0.1%', Math.abs(e.actions.reduce((a, x) => a + x.freq, 0) - 1) <= 0.001);
  ok('5 类画像参数齐备', ['tag', 'lag', 'tp', 'lp', 'cs'].every(k => ARCHETYPE_PARAMS[k] && ARCHETYPE_PARAMS[k].width > 0));
  const e2 = solveCore(makeReq({ mode: 'exploit', archetype: 'cs', intensity: 1.5 }), () => {});
  ok('不同画像/强度产生不同剥削路线', JSON.stringify(e.actions.map(a => a.freq)) !== JSON.stringify(e2.actions.map(a => a.freq)));

  const pv = previewCore(makeReq(), 'CHECK');
  ok('路线预览可用并给出下一条街', pv.available === true && pv.street === 'TURN' && pv.actions.length > 0);

  let threw = false;
  try { solveCore(makeReq({ board: C('Kc', '7h'), iterations: 20 }), () => {}); } catch (err) { threw = /翻后/.test(err.message); }
  ok('翻前（公共牌 <3）求解被拒绝', threw);
  threw = false;
  try { solveCore(makeReq({ sizes: [0.2, 0.4, 0.6, 0.8, 1.2], iterations: 20 }), () => {}); } catch (err) { threw = /最多 4 个/.test(err.message); }
  ok('尺度集合 >4 被拒绝', threw);
}

console.log('\n[6] 持久化、统计、工具函数');
{
  await initDB();
  commit(s => { s.sessions = []; s.hands = []; s.jobs = []; });
  const ses = { id: 's1', name: '测试局', date: '2026-11-10', type: 'offline', stakes: { sb: 1, bb: 2 }, buyins: [100, 50], cashout: 220, note: '紧凶桌' };
  upsertSession(ses);
  ok('净盈亏 = 结算 − 总买入', sessionNet(ses) === 70, String(sessionNet(ses)));
  const h = parseHH(HH_EXAMPLE).hand; h.id = 'h1'; h.sessionId = 's1'; h.createdAt = '2026-11-10T10:00:00Z';
  upsertHand(h);
  const st = computeStats('all');
  ok('统计面板汇总正确', st.sessionCount === 1 && st.totalNet === 70 && st.handCount === 1, JSON.stringify({ s: st.sessionCount, n: st.totalNet, h: st.handCount }));
  ok('样本不足 100 手时给出提示', st.sampleWarning === true);
  ok('盈利曲线点数 = 对局数', st.curve.length === 1);
  ok('按位置/牌型分维统计可用', Object.keys(st.byPosition).length > 0 && Object.keys(st.byClass).length > 0);
  ok('XSS 转义', escapeHtml('<img src=x onerror=1>') === '&lt;img src=x onerror=1&gt;');
  const json = exportJSON();
  ok('全量 JSON 备份可导出', json.includes('poker-gto-review-backup'));
  const r = importJSON(json, 'merge');
  ok('JSON 导入合并按 id 去重', r.sessions === 1 && r.hands === 1, JSON.stringify(r));
  ok('对局 CSV 含表头与数据', exportSessionsCSV().includes('净盈亏') && exportSessionsCSV().includes('测试局'));
}

console.log('\n[7] 行动流批量录入与局面推导');
{
  const h = parseHH(HH_EXAMPLE).hand;
  const txt = `Preflop: UTG fold, MP fold, CO fold, BTN raise 5, SB fold, BB call 5
Flop: BB check, BTN bet 3.3, BB call
Turn: BB check, BTN bet 11, BB fold`;
  const r = parseActionText(txt, h);
  ok('批量解析无错误', r.errors.length === 0, JSON.stringify(r.errors));
  ok('批量解析条数正确', r.actions.length === 12, String(r.actions.length));
  ok('中文动作名可识别', parseActionText('Flop: BB 过牌, BTN 下注 3.3', h).actions.length === 2);
  ok('非法动作被拦截', parseActionText('Flop: XX foo', h).errors.length > 0);
  const acts = normalizeActionAmounts(r.actions, h);
  ok('省略的跟注额自动补齐', acts[8].amountBB === 3.3, JSON.stringify(acts[8]));
  const v = validateHand({ ...h, actions: acts });
  ok('批量录入后状态机校验通过', v.ok, JSON.stringify(v.errors));
  ok('live 局面字段可用', !!v.live && Number.isFinite(v.live.pot) && Number.isFinite(v.live.toCall), JSON.stringify(v.live));
  ok('整手结束推算底池 = 29.1 BB', v.computedPotBB === 29.1, String(v.computedPotBB));
  ok('转牌决策点前底池 = 18.1 BB', v.potTrace[9].pot === 18.1, JSON.stringify(v.potTrace[9]));
}

console.log('\n[8] 翻后行动顺序与解算就绪度');
{
  ok('6 人桌翻后顺序 SB 先动', postflopOrder(6).join('>') === 'SB>BB>UTG>MP>CO>BTN', postflopOrder(6).join('>'));
  ok('9 人桌翻后顺序 SB 先动', postflopOrder(9)[0] === 'SB' && postflopOrder(9).slice(-1)[0] === 'BTN', postflopOrder(9).join('>'));

  const hu = defaultHand(); hu.positions.hero = 'SB'; hu.positions.villain = 'BB';
  ok('SB vs BB：SB 先行动', firstToActPostflop(hu) === 'SB', firstToActPostflop(hu));
  ok('SB vs BB：SB 为 OOP', heroIsOOP(hu) === true);
  const ip = defaultHand(); ip.positions.hero = 'BTN'; ip.positions.villain = 'BB';
  ok('BTN vs BB：BB 先行动', firstToActPostflop(ip) === 'BB', firstToActPostflop(ip));
  ok('BTN vs BB：Hero 为 IP', heroIsOOP(ip) === false);

  // 就绪度：默认空牌谱应逐条指出缺失
  const empty = defaultHand();
  const r0 = solveReadiness(empty);
  ok('空牌谱不可解算', r0.ready === false);
  ok('空牌谱列出缺失项', r0.items.filter(x => !x.ok).length >= 1, JSON.stringify(r0.items.filter(x => !x.ok).map(x => x.key)));
  ok('缺失项带修复步骤', r0.items.filter(x => !x.ok).every(x => x.step >= 1));

  // 就绪度：完整单挑牌谱可解算
  const good = parseHH(HH_EXAMPLE).hand;
  const r1 = solveReadiness(good);
  ok('完整牌谱可解算', r1.ready === true, JSON.stringify(r1.items.filter(x => !x.ok)));

  // 就绪度：只填 1 张对手手牌 → 阻塞且指向第 1 步
  const bad = parseHH(HH_EXAMPLE).hand;
  bad.villainCards = [bad.villainCards[0]];
  const r2 = solveReadiness(bad);
  ok('对手手牌 1 张时阻塞解算', r2.ready === false);
  ok('阻塞项指向步骤 1', r2.items.find(x => x.key === 'villainCards').step === 1);

  // 就绪度：翻后出现第三方 → 阻塞且指向第 2 步
  const multi = parseHH(HH_EXAMPLE).hand;
  const turnAt = multi.actions.findIndex(a => /^TURN$/i.test(String(a.street)));
  multi.actions.splice(turnAt, 0, { street: 'FLOP', actor: 'UTG', type: 'CHECK', amountBB: null });
  const r3 = solveReadiness(multi);
  ok('翻后第三人行动时阻塞解算', r3.ready === false);
  ok('多人底池提示指向步骤 2', r3.items.find(x => x.key === 'headsUp').step === 2, JSON.stringify(r3.items.find(x => x.key === 'headsUp')));
}

console.log('\n[8] 翻前场景（board = 0）');
{
  const h = defaultHand();
  h.heroCards = C('As', 'Kd');
  h.actions = [
    { street: 'PREFLOP', actor: 'UTG', type: 'FOLD', amountBB: null },
    { street: 'PREFLOP', actor: 'MP', type: 'FOLD', amountBB: null },
    { street: 'PREFLOP', actor: 'CO', type: 'FOLD', amountBB: null },
    { street: 'PREFLOP', actor: 'BTN', type: 'RAISE_TO', amountBB: 3 },
    { street: 'PREFLOP', actor: 'SB', type: 'FOLD', amountBB: null }
  ];
  const v = validateHand(h);
  ok('翻前 0 张公共牌允许求解', v.ok && v.solveAllowed === true, JSON.stringify(v.errors));
  ok('翻前不再提示公共牌不足', !v.warnings.some(w => /公共牌/.test(w)), JSON.stringify(v.warnings));
  const rd = solveReadiness(h, 'PREFLOP');
  ok('翻前就绪度通过且 phase=preflop', rd.ready === true && rd.phase === 'preflop', JSON.stringify(rd.items.filter(i => !i.ok)));
  ok('翻前就绪度不要求公共牌', rd.items.find(i => i.key === 'board').ok === true);
  const rd2 = solveReadiness(h, 'FLOP');
  ok('切到翻牌但公共牌 0 张时阻塞', rd2.ready === false && rd2.items.find(i => i.key === 'board').ok === false);
  const st = deriveState(h, 3);
  ok('deriveState 返回 PREFLOP / board 0 张', st.street === 'PREFLOP' && st.board.length === 0, JSON.stringify({ street: st.street, board: st.board.length }));
  ok('翻前面对大盲待跟注额', st.facingBet > 0, String(st.facingBet));
  ok('翻前 Hero 动作可作决策点', heroDecisionIndices(h).includes(3), JSON.stringify(heroDecisionIndices(h)));
  ok('阶段推断正确', stageFromBoard(0) === 'PREFLOP' && stageFromBoard(3) === 'FLOP' && stageFromBoard(4) === 'TURN' && stageFromBoard(5) === 'RIVER');
  ok('各阶段所需公共牌数正确', stageBoardCount('PREFLOP') === 0 && stageBoardCount('FLOP') === 3 && stageBoardCount('TURN') === 4 && stageBoardCount('RIVER') === 5);

  const pre = solveCore(makeReq({ board: [], iterations: 30, facingBet: 1, oppChecked: false, decisionNode: 'PREFLOP|BTN|vs_blind', userAction: null }), () => {});
  ok('翻前求解返回 phase=preflop', pre.phase === 'preflop' && pre.boardCount === 0, pre.phase + '/' + pre.boardCount);
  ok('翻前动作含弃牌 / 跟注 / 加注', pre.actions.some(a => a.type === 'FOLD') && pre.actions.some(a => a.type === 'CALL') && pre.actions.some(a => !['FOLD', 'CALL', 'CHECK'].includes(a.type)), JSON.stringify(pre.actions.map(a => a.type)));
  ok('翻前频率合计 100%', Math.abs(pre.actions.reduce((a, x) => a + x.freq, 0) - 1) <= 0.001);
  ok('翻前口径已标注为近似', /翻前近似/.test(pre.convergenceNote));
  const pvPre = previewCore(makeReq({ board: [], iterations: 20, facingBet: 1, oppChecked: false }), '跟注', () => {});
  ok('翻前路线预览一次补齐 3 张翻牌', pvPre.available === true && pvPre.street === 'FLOP' && pvPre.board.length === 3, JSON.stringify({ available: pvPre.available, street: pvPre.street, board: pvPre.board }));
}

console.log('\n[9] 行动流顺位与街结束判定（V1.4）');
{
  const h = defaultHand();
  h.heroCards = C('As', 'Kd');
  const f0 = actionFlow(h, 'PREFLOP');
  ok('翻前首位为两家中最靠前的位置（BTN）', f0.actor === 'BTN', String(f0.actor));
  ok('翻前根局面待跟注 1BB 且未结束', f0.toCall === 1 && f0.closed === false, JSON.stringify({ toCall: f0.toCall, closed: f0.closed }));
  ok('仅 Hero 与对手两家参与顺位', f0.live.length === 2 && f0.live.includes('BTN') && f0.live.includes('BB'));

  h.actions = [{ street: 'PREFLOP', actor: 'BB', type: 'RAISE_TO', amountBB: 5 }];
  const f1 = actionFlow(h, 'PREFLOP');
  ok('对手加注后轮到 Hero', f1.actor === 'BTN' && !f1.closed, JSON.stringify({ actor: f1.actor, closed: f1.closed }));
  ok('加注后待跟注额为 5BB', f1.toCall === 5, String(f1.toCall));
  h.actions.push({ street: 'PREFLOP', actor: 'BTN', type: 'CALL', amountBB: 5 });
  const f2 = actionFlow(h, 'PREFLOP');
  ok('Hero 跟注加注后本街结束且无下一位', f2.closed === true && f2.actor === null, JSON.stringify({ closed: f2.closed, actor: f2.actor }));
  ok('本街结束后待跟注归零', f2.toCall === 0, String(f2.toCall));

  const hf = defaultHand();
  hf.heroCards = C('As', 'Kd');
  hf.actions = [
    { street: 'PREFLOP', actor: 'BB', type: 'RAISE_TO', amountBB: 5 },
    { street: 'PREFLOP', actor: 'BTN', type: 'FOLD', amountBB: null }
  ];
  const ff = actionFlow(hf, 'PREFLOP');
  ok('有人弃牌 → 本手结束，不再顺位', ff.closed && ff.handOver && ff.actor === null);

  const hp = defaultHand();
  hp.heroCards = C('As', 'Kd');
  hp.board = C('Kc', '7h', '2s');
  hp.actions = [{ street: 'FLOP', actor: 'BB', type: 'CHECK', amountBB: null }];
  const fp1 = actionFlow(hp, 'FLOP');
  ok('翻后首动为 OOP（BB），单人过牌不结束', fp1.first === 'BB' && fp1.actor === 'BTN' && !fp1.closed, JSON.stringify({ first: fp1.first, actor: fp1.actor, closed: fp1.closed }));
  hp.actions.push({ street: 'FLOP', actor: 'BTN', type: 'CHECK', amountBB: null });
  const fp2 = actionFlow(hp, 'FLOP');
  ok('双方过牌 → 本街结束', fp2.closed && fp2.actor === null);

  const hb = defaultHand();
  hb.heroCards = C('As', 'Kd');
  hb.board = C('Kc', '7h', '2s');
  hb.actions = [{ street: 'FLOP', actor: 'BB', type: 'BET', amountBB: 3.3 }];
  ok('翻后下注未跟注时本街未结束', !actionFlow(hb, 'FLOP').closed && actionFlow(hb, 'FLOP').actor === 'BTN');
  hb.actions.push({ street: 'FLOP', actor: 'BTN', type: 'CALL', amountBB: 3.3 });
  ok('下注被跟注 → 本街结束（可自动进转牌）', actionFlow(hb, 'FLOP').closed && actionFlow(hb, 'FLOP').actor === null);

  const ho = defaultHand();
  ho.heroCards = C('As', 'Kd');
  ho.actions = ['UTG', 'MP', 'CO', 'SB'].map(actor => ({ street: 'PREFLOP', actor, type: 'FOLD', amountBB: null }));
  const fo = actionFlow(ho, 'PREFLOP');
  ok('其它位置默认弃牌不改变行动顺位', fo.actor === 'BTN' && !fo.closed, String(fo.actor));

  const hl = defaultHand();
  hl.heroCards = C('As', 'Kd');
  hl.positions = { hero: 'BB', villain: 'BTN' };
  hl.actions = [{ street: 'PREFLOP', actor: 'BTN', type: 'CALL', amountBB: 1 }];
  const fl = actionFlow(hl, 'PREFLOP');
  ok('翻前跛入后轮到大盲、待跟注归零（大盲期权）', fl.actor === 'BB' && fl.toCall === 0 && !fl.closed, JSON.stringify({ actor: fl.actor, toCall: fl.toCall, closed: fl.closed }));
  hl.actions.push({ street: 'PREFLOP', actor: 'BB', type: 'CHECK', amountBB: null });
  ok('大盲过牌后本街结束', actionFlow(hl, 'PREFLOP').closed === true);
}

console.log('\n[10] HH 导入位置推断与待应对决策点（V1.5 回归）');
{
  const userHH = `# PokerGTO HH v1
Game: NLHE
Stakes: SB=1 BB=2
Table: 6max
Hero: BB [Kc4c]
Stacks: Hero=100 Villain=100 (BB)
Preflop:  BTN raise 6.0, BB call 6.0
Flop: [Kd6h9s]  BB check, BTN bet 9.0`;
  const r = parseHH(userHH), h = r.hand, v = validateHand(h);
  ok('Hero=BB 时 Villain 被推断为 BTN（不再与 Hero 冲突）', h.positions.hero === 'BB' && h.positions.villain === 'BTN', JSON.stringify(h.positions));
  ok('对手加注/下注不再被判第三方', v.otherActors.length === 0 && v.solveAllowed === true, JSON.stringify({ other: v.otherActors, allowed: v.solveAllowed }));
  ok('范围模板随位置同步（Hero=BB 用 BB 防守）', h.rangePresets.hero === 'bb' && h.rangePresets.villain === 'btn', JSON.stringify(h.rangePresets));
  const pend = pendingHeroDecision(h);
  ok('识别到 Hero 待应对的虚拟决策点', pend && pend.index === h.actions.length && pend.street === 'FLOP' && pend.toCall === 9, JSON.stringify(pend));
  const st = deriveState(h, pend.index);
  ok('待决策点局面：翻牌 / 面对 9BB 下注 / 底池 22.5', st.street === 'FLOP' && st.facingBet === 9 && Math.abs(st.pot - 22.5) < 0.05, JSON.stringify({ street: st.street, facing: st.facingBet, pot: st.pot }));
  // 对手下注已被跟注 → 不再是待决策点
  const h2 = JSON.parse(JSON.stringify(h));
  h2.actions.push({ street: 'FLOP', actor: 'BB', type: 'CALL', amountBB: 9 });
  ok('Hero 跟注后不再有待应对决策点', pendingHeroDecision(h2) === null, JSON.stringify(pendingHeroDecision(h2)));
  // 显式 Villain 位置优先
  const explicit = parseHH(userHH.replace('Stacks:', 'Villain: BTN [QhQd]\nStacks:'));
  ok('显式 Villain 位置被尊重', explicit.hand.positions.villain === 'BTN', JSON.stringify(explicit.hand.positions));
  // 序列化往返保持位置
  const back = parseHH(serializeHH(h));
  ok('序列化往返后位置仍正确', back.hand.positions.hero === 'BB' && back.hand.positions.villain === 'BTN', JSON.stringify(back.hand.positions));
}

console.log('\n[11] 行动线合法性与跟注选项（V1.7 回归）');
/* 行动线合法性与跟注选项（V1.7 回归） */
{
  const userHH = `# PokerGTO HH v1
Game: NLHE
Stakes: SB=1 BB=2
Table: 6max
Hero: BB [3cKc]
Stacks: Hero=100 Villain=100 (BB)
Preflop:  BTN raise 4.0, BB call 4.0
Flop: [Kd5h8s]  BB bet 6.4
Turn: [Kd5h8sTs]  BB check, BTN bet 10.7, BB call 10.7
River: [Kd5h8sTs5s]  BB check, BTN bet 37.3, BB call 37.3, BB check`;
  const pu = parseHH(userHH);
  const vu = validateHand(pu.hand);
  ok('不合牌谱被判非法（ok=false）', vu.ok === false, `ok=${vu.ok}`);
  ok('翻牌下注未被回应就进转牌 → 报错', vu.errors.some(e => e.path === 'actions[3]' && /未被回应/.test(e.msg)),
    JSON.stringify(vu.errors.map(e => e.path)));
  ok('河牌收口后又录过牌 → 报错', vu.errors.some(e => e.path === 'actions[9]' && /下注轮已结束/.test(e.msg)),
    JSON.stringify(vu.errors.map(e => e.path)));
  ok('违规行动流阻断解算（就绪度 actions 不通过）', solveReadiness(pu.hand, 'RIVER').items.some(i => i.key === 'actions' && !i.ok));

  // 位置冲突（Hero=BB、对手也=BB）：下注后必须仍轮到对手、待跟注 > 0（跟注选项存在）
  const clash = defaultHand();
  clash.positions = { hero: 'BB', villain: 'BB' };
  clash.heroCards = [23, 11]; clash.board = [24, 29, 45];
  clash.actions = [
    { street: 'PREFLOP', actor: 'BTN', type: 'RAISE_TO', amountBB: 4 },
    { street: 'PREFLOP', actor: 'BB', type: 'CALL', amountBB: 4 },
    { street: 'FLOP', actor: 'BB', type: 'BET', amountBB: 6.4 }
  ];
  const fc = actionFlow(clash, 'FLOP');
  ok('位置冲突时下注后不误判收口（跟注选项仍在）', fc.closed === false && fc.actor === 'BTN' && fc.toCall > 0, JSON.stringify({ actor: fc.actor, closed: fc.closed, toCall: fc.toCall }));
  const vc = validateHand(clash);
  ok('位置冲突被报错并阻断解算', vc.errors.some(e => e.path === 'positions') && vc.solveAllowed === false);
  ok('就绪度包含「位置不同」检查项', solveReadiness(clash, 'FLOP').items.some(i => i.key === 'positions' && !i.ok));

  // 挂起状态（行动以下注收尾、轮到对手）是合法中间态，不报错
  const pend = defaultHand();
  pend.positions = { hero: 'BB', villain: 'BTN' };
  pend.heroCards = [23, 11]; pend.board = [24, 29, 45];
  pend.actions = [
    { street: 'PREFLOP', actor: 'BTN', type: 'RAISE_TO', amountBB: 4 },
    { street: 'PREFLOP', actor: 'BB', type: 'CALL', amountBB: 4 },
    { street: 'FLOP', actor: 'BB', type: 'BET', amountBB: 6.4 }
  ];
  const vp = validateHand(pend);
  ok('挂起状态（下注待回应）不报错', vp.ok === true, JSON.stringify(vp.errors));

  // walk：翻前全弃牌到 BB，BB 过牌只有归档提示、不报错
  const walk = defaultHand();
  walk.positions = { hero: 'BB', villain: 'BTN' };
  walk.heroCards = [23, 11];
  walk.actions = ['UTG', 'MP', 'CO', 'BTN', 'SB'].map(p => ({ street: 'PREFLOP', actor: p, type: 'FOLD', amountBB: null }));
  walk.actions.push({ street: 'PREFLOP', actor: 'BB', type: 'CHECK', amountBB: null });
  const vw = validateHand(walk);
  ok('walk 过牌不报错（仅提示）', vw.ok === true && vw.warnings.some(w => /walk/.test(w)), JSON.stringify(vw.errors));

  // 双方全下 runout 后不再有行动，不误报
  const ai = defaultHand();
  ai.positions = { hero: 'BB', villain: 'BTN' };
  ai.heroCards = [23, 11]; ai.board = [24, 29, 45, 47, 42];
  ai.actions = [
    { street: 'PREFLOP', actor: 'BTN', type: 'RAISE_TO', amountBB: 4 },
    { street: 'PREFLOP', actor: 'BB', type: 'CALL', amountBB: 4 },
    { street: 'FLOP', actor: 'BB', type: 'ALLIN', amountBB: 96 },
    { street: 'FLOP', actor: 'BTN', type: 'CALL', amountBB: 96 }
  ];
  const va = validateHand(ai);
  ok('全下被跟注收口不误报', va.ok === true, JSON.stringify(va.errors));

  // 下注被跟注后本街收口；收口后再录一条 → 报错
  const over = defaultHand();
  over.positions = { hero: 'BB', villain: 'BTN' };
  over.heroCards = [23, 11]; over.board = [24, 29, 45];
  over.actions = [
    { street: 'FLOP', actor: 'BB', type: 'BET', amountBB: 6 },
    { street: 'FLOP', actor: 'BTN', type: 'CALL', amountBB: 6 },
    { street: 'FLOP', actor: 'BB', type: 'CHECK', amountBB: null }
  ];
  const vo = validateHand(over);
  ok('收口后多余的过牌被拦截', vo.ok === false && vo.errors.some(e => /下注轮已结束/.test(e.msg)));
}

console.log('\n[11] V1.9 行动标签口径：具体 BB 尺度 / 加注至语义');
{
  // 面对下注：加注标签必须是「加注至 X BB」，禁止「加注 N% 池」类说法
  const rf = solveCore(makeReq({ facingBet: 9, oppChecked: false, pot: 22.5, iterations: 40 }), () => {});
  const raise = rf.actions.find(a => a.type === 'RAISE');
  ok('面对下注时存在加注选项', !!raise, JSON.stringify(rf.actions.map(a => a.type)));
  ok('加注标签为「加注至 X BB」', !!raise && /^加注至 [\d.]+ BB$/.test(raise.label), raise && raise.label);
  ok('加注标签与 sizeBB（加注至总额）一致', !!raise && raise.label === `加注至 ${raise.sizeBB} BB`, raise && JSON.stringify({ label: raise.label, sizeBB: raise.sizeBB }));
  ok('加注至总额 ≥ 面对下注 + 最小加注', !!raise && raise.sizeBB >= 9 + 9 - 1e-6, raise && String(raise.sizeBB));
  const call = rf.actions.find(a => a.type === 'CALL');
  ok('跟注标签带具体 BB', !!call && /^跟注 [\d.]+ BB$/.test(call.label), call && call.label);
  const allin = rf.actions.find(a => a.type === 'ALLIN');
  if (allin) ok('全下标签带具体 BB', /^全下 [\d.]+ BB$/.test(allin.label), allin.label);
  ok('面对下注时无「过牌」选项', !rf.actions.some(a => a.type === 'CHECK'), JSON.stringify(rf.actions.map(a => a.type)));
  ok('全部标签不含「% 池」旧说法', rf.actions.every(a => !String(a.label).includes('% 池')), rf.actions.map(a => a.label).join(' | '));

  // 无人下注：下注标签为「下注 X BB」，含过牌、无加注
  const rc = solveCore(makeReq({ iterations: 40 }), () => {});
  const bet = rc.actions.find(a => a.type === 'BET');
  ok('下注标签为「下注 X BB」', !!bet && /^下注 [\d.]+ BB$/.test(bet.label), bet && bet.label);
  ok('无人下注时含过牌、无加注', rc.actions.some(a => a.type === 'CHECK') && !rc.actions.some(a => a.type === 'RAISE'));
  ok('下注标签不含百分比旧说法', rc.actions.every(a => !String(a.label).includes('% 池')));
}

console.log('\n[12] V1.10 超后手钳制：「跟注 0 BB」退化回归（用户牌谱）');
{
  const HH = `# PokerGTO HH v1
Game: NLHE
Stakes: SB=1 BB=2
Table: 6max
Hero: BB [Kc4c]
Stacks: Hero=100 Villain=100 (BB)
Preflop:  BTN raise 6.0, BB raise 24.0, BTN call 18.0
Flop: [QdTd3h]  BB bet 33.2, BTN call 33.2
Turn: [QdTd3h5s]  BB check, BTN bet 58.0`;
  const { hand } = parseHH(HH);
  const v = validateHand(hand);
  ok('超后手行动给出警告且不判错（按全下钳制）', v.ok && v.warnings.some(w => /超过剩余后手 42\.8/.test(w)), JSON.stringify(v.warnings));
  ok('钳制后待跟注额 = 42.8（对手全下）', Math.abs(v.live.toCall - 42.8) < 0.05, String(v.live.toCall));
  const pend = pendingHeroDecision(hand);
  ok('待应对决策点 toCall = 42.8', !!pend && Math.abs(pend.toCall - 42.8) < 0.05, JSON.stringify(pend));
  const st = deriveState(hand, pend.index);
  ok('deriveState 有效后手 = 42.8（不再归零）', Math.abs(st.stack - 42.8) < 0.05, String(st.stack));
  ok('deriveState facingBet = 42.8（钳制到后手以内）', Math.abs(st.facingBet - 42.8) < 0.05, String(st.facingBet));
  ok('剩余后手字段：hero 42.8 / villain 0', Math.abs(st.rem.hero - 42.8) < 0.05 && st.rem.villain < 0.05, JSON.stringify(st.rem));
  const r = solveCore({
    board: st.board, heroCards: hand.heroCards, villainCards: hand.villainCards, deadCards: [],
    heroRange: hand.ranges.hero, villainRange: hand.ranges.villain,
    pot: st.pot, stack: st.stack, facingBet: st.facingBet, heroOOP: st.heroOOP, oppChecked: st.oppChecked,
    sizes: hand.sizes, allowCheckRaise: hand.allowCheckRaise, preset: 'fast',
    mode: 'gto', archetype: null, intensity: 0.5, userAction: null,
    decisionNode: 'TURN|BB|vs_bet', decisionIndex: pend.index, stage: 'TURN'
  }, () => {});
  ok('根行动不含「跟注 0」退化标签', r.actions.every(a => !/^跟注 0(\.0)? BB/.test(a.label)), r.actions.map(a => a.label).join(' | '));
  const call = r.actions.find(a => a.type === 'CALL');
  ok('跟注标签为「跟注 42.8 BB（全下）」', !!call && call.label === '跟注 42.8 BB（全下）', call && call.label);
  ok('跟注金额 = 42.8 且面对全下无加注选项', !!call && Math.abs(call.sizeBB - 42.8) < 0.05 && !r.actions.some(a => a.type === 'RAISE' || a.type === 'BET'), JSON.stringify(r.actions.map(a => a.type)));
  ok('存在弃牌选项（非 100% 跟注单一退化解）', r.actions.some(a => a.type === 'FOLD') && call.freq < 0.999, 'call freq=' + (call && call.freq));
  // 退化输入防御：facingBet 超过 stack 时 makeRoot 钳制，不产生「跟注 0 BB」
  const r2 = solveCore(makeReq({ facingBet: 58, stack: 0, pot: 158.7, iterations: 40 }), () => {});
  ok('退化输入（stack=0, facing=58）仍无「跟注 0」', r2.actions.every(a => !/^跟注 0(\.0)? BB/.test(a.label)), r2.actions.map(a => a.label).join(' | '));
  // 正常局面不受影响：跟注标签无（全下）后缀
  const r3 = solveCore(makeReq({ facingBet: 9, iterations: 40 }), () => {});
  const c3 = r3.actions.find(a => a.type === 'CALL');
  ok('正常跟注无全下后缀', !!c3 && /^跟注 9\.0 BB$/.test(c3.label), c3 && c3.label);
}

console.log('\n[13] 求解尺度与推荐文案同源（V1.11：加注至选项匹配推荐）');
{
  const { solverSizeOptions } = await import('../js/ui-sizes.js');
  // 用户反馈局面：推荐「加注至 11.1 BB」/「加注至 23.9 BB」，旧规则档位不含这两个金额
  const acts = [
    { type: 'FOLD', sizeBB: null, label: '弃牌', freq: 0.05, ev: -4.8 },
    { type: 'CALL', sizeBB: 4.8, label: '跟注 4.8 BB', freq: 0.10, ev: 1.2 },
    { type: 'RAISE', sizeBB: 11.1, label: '加注至 11.1 BB', freq: 0.85, ev: 5.93 },
    { type: 'RAISE', sizeBB: 23.9, label: '加注至 23.9 BB', freq: 0.10, ev: 6.69 },
    { type: 'ALLIN', sizeBB: 42.8, label: '全下 42.8 BB', freq: 0.05, ev: 5.1 }
  ];
  const raises = solverSizeOptions(acts, 'RAISE', 42.8, 9.6);
  ok('加注档位包含推荐 11.1 BB', raises.some(o => Math.abs(o.amt - 11.1) < 0.05), JSON.stringify(raises));
  ok('加注档位包含次优 23.9 BB', raises.some(o => Math.abs(o.amt - 23.9) < 0.05), JSON.stringify(raises));
  ok('档位金额与求解动作完全一致（不再用最小加注/2×/3×）', raises.every(o => acts.some(a => a.type === 'RAISE' && Math.abs(a.sizeBB - o.amt) < 0.05)), JSON.stringify(raises));
  ok('档位按金额升序且去重', raises.every((o, i) => i === 0 || o.amt > raises[i - 1].amt), JSON.stringify(raises));
  ok('超后手金额被过滤', solverSizeOptions([{ type: 'RAISE', sizeBB: 50 }], 'RAISE', 42.8, 9.6) === null);
  ok('低于最小加注的金额被过滤', solverSizeOptions([{ type: 'RAISE', sizeBB: 8 }], 'RAISE', 42.8, 9.6) === null);
  ok('无求解动作时返回 null（触发规则档兜底）', solverSizeOptions([{ type: 'FOLD' }], 'RAISE', 42.8, 9.6) === null);
  ok('空输入返回 null', solverSizeOptions(null, 'RAISE', 42.8, 9.6) === null && solverSizeOptions([], 'BET', 42.8, 0) === null);
  const bets = solverSizeOptions([
    { type: 'BET', sizeBB: 3.3, label: '下注 3.3 BB', freq: 0.6, ev: 2.1 },
    { type: 'BET', sizeBB: 6.6, label: '下注 6.6 BB', freq: 0.4, ev: 2.0 },
    { type: 'CHECK', sizeBB: null, label: '过牌', freq: 0.0, ev: 0 }
  ], 'BET', 42.8, 0.9);
  ok('下注档位同样取自求解动作', bets.length === 2 && Math.abs(bets[0].amt - 3.3) < 0.05 && Math.abs(bets[1].amt - 6.6) < 0.05, JSON.stringify(bets));
  ok('求解档位带来源标签「均衡档」', raises.every(o => o.label === '均衡档') && bets.every(o => o.label === '均衡档'));
  ok('重复金额去重', solverSizeOptions([{ type: 'RAISE', sizeBB: 11.1 }, { type: 'RAISE', sizeBB: 11.1 }], 'RAISE', 42.8, 9.6).length === 1);
  ok('金额四舍五入到 0.1 BB', solverSizeOptions([{ type: 'RAISE', sizeBB: 11.06 }], 'RAISE', 42.8, 9.6)[0].amt === 11.1);
}

/* [14] V1.12 行动一致范围：对手加注后范围收窄，杜绝深码弱牌被误判全下 */
{
  const HH = `# PokerGTO HH v1
Game: NLHE
Stakes: SB=1 BB=2
Table: 6max
Hero: BTN [3c3d]
Stacks: Hero=500 Villain=500 (BB)
Preflop:  BTN raise 3.5, BB raise 14.0, BTN raise 40.0, BB raise 132.0`;
  const { hand } = parseHH(HH);
  const idx = pendingHeroDecision(hand).index;
  ok('牌谱解析无错误且决策点=4', idx === 4, 'idx=' + idx);

  // 加注级别
  ok('对手翻前再加注级别=2（3bet→5bet）', preflopRaiseLevel(hand, 'villain', idx) === 2);
  ok('Hero 加注级别=2（open→4bet）', preflopRaiseLevel(hand, 'hero', idx) === 2);
  const noRaise = { ...hand, actions: [] };
  ok('无加注时级别=0', preflopRaiseLevel(noRaise, 'villain') === 0);
  const oneRaise = { ...hand, actions: hand.actions.slice(0, 1) };
  ok('仅开池时对手级别=0', preflopRaiseLevel(oneRaise, 'villain') === 0);

  // 深码收窄比例
  const fDeep = raiseLevelFraction(2, 500), fShort = raiseLevelFraction(2, 100);
  ok('深码收窄比例严格小于短码', fDeep < fShort, `${fDeep} < ${fShort}`);
  ok('无加注不收窄', raiseLevelFraction(0, 500) === 1);
  ok('级别越高范围越窄', raiseLevelFraction(1, 100) > raiseLevelFraction(2, 100) && raiseLevelFraction(2, 100) > raiseLevelFraction(3, 100));

  // 纯函数收窄
  const m = presetMatrix('bb');
  const nm = narrowRangeTop(m, 0.16);
  ok('收窄后 AA 保留', nm[12][12] > 0);
  ok('收窄剔除大量弱牌', nm[6][2] === 0 || nm[0][1] === 0, `72o=${nm[6][2]} 23o=${nm[0][1]}`);
  ok('收窄不修改原矩阵', m[6][2] > 0 || m[0][1] > 0);
  ok('fraction=1 原样返回', narrowRangeTop(m, 1) === m);

  // 派生范围不影响已存数据
  const ranges = rangesForDecision(hand, idx);
  ok('派生说明含加注级别与比例', /加注级别 2/.test(ranges.note) && /16%/.test(ranges.note), ranges.note);
  ok('Hero 范围保持原样（手牌已知）', ranges.hero === hand.ranges.hero);
  ok('对手范围被收窄（组合减少）', matrixToCombos(ranges.villain, [], 0.02, 420).length < matrixToCombos(hand.ranges.villain, [], 0.02, 420).length);

  // 端到端：33 不再 100% 全下
  const st = deriveState(hand, idx);
  const req = {
    board: [], heroCards: hand.heroCards, villainCards: [], deadCards: [],
    heroRange: ranges.hero, villainRange: ranges.villain,
    pot: st.pot, stack: st.stack, facingBet: st.facingBet,
    sizes: hand.sizes, allowCheckRaise: true, preset: 'fast', mode: 'gto', iterations: 12000
  };
  const r = solveCore(req);
  const focus = r.focus.strategy;
  const rec = focus.slice().sort((a, b) => b.freq - a.freq)[0];
  const ai = focus.find(a => a.type === 'ALLIN');
  ok('3c3d 对收窄后范围权益显著下降', r.focus.equityVsVillainRange < 0.4, 'eq=' + r.focus.equityVsVillainRange);
  ok('3c3d 不再推荐全下', rec.type !== 'ALLIN', rec.label + ' ' + (rec.freq * 100).toFixed(0) + '%');
  ok('3c3d 全下手牌条件频率 < 20%', ai.freq < 0.2, 'AI=' + (ai.freq * 100).toFixed(1) + '%');
  ok('3c3d 推荐弃牌（5bet 价值范围下合理）', rec.type === 'FOLD', rec.label);
  ok('求解结果仍给出全部合法动作', r.actions.length === 5, 'acts=' + r.actions.length);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
if (fail) process.exit(1);
