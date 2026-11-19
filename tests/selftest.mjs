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
import { solveCore, previewCore, ARCHETYPE_PARAMS, resolveConvergence, CONVERGENCE_TARGETS } from '../js/solver-core.js';
import {
  rangeConditionParams, GTO_RANGE_CONDITION, foldToRaiseByStreet, streetAdjustedRangeCondition
} from '../js/archetypes.js';
import {
  initDB, state, commit, upsertSession, upsertHand, sessionNet, computeStats,
  escapeHtml, exportJSON, importJSON, exportSessionsCSV, jobCacheKey
} from '../js/db.js';
import {
  rangesForDecision, preflopRaiseLevel, raiseLevelFraction, narrowRangeTop, applyArchetypeToRange,
  preflopRaiseTier, archetypeWidth, targetWidthPct, TOTAL_COMBOS
} from '../js/range-by-action.js';
import {
  actionKind, freqItems, comboCodesForClass, comboKey, threeWay,
  freqOverviewHtml, freqCellHtml, freqActionHtml
} from '../js/freq-view.js';

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
  ok('整手结束推算底池 = 28.6 BB（盲注口径）', v.computedPotBB === 28.6, String(v.computedPotBB));
  ok('转牌决策点前底池 = 17.6 BB（盲注口径）', v.potTrace[9].pot === 17.6, JSON.stringify(v.potTrace[9]));
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
  ok('加注后待跟注额为 4.5BB（扣 SB 已投 0.5）', f1.toCall === 4.5, String(f1.toCall));
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
  ok('待决策点局面：翻牌 / 面对 9BB 下注 / 底池 22（含盲注口径）', st.street === 'FLOP' && st.facingBet === 9 && Math.abs(st.pot - 22) < 0.05 && Math.abs(st.totalInvest.hero + st.totalInvest.villain - st.pot) < 0.05, JSON.stringify({ street: st.street, facing: st.facingBet, pot: st.pot, total: st.totalInvest }));
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
  const ranges = rangesForDecision(hand, idx, { mode: 'gto', archetype: 'tag', intensity: 1, stackBB: 460 });
  ok('派生说明含绝对宽度口径与加注档位', /5bet/.test(ranges.note) && /全范围/.test(ranges.note), ranges.note);
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
  ok('3c3d 对收窄后范围权益显著下降', r.focus.equityVsVillainRange < 0.52, 'eq=' + r.focus.equityVsVillainRange);
  ok('3c3d 不再推荐全下', rec.type !== 'ALLIN', rec.label + ' ' + (rec.freq * 100).toFixed(0) + '%');
  ok('3c3d 全下条件频率 < 20%（深码超底池不再进入动作集）', (ai?.freq || 0) < 0.2, 'AI=' + ((ai?.freq || 0) * 100).toFixed(1) + '%');
  ok('3c3d 推荐非全下（手牌条件频率修复后可跟注）', rec.type !== 'ALLIN', rec.label + ' ' + (rec.freq * 100).toFixed(0) + '%');
  ok('求解结果给出全部合法动作（深码全下已剔除）', r.actions.length === 4, 'acts=' + r.actions.length);
}

console.log('\n[15] V1.13 审查缺陷修复（手牌条件频率 / 画像范围锁定 / 盲注后手）');
{
  // P0-1：Hero 已知手牌必须留在组合集，focus 才能取到真实权益与策略桶
  const hhAK = '# PokerGTO HH v1\nHero: BB [AhKd]\nStakes: SB=1 BB=2\nPreflop: BTN raise 3, BB call 2';
  const hAK = parseHH(hhAK).hand, stAK = deriveState(hAK, 2);
  const rAK = solveCore({
    board: [], heroCards: hAK.heroCards, villainCards: [], deadCards: [],
    heroRange: hAK.ranges.hero, villainRange: hAK.ranges.villain,
    pot: stAK.pot, stack: stAK.stack, facingBet: stAK.facingBet,
    sizes: hAK.sizes, allowCheckRaise: true, preset: 'fast', mode: 'gto', iterations: 12000
  });
  ok('焦点命中 Hero 已知手牌（不再取随手牌）', !!rAK.focus && rAK.focus.cards.join(' ') === hAK.heroCards.map(cardStr).join(' '), JSON.stringify(rAK.focus?.cards));
  ok('AKo 翻前权益恢复到合理区间（>50%）', rAK.focus.equityVsVillainRange > 0.5, 'eq=' + rAK.focus.equityVsVillainRange);

  // P0-2：松型画像不得复活被行动历史收窄的组合
  const hhDeep = '# PokerGTO HH v1\nHero: BTN [3c3d]\nStakes: SB=1 BB=2\nStacks: Hero=500 Villain=500 (BB)\nPreflop: BTN raise 3.5, BB raise 14, BTN raise 40, BB raise 132';
  const hDeep = parseHH(hhDeep).hand, stD = deriveState(hDeep, 4), rgD = rangesForDecision(hDeep, 4);
  const cnt = m => matrixToCombos(m, [], 0.02, 420).length;
  const before = cnt(rgD.villain);
  for (const a of ['lag', 'lp', 'cs']) {
    const after = cnt(applyArchetypeToRange(rgD.villain, ARCHETYPE_PARAMS[a].width, 1, true));
    ok(`${a.toUpperCase()} 松型画像不复活行动收窄组合`, after <= before, `${before}→${after}`);
  }
  const tagApplied = applyArchetypeToRange(rgD.villain, ARCHETYPE_PARAMS.tag.width, 1, true);
  ok('紧型画像仍可进一步压低组合权重', tagApplied[12][12] < rgD.villain[12][12] && tagApplied[12][12] > 0, `${rgD.villain[12][12]}→${tagApplied[12][12]}`);
  ok('未锁定局面画像仍按宽度放宽', cnt(applyArchetypeToRange(rgD.villain, ARCHETYPE_PARAMS.lag.width, 1, false)) > before);
  const reqD = {
    board: [], heroCards: hDeep.heroCards, villainCards: [], deadCards: [],
    heroRange: rgD.hero, villainRange: rgD.villain, pot: stD.pot, stack: stD.stack,
    facingBet: stD.facingBet, sizes: hDeep.sizes, allowCheckRaise: true, preset: 'fast', mode: 'gto', iterations: 12000
  };
  const rD = solveCore(reqD);
  const recD = rD.focus.strategy.slice().sort((a, b) => b.freq - a.freq)[0];
  ok('GTO 深码 33 主推非全下', recD.type !== 'ALLIN', recD.label + ' ' + (recD.freq * 100).toFixed(0) + '%');
  ok('深码超底池全下不进入均衡动作集', !rD.actions.some(a => a.type === 'ALLIN'), rD.actions.map(a => a.label).join(' | '));
  const sameReq = { ...reqD, archetype: 'cs', intensity: 1.5 };
  const rSame = solveCore(sameReq);
  ok('GTO 结果不受无关画像参数影响（seed 口径）', Math.abs(rSame.focus.equityVsVillainRange - rD.focus.equityVsVillainRange) < 1e-9, rD.focus.equityVsVillainRange + ' vs ' + rSame.focus.equityVsVillainRange);
  const rE = solveCore({ ...reqD, mode: 'exploit', archetype: 'tp', intensity: 1, villainRangeLocked: true, iterations: 8000 });
  ok('剥削路线输出自身手牌条件策略', !!rE.focus && rE.focus.strategy.length === rE.actions.length);
  ok('剥削路线范围被锁定不放宽', rE.ranges.villainCombos <= rD.ranges.villainCombos, rD.ranges.villainCombos + '→' + rE.ranges.villainCombos);
  ok('剥削增益返回原始差值（不再截断为 0）', Number.isFinite(rE.exploitGainBB) && rE.lockedInfo.rangeClamped === true, 'gain=' + rE.exploitGainBB);

  // P2：盲注必须计入投入账户，后手不能再按全额买入计算
  const hBlind = parseHH(hhAK).hand, sBlind = deriveState(hBlind, 0);
  ok('Hero 为 BB 时后手 99 / 对手 SB 后手 99.5', near(sBlind.rem.hero, 99) && near(sBlind.rem.villain, 99.5), JSON.stringify(sBlind.rem));
  ok('盲注计入总投入且底池自洽', near(sBlind.totalInvest.hero, 1) && near(sBlind.totalInvest.villain, 0.5) && near(sBlind.pot, 1.5), JSON.stringify(sBlind.totalInvest));
}

console.log('\n[16] V1.14 收敛停止指标（NashConv，而非固定迭代次数）');
{
  ok('三档目标与预算齐备', CONVERGENCE_TARGETS.teaching.targetMbb === 50 && CONVERGENCE_TARGETS.daily.targetMbb === 1
    && CONVERGENCE_TARGETS.fine.targetMbb === 0.5 && CONVERGENCE_TARGETS.daily.maxIterations === 500000);
  ok('默认档为日常可靠 <1 mbb', resolveConvergence({}).quality === 'daily' && resolveConvergence({}).targetMbb === 1);
  ok('显式 targetMbb 覆盖档位目标', resolveConvergence({ quality: 'teaching', targetMbb: 200 }).targetMbb === 200);
  const rc = resolveConvergence({ quality: 'teaching', iterations: 15000 });
  ok('显式 iterations 只收紧预算、不改目标', rc.maxIterations === 15000 && rc.targetMbb === 50);

  const h = parseHH(HH_EXAMPLE).hand, idx = heroDecisionIndices(h)[0], st = deriveState(h, idx);
  const req = {
    board: st.board, heroCards: h.heroCards, villainCards: [], deadCards: [],
    heroRange: presetMatrix('btn'), villainRange: presetMatrix('bb'),
    pot: 10, stack: 90, facingBet: 0, heroOOP: false, oppChecked: true,
    sizes: h.sizes, allowCheckRaise: true, preset: 'fast', mode: 'gto', userAction: null
  };
  const infos = [];
  const rT = solveCore({ ...req, quality: 'teaching' }, (p, l, info) => { if (info) infos.push(info); });
  ok('教学档达到 <50 mbb 后提前停止', rT.converged === true && rT.exploitabilityMbb <= 50 && rT.iterations < rT.maxIterations,
    rT.exploitabilityMbb + ' mbb @ ' + rT.iterations + '/' + rT.maxIterations);
  ok('停止判据是可剥削度而非固定迭代', rT.iterations !== 20000 && rT.targetMbb === 50);
  ok('进度回调携带可剥削度与目标', infos.length > 0 && infos[infos.length - 1].exploitabilityMbb === rT.exploitabilityMbb && infos[infos.length - 1].targetMbb === 50);
  ok('结果含收敛档位与迭代预算', rT.quality === 'teaching' && rT.maxIterations === 20000 && Number.isFinite(rT.exploitabilityMbb));

  const rEarly = solveCore({ ...req, quality: 'daily', targetMbb: 200, iterations: 20000 });
  ok('放宽目标后更早停止', rEarly.converged && rEarly.iterations < rT.iterations, rEarly.iterations + ' < ' + rT.iterations);
  const rUnmet = solveCore({ ...req, quality: 'daily', targetMbb: 1, iterations: 8000 });
  ok('未达标时如实标记、不伪造收敛', rUnmet.converged === false && rUnmet.exploitabilityMbb > 1, rUnmet.exploitabilityMbb + ' mbb');
  const rExp = solveCore({ ...req, quality: 'teaching', mode: 'exploit', archetype: 'lag', intensity: 1 });
  ok('剥削模式保留 GTO 基线可剥削度并标注口径', rExp.exploitabilityMbb != null && rExp.nashConvScope === 'gto-reference' && rExp.targetMbb === 50);
  ok('收敛档位纳入求解缓存键', jobCacheKey(h, { quality: 'teaching', decisionIndex: idx }) !== jobCacheKey(h, { quality: 'daily', decisionIndex: idx }));
}

console.log('\n[16] V1.15 对手范围绝对宽度口径（位置对 × 风格 × 结构修正）');
{
  /* 锚点行：BTN 作为再加注方面对 EP 开池 → GTO 8~12%（中值 10%） */
  const anchorInfo = {
    tier: 3, openerPos: 'MP', responderPos: 'BTN',
    opener: { amountBB: 5.0 }, responderRaise: { amountBB: 13.0 }
  };
  const wAnchor = targetWidthPct(anchorInfo, { bb: 2, stackBB: 100, styleWidth: 1 });
  ok('锚点行 GTO 绝对宽度 = 10%（8~12% 中值）', near(wAnchor.pct, 10, 0.05), wAnchor.pct.toFixed(2) + '%');
  const wLag = targetWidthPct(anchorInfo, { bb: 2, stackBB: 100, styleWidth: 1.4 });
  const wTag = targetWidthPct(anchorInfo, { bb: 2, stackBB: 100, styleWidth: 0.7 });
  ok('锚点行风格倍率：LAG 14% / TAG 7%', near(wLag.pct, 14, 0.05) && near(wTag.pct, 7, 0.05),
    `lag=${wLag.pct.toFixed(2)}% tag=${wTag.pct.toFixed(2)}%`);
  ok('风格序：LAG > GTO > TAG', wLag.pct > wAnchor.pct && wAnchor.pct > wTag.pct);

  const optG = { mode: 'gto', archetype: 'tag', intensity: 1, stackBB: 100 };
  /* 位置序：同样的开池尺寸下，BB 面对 EP open 的 3bet 范围比面对 BTN open 更宽 */
  const mkBB = (heroPos) => ({
    stakes: { sb: 1, bb: 2 }, stackBB: 100,
    positions: { hero: heroPos, villain: 'BB' },
    actions: [
      { street: 'PREFLOP', type: 'RAISE_TO', amountBB: 5.0, actor: 'HERO' },
      { street: 'PREFLOP', type: 'RAISE_TO', amountBB: 13.0, actor: 'VILLAIN' }
    ],
    ranges: { hero: presetMatrix('btn'), villain: presetMatrix('bb') }
  });
  const vsEP = rangesForDecision(mkBB('MP'), 2, optG);
  const vsBTN = rangesForDecision(mkBB('BTN'), 2, optG);
  ok('位置序：BB 面对 EP open 的 3bet 范围更宽', vsEP.widthInfo.pct > vsBTN.widthInfo.pct,
    `EP=${vsEP.widthInfo.pct.toFixed(2)}% BTN=${vsBTN.widthInfo.pct.toFixed(2)}%`);
  ok('3bet 档识别正确（加注链第 2 位）', vsBTN.widthInfo.tier === '3bet' && vsBTN.widthInfo.chainIndex === 2, vsBTN.widthInfo.tier);
  ok('GTO 模式不套用画像宽度', near(vsBTN.widthInfo.styleWidth, 1, 1e-9));

  /* 对手是开池方时（Hero 再加注）：按其位置的开池宽度收窄，而不是用位置预设 */
  const mkOpen = (villainPos) => ({
    stakes: { sb: 1, bb: 2 }, stackBB: 100,
    positions: { hero: 'BTN', villain: villainPos },
    actions: [
      { street: 'PREFLOP', type: 'RAISE_TO', amountBB: 5.0, actor: 'VILLAIN' },
      { street: 'PREFLOP', type: 'RAISE_TO', amountBB: 13.0, actor: 'HERO' }
    ],
    ranges: { hero: presetMatrix('btn'), villain: presetMatrix('lag') }
  });
  const rOpenEP = rangesForDecision(mkOpen('MP'), 2, optG);
  const rOpenBTN = rangesForDecision(mkOpen('BTN'), 2, optG);
  ok('对手为开池方时按位置开池宽度收窄（EP 16.5% / BTN 42.5%）',
    rOpenEP.widthInfo.tier === '开池' && near(rOpenEP.widthInfo.pct, 16.5, 0.1) && near(rOpenBTN.widthInfo.pct, 42.5, 0.1),
    `EP=${rOpenEP.widthInfo.pct.toFixed(2)}% BTN=${rOpenBTN.widthInfo.pct.toFixed(2)}%`);

  /* 用户场景：BTN 33 面对 BB 3bet 到 12（100BB） */
  const HH33 = `# PokerGTO HH v1
Game: NLHE
Stakes: SB=1 BB=2
Table: 6max
Hero: BTN [3c3d]
Stacks: Hero=100 Villain=100 (BB)
Preflop:  BTN raise 3.5, BB raise 12.0`;
  const { hand: h33 } = parseHH(HH33);
  const idx33 = pendingHeroDecision(h33).index;
  const st33 = deriveState(h33, idx33);
  const rg33 = rangesForDecision(h33, idx33, { ...optG, stackBB: st33.rem.hero });
  ok('用户场景：对手 3bet 范围收窄到全范围 9%~15%（旧口径为 36.5%）',
    rg33.widthInfo.pct > 9 && rg33.widthInfo.pct < 15, rg33.widthInfo.pct.toFixed(2) + '%');
  ok('用户场景：派生范围组合数落在目标宽度附近',
    Math.abs(rg33.widthInfo.actualCombos / TOTAL_COMBOS * 100 - rg33.widthInfo.pct) < 1.5,
    `${rg33.widthInfo.actualCombos} 组合 / ${TOTAL_COMBOS}`);

  const req33 = {
    board: [], heroCards: h33.heroCards, villainCards: [], deadCards: [],
    heroRange: rg33.hero, villainRange: rg33.villain,
    villainRangeLocked: true, villainRangePreNarrowed: true,
    pot: st33.pot, stack: st33.stack, facingBet: st33.facingBet,
    sizes: h33.sizes, allowCheckRaise: h33.allowCheckRaise, preset: 'fast', mode: 'gto', iterations: 12000
  };
  const r33 = solveCore(req33);
  const aggr33 = r33.focus.strategy.filter(a => a.type === 'RAISE' || a.type === 'ALLIN');
  ok('用户场景：33 不再 100% 4bet / 全下', !aggr33.some(a => a.freq >= 0.9),
    aggr33.map(a => a.label + ' ' + (a.freq * 100).toFixed(1) + '%').join(', ') || '无激进攻略');
  ok('用户场景：33 权益不再虚高（旧口径 53.6%）', r33.focus.equityVsVillainRange < 0.45,
    (r33.focus.equityVsVillainRange * 100).toFixed(1) + '%');

  /* 深码 5bet：弱牌不得被推向全下 */
  const HHDeep = `# PokerGTO HH v1
Game: NLHE
Stakes: SB=1 BB=2
Table: 6max
Hero: BTN [3c3d]
Stacks: Hero=500 Villain=500 (BB)
Preflop:  BTN raise 3.5, BB raise 14.0, BTN raise 40.0, BB raise 132.0`;
  const { hand: hd } = parseHH(HHDeep);
  const idxd = pendingHeroDecision(hd).index;
  const std = deriveState(hd, idxd);
  const rgd = rangesForDecision(hd, idxd, { ...optG, stackBB: std.rem.hero });
  ok('深码场景识别为 5bet 档', rgd.widthInfo.tier === '5bet', rgd.widthInfo.tier);
  ok('深码 5bet 范围极窄（< 4% 全范围）', rgd.widthInfo.pct < 4, rgd.widthInfo.pct.toFixed(2) + '%');
  const rd = solveCore({
    board: [], heroCards: hd.heroCards, villainCards: [], deadCards: [],
    heroRange: rgd.hero, villainRange: rgd.villain,
    villainRangeLocked: true, villainRangePreNarrowed: true,
    pot: std.pot, stack: std.stack, facingBet: std.facingBet,
    sizes: hd.sizes, allowCheckRaise: hd.allowCheckRaise, preset: 'fast', mode: 'gto', iterations: 12000
  });
  const recd = rd.focus.strategy.slice().sort((a, b) => b.freq - a.freq)[0];
  ok('深码 5bet：33 不再推荐全下', recd.type !== 'ALLIN', recd.label + ' ' + (recd.freq * 100).toFixed(0) + '%');

  /* 管线：宽度已在派生层算好，求解器不得二次调整；派生不得写回已存范围 */
  ok('preNarrowed 时求解器不再二次调整宽度',
    applyArchetypeToRange(rg33.villain, ARCHETYPE_PARAMS.lag.width, 1, true, true) === rg33.villain);
  const snapBefore = JSON.stringify(h33.ranges.villain);
  rangesForDecision(h33, idx33, { mode: 'exploit', archetype: 'lag', intensity: 1.5, stackBB: 100 });
  ok('派生范围不写回已存 hand.ranges', JSON.stringify(h33.ranges.villain) === snapBefore);
  ok('画像宽度倍率随强度插值', near(archetypeWidth('lag', 1.5), 1.6, 1e-9) && near(archetypeWidth('tag', 0.5), 0.85, 1e-9));
}

/* ==================== [17] V1.16 范围条件化收益：隐含赔率 + 诈唬捕捉价值 ==================== */
{
  const HH = `# PokerGTO HH v1
Game: NLHE
Stakes: SB=1 BB=2
Table: 6max
Hero: BTN [Kc4d]
Stacks: Hero=100 Villain=100 (BB)
Preflop:  BTN raise 2.7, BB raise 8.8, BTN call 6.1
Flop: [Kh7s2c]  BB bet 8.8`;
  const { hand: h16 } = parseHH(HH);
  const idx16 = pendingHeroDecision(h16).index;
  const s16 = deriveState(h16, idx16);
  ok('[V1.16] K4 场景解析零错误且决策点在翻后', idx16 === 4 && s16.street === 'FLOP' && s16.pot > 0);

  const solve16 = (mode, archetype, intensity = 1) => {
    const rg = rangesForDecision(h16, idx16, { mode, archetype, intensity, stackBB: s16.rem.hero });
    return solveCore({
      board: s16.board, heroCards: h16.heroCards, villainCards: [], deadCards: [],
      heroRange: rg.hero, villainRange: rg.villain,
      villainRangeLocked: rg.villainLevel > 0, villainRangePreNarrowed: rg.widthInfo != null,
      pot: s16.pot, stack: s16.stack, facingBet: s16.facingBet,
      heroOOP: s16.heroOOP, oppChecked: s16.oppChecked,
      sizes: h16.sizes, allowCheckRaise: h16.allowCheckRaise, preset: 'fast',
      mode, archetype, intensity, iterations: 20000
    });
  };
  const g16 = solve16('gto', 'tag');
  const lag16 = solve16('exploit', 'lag');
  const tag16 = solve16('exploit', 'tag');

  /* 核心：100% raise 消失，call 成为主推荐 */
  const top16 = r => r.focus.strategy.slice().sort((a, b) => b.freq - a.freq)[0];
  const callFreq = r => (r.focus.strategy.find(a => a.type === 'CALL') || { freq: 0 }).freq;
  const maxRaise16 = r => Math.max(0, ...r.focus.strategy.filter(a => a.type === 'RAISE' || a.type === 'ALLIN').map(a => a.freq));
  ok('[V1.16] GTO 不再 100% raise', maxRaise16(g16) < 0.6, 'maxRaise=' + (maxRaise16(g16) * 100).toFixed(0) + '%');
  ok('[V1.16] GTO 跟注占比 > 30%', callFreq(g16) > 0.3, (callFreq(g16) * 100).toFixed(0) + '%');
  ok('[V1.16] GTO 最优动作为跟注', g16.focus.conditional && g16.focus.conditional.bestLabel.includes('跟注'), g16.focus.conditional && g16.focus.conditional.bestLabel);

  /* 范围条件化：call 范围权益 ≥ raise 被跟注范围权益 */
  for (const [nm, rr] of [['GTO', g16], ['LAG', lag16], ['TAG', tag16]]) {
    const c = rr.focus.conditional;
    ok(`[V1.16] ${nm} 存在条件化收益`, !!c && Number.isFinite(c.eqCall) && Number.isFinite(c.eqCont));
    if (c) {
      ok(`[V1.16] ${nm} 下注范围权益 ≥ 跟注范围权益`, c.eqCall >= c.eqCont - 0.02, c.eqCall + ' vs ' + c.eqCont);
      ok(`[V1.16] ${nm} 隐含赔率非负且量级合理`, c.impliedBB >= 0 && c.impliedBB < 10, c.impliedBB + ' BB');
    }
  }

  /* 画像分化：TAG 范围更紧 → K4 对下注范围权益显著低于 LAG（诈唬价值） */
  ok('[V1.16] TAG 下注范围权益 < LAG（紧范围权益更小）',
    tag16.focus.conditional.eqCall < lag16.focus.conditional.eqCall - 0.05,
    `tag=${tag16.focus.conditional.eqCall} lag=${lag16.focus.conditional.eqCall}`);
  ok('[V1.16] LAG 跟注占比 ≥ GTO（诈唬捕捉价值更高）', callFreq(lag16) >= callFreq(g16) - 0.05,
    `lag=${(callFreq(lag16) * 100).toFixed(0)}% gto=${(callFreq(g16) * 100).toFixed(0)}%`);

  /* 参数源：GTO 固定平衡值，画像各不同，且本次新增字段不改变既有 width */
  ok('[V1.16] GTO 条件化参数为固定平衡值', near(rangeConditionParams('gto', 'lag').betValueFrac, GTO_RANGE_CONDITION.betValueFrac, 1e-9));
  ok('[V1.16] LAG 诈唬占比 > TAG', rangeConditionParams('exploit', 'lag').betBluffFrac > rangeConditionParams('exploit', 'tag').betBluffFrac);
  ok('[V1.16] 既有画像 width 未被改动', near(ARCHETYPE_PARAMS.lag.width, 1.4, 1e-9) && near(ARCHETYPE_PARAMS.tag.width, 0.7, 1e-9));
  ok('[V1.16] 结果携带条件化口径', g16.rangeCondition && g16.convergenceNote.includes('条件化') && g16.convergenceNote.includes('隐含赔率'));

  /* 翻前不受影响：翻前路径不产生 conditional（范围条件化仅翻后启用） */
  const pre16Hand = {
    heroCards: [parseCard('3c'), parseCard('3d')], board: [],
    positions: { hero: 'BTN', villain: 'BB' }, sizes: [0.33, 0.67, 1]
  };
  const pre16 = solveCore({
    board: [], heroCards: pre16Hand.heroCards, villainCards: [], deadCards: [],
    heroRange: presetMatrix('btn'), villainRange: presetMatrix('bb'),
    pot: 15.5, stack: 96.5, facingBet: 8.5, sizes: pre16Hand.sizes, allowCheckRaise: true,
    preset: 'fast', mode: 'gto', iterations: 8000
  });
  ok('[V1.16] 翻前路径不产生 conditional（无范围条件化）', !pre16.focus.conditional);
}

/* ==================== [18] V1.17 翻前/翻后弃牌解耦 + 被跟注范围价值子集 + 跨街极化 ==================== */
{
  const HH = `# PokerGTO HH v1
Game: NLHE
Stakes: SB=1 BB=2
Table: 6max
Hero: BTN [Kc4d]
Stacks: Hero=100 Villain=100 (BB)
Preflop:  BTN raise 2.7, BB raise 8.8, BTN call 6.1
Flop: [Kh7s2c]  BB bet 8.8`;
  const { hand: h17 } = parseHH(HH);
  const idx17 = pendingHeroDecision(h17).index;
  const s17 = deriveState(h17, idx17);
  const solve17 = (mode, archetype, intensity = 1) => {
    const rg = rangesForDecision(h17, idx17, { mode, archetype, intensity, stackBB: s17.rem.hero });
    return solveCore({
      board: s17.board, heroCards: h17.heroCards, villainCards: [], deadCards: [],
      heroRange: rg.hero, villainRange: rg.villain,
      villainRangeLocked: rg.villainLevel > 0, villainRangePreNarrowed: rg.widthInfo != null,
      pot: s17.pot, stack: s17.stack, facingBet: s17.facingBet,
      heroOOP: s17.heroOOP, oppChecked: s17.oppChecked,
      sizes: h17.sizes, allowCheckRaise: h17.allowCheckRaise, preset: 'fast',
      mode, archetype, intensity, iterations: 20000
    });
  };
  const g17 = solve17('gto', 'tag');
  const lag17 = solve17('exploit', 'lag');
  const tag17 = solve17('exploit', 'tag');

  /* 核心 1：TAG 加注全部负 EV，跟注为唯一正 EV 动作（用户「TAG 加注是负 EV」结论） */
  const condEv = (r, type) => {
    const i = r.focus.strategy.findIndex(a => a.type === type);
    return i >= 0 ? r.focus.conditional.evs[i] : null;
  };
  const callEvTAG = condEv(tag17, 'CALL');
  const raiseEvsTAG = tag17.focus.conditional.evs.filter((_, i) =>
    ['RAISE', 'ALLIN'].includes(tag17.focus.strategy[i].type));
  ok('[V1.17] TAG 跟注 EV 为正', callEvTAG > 0, callEvTAG + ' BB');
  ok('[V1.17] TAG 所有加注 EV 为负（造池不再必杀）', raiseEvsTAG.length > 0 && raiseEvsTAG.every(v => v < 0),
    raiseEvsTAG.join(','));
  const raiseEvLAG = condEv(lag17, 'RAISE');
  ok('[V1.17] LAG 小尺度加注 EV 显著优于 TAG（诈唬多+弃牌率高）',
    raiseEvLAG > Math.max(...raiseEvsTAG) + 5, `lag=${raiseEvLAG} tag=${Math.max(...raiseEvsTAG)}`);

  /* 核心 2：翻前/翻后弃牌方向解耦 —— TAG 翻前高弃/翻后低弃，LAG 相反 */
  ok('[V1.17] TAG 翻前高弃牌、翻后低弃牌（方向翻转）',
    foldToRaiseByStreet('tag', false) > 0 && foldToRaiseByStreet('tag', true) < 0,
    `pre=${foldToRaiseByStreet('tag', false)} post=${foldToRaiseByStreet('tag', true)}`);
  ok('[V1.17] LAG 翻前低弃牌、翻后高弃牌（方向与 TAG 相反）',
    foldToRaiseByStreet('lag', false) < 0 && foldToRaiseByStreet('lag', true) > 0,
    `pre=${foldToRaiseByStreet('lag', false)} post=${foldToRaiseByStreet('lag', true)}`);
  ok('[V1.17] 翻后 TAG 弃牌修正 < LAG（强范围少弃 vs 空气多弃）',
    foldToRaiseByStreet('tag', true) < foldToRaiseByStreet('lag', true));

  /* 核心 3：弃牌率与被跟注强度解耦 —— TAG 弃牌率低(foldP 小) 但被跟注范围极强(eqCont 极低) */
  const cTAG = tag17.focus.conditional, cLAG = lag17.focus.conditional;
  ok('[V1.17] TAG 翻后弃牌率低（foldP 小，加注打不走）', cTAG.foldP < 0.25, 'foldP=' + cTAG.foldP);
  ok('[V1.17] LAG 翻后弃牌率高（foldP 大，一加就跑）', cLAG.foldP > 0.6, 'foldP=' + cLAG.foldP);
  ok('[V1.17] TAG 被跟注范围强度远弱于 LAG（eqCont 更低）', cTAG.eqCont < cLAG.eqCont - 0.1,
    `tag=${cTAG.eqCont} lag=${cLAG.eqCont}`);
  ok('[V1.17] TAG 极化度显著高于 LAG（价值/诈唬比）',
    cTAG.polarization > cLAG.polarization * 3, `tag=${cTAG.polarization} lag=${cLAG.polarization}`);

  /* 核心 4：跨街逐步收窄与极化（连打三条街范围更极化） */
  const tagRC = rangeConditionParams('exploit', 'tag', 1);
  const flop = streetAdjustedRangeCondition(tagRC, 3);
  const turn = streetAdjustedRangeCondition(tagRC, 4);
  const river = streetAdjustedRangeCondition(tagRC, 5);
  ok('[V1.17] 诈唬占比逐街递减', flop.betBluffFrac > turn.betBluffFrac && turn.betBluffFrac > river.betBluffFrac,
    [flop.betBluffFrac, turn.betBluffFrac, river.betBluffFrac].join('>'));
  ok('[V1.17] 被跟注范围逐街收窄（contTopFrac 递减）',
    flop.contTopFrac > turn.contTopFrac && turn.contTopFrac > river.contTopFrac,
    [flop.contTopFrac, turn.contTopFrac, river.contTopFrac].join('>'));
  ok('[V1.17] 极化度逐街递增（连打三条街更极化）',
    flop.polarization < turn.polarization && turn.polarization < river.polarization,
    [flop.polarization, turn.polarization, river.polarization].join('<'));
  const gtoRC = rangeConditionParams('gto', 'tag', 1);
  const gtoFlop = streetAdjustedRangeCondition(gtoRC, 3), gtoRiver = streetAdjustedRangeCondition(gtoRC, 5);
  ok('[V1.17] GTO 跨街不漂移（平衡口径稳定）',
    near(gtoFlop.polarization, gtoRiver.polarization) && near(gtoFlop.contTopFrac, gtoRiver.contTopFrac));

  /* 核心 5：GTO seed 不漂移（结构改造不得改变 GTO 结果） */
  ok('[V1.17] GTO eqCall 稳定在 V1.16 口径', near(g17.focus.conditional.eqCall, 0.645, 0.01),
    'eqCall=' + g17.focus.conditional.eqCall);
  ok('[V1.17] 结果携带解耦诊断字段', cTAG.foldP != null && cTAG.contTopFrac != null && cTAG.streetSteps != null);
  ok('[V1.17] continueValueFrac 不被 intensity 放大（保护被跟注范围上限）',
    near(rangeConditionParams('exploit', 'tag', 1.5).continueValueFrac,
         rangeConditionParams('exploit', 'tag', 0.5).continueValueFrac));
}

/* ==================== [19] V1.18 河牌教学拆解 + 策略分区热力图 ==================== */
{
  const HH = `# PokerGTO HH v1
Game: NLHE
Stakes: SB=1 BB=2
Table: 6max
Hero: BTN [Kc4d]
Stacks: Hero=100 Villain=100 (BB)
Preflop:  BTN raise 2.7, BB raise 8.8, BTN call 6.1
Flop: [Kh7s2c]  BB bet 8.8, BTN raise 20.4, BB call 11.6
Turn: [Kh7s2cTs]  BB check, BTN check
River: [Kh7s2cTsAc]  BB bet 39.1`;
  const { hand: h18 } = parseHH(HH);
  const idx = pendingHeroDecision(h18).index;
  const st = deriveState(h18, idx);
  ok('[V1.18] 河牌决策点解析正确（index/pot/facing）',
    idx === 9 && st.street === 'RIVER' && Math.abs(st.pot - 97.5) < 0.2 && Math.abs(st.facingBet - 39.1) < 0.01);
  const solve18 = (mode, archetype, iters = 20000) => {
    const rg = rangesForDecision(h18, idx, { mode, archetype, intensity: 1, stackBB: st.rem.hero });
    return solveCore({
      board: st.board, heroCards: h18.heroCards, villainCards: [], deadCards: [],
      heroRange: rg.hero, villainRange: rg.villain,
      villainRangeLocked: rg.villainLevel > 0, villainRangePreNarrowed: rg.widthInfo != null,
      pot: st.pot, stack: st.stack, facingBet: st.facingBet,
      heroOOP: st.heroOOP, oppChecked: st.oppChecked,
      sizes: h18.sizes, allowCheckRaise: h18.allowCheckRaise, preset: 'fast',
      mode, archetype, intensity: 1, iterations: iters
    });
  };
  const g18 = solve18('gto', 'tag');
  const L = g18.lesson;
  ok('[V1.18] GTO Kc4d 约 95% 跟注（老大给定 95/5 口径）',
    Math.abs((g18.focus.strategy.find(a => a.type === 'CALL')?.freq || 0) - 0.95) < 0.08,
    'call=' + ((g18.focus.strategy.find(a => a.type === 'CALL')?.freq || 0) * 100).toFixed(1) + '%');
  ok('[V1.18] 手牌权益约 30%（老大给定口径）',
    L && Math.abs(L.heroEquity - 0.30) < 0.06, 'eq=' + (L && L.heroEquity));
  ok('[V1.18] lesson 赔率/门槛/MDF 自洽',
    L && near(L.needPct, 39.1 / (97.5 + 39.1), 1e-3) && near(L.mdf, 97.5 / (97.5 + 39.1), 1e-3) && near(L.needPct + L.mdf, 1, 1e-6));
  ok('[V1.18] 权益高于抓诈门槛 → bluffCatchOk', L && L.bluffCatchOk === true && L.heroEquity >= L.needPct);
  ok('[V1.18] 价值区/诈唬区按权益切分且价值权益更高',
    L && L.value.length > 0 && L.bluff.length > 0 && L.value[0].eq > L.bluff[0].eq,
    'valTop=' + (L && L.value[0].label + ':' + L.value[0].eq) + ' bluffTop=' + (L && L.bluff[0].label + ':' + L.bluff[0].eq));
  ok('[V1.18] QJs 在 A-K-T 河牌是顺子价值（真实权益 > 0.9），非诈唬',
    L && L.value.some(g => g.label === 'QJs' && g.eq > 0.9) && !L.bluff.some(g => g.label === 'QJs'));
  ok('[V1.18] 教学组合带完整花色示例', L && L.value[0].examples.length > 0 && /^[2-9TJQKA][cdhs][2-9TJQKA][cdhs]$/.test(L.value[0].examples[0]), 'ex=' + (L && L.value[0].examples[0]));
  const sh = g18.heatmap.strategy && g18.heatmap.strategy.hero;
  ok('[V1.18] 策略热力图为 13×13 且每格有三路频率',
    sh && sh.length === 13 && sh[0].length === 13 && sh[11][1] && sh[11][1].fold != null && sh[11][1].call != null && sh[11][1].raise != null);
  const cells = [];
  for (let i = 0; i < 13; i++) for (let j = 0; j < 13; j++) if (sh && sh[i][j]) cells.push(sh[i][j]);
  ok('[V1.18] 每格三路频率合计≈100%',
    cells.every(c => Math.abs(c.fold + c.call + c.raise - 1) < 0.02), 'cells=' + cells.length);
  ok('[V1.18] 每格标主策略与混合标记', cells.every(c => ['fold', 'call', 'raise'].includes(c.main) && typeof c.mix === 'boolean'));
  ok('[V1.18] 每格带完整花色组合', cells.every(c => Array.isArray(c.cards) && c.cards.length > 0));
  ok('[V1.18] 剥削档 lesson/strategy 随画像更新', (() => {
    const tag18 = solve18('exploit', 'tag'), lag18 = solve18('exploit', 'lag');
    return tag18.lesson && lag18.lesson
      && tag18.lesson.polarization > lag18.lesson.polarization
      && tag18.heatmap.strategy.gto.length === 13;
  })());
  // V1.18.1 口径回归：剥削档必须用「对下注范围」权益(eqCall)，不得用全范围权益。
  // 实测 TAG：全范围 35.3% 虚高，但 eqCall 2.6% < 门槛 28.6% → 应弃牌。
  ok('[V1.18.1] 剥削 TAG 权益用下注范围口径（非全范围）且判为不达标', (() => {
    const t = solve18('exploit', 'tag');
    const L = t.lesson, c = t.focus.conditional;
    return L && c && L.heroEquity === c.eqCall && L.heroEquityAllRange > L.needPct
      && L.heroEquity < L.needPct && L.bluffCatchOk === false
      && (t.focus.strategy.find(a => a.type === 'FOLD')?.freq || 0) > 0.5;
  })());
  ok('[V1.18.1] GTO 档两口径一致（下注范围=全范围）', (() => {
    return L.heroEquityAllRange != null && near(L.heroEquity, L.heroEquityAllRange, 0.02);
  })());
  ok('[V1.18] 翻前/翻牌场景不生成 lesson（仅河牌）', (() => {
    const HH2 = `# PokerGTO HH v1\nGame: NLHE\nStakes: SB=1 BB=2\nTable: 6max\nHero: BTN [Kc4d]\nStacks: Hero=100 Villain=100 (BB)\nPreflop:  BTN raise 2.7, BB raise 8.8, BTN call 6.1\nFlop: [Kh7s2c]  BB bet 8.8`;
    const h2 = parseHH(HH2).hand, i2 = pendingHeroDecision(h2).index, s2 = deriveState(h2, i2);
    const rg2 = rangesForDecision(h2, i2, { mode: 'gto', intensity: 1, stackBB: s2.rem.hero });
    const r2 = solveCore({ board: s2.board, heroCards: h2.heroCards, villainCards: [], deadCards: [], heroRange: rg2.hero, villainRange: rg2.villain,
      villainRangeLocked: rg2.villainLevel > 0, villainRangePreNarrowed: rg2.widthInfo != null, pot: s2.pot, stack: s2.stack, facingBet: s2.facingBet,
      heroOOP: s2.heroOOP, oppChecked: s2.oppChecked, sizes: h2.sizes, allowCheckRaise: h2.allowCheckRaise, preset: 'fast', mode: 'gto', iterations: 8000 });
    return r2.lesson === null;
  })());
}

console.log('\n[20] V1.19 图形化频率展示与花色下钻');
{
  ok('[V1.19] 动作归类：弃/跟/加三色口径', actionKind({ type: 'FOLD' }) === 'fold'
    && actionKind({ type: 'CALL' }) === 'call' && actionKind({ type: 'CHECK' }) === 'call'
    && actionKind({ type: 'BET' }) === 'raise' && actionKind({ type: 'RAISE' }) === 'raise'
    && actionKind({ type: 'ALLIN' }) === 'raise');
  const acts = [
    { type: 'FOLD', label: '弃牌', freq: 0.2 },
    { type: 'CALL', label: '跟注', freq: 0.3 },
    { type: 'RAISE', label: '加注至 12.0 BB', freq: 0.5 }
  ];
  const focus = { strategy: [{ freq: 0.1 }, { freq: 0.6 }, { freq: 0.3 }] };
  const items = freqItems(acts, focus);
  ok('[V1.19] 频率项携带全范围与手牌级双口径', items.length === 3
    && items[0].freq === 0.2 && items[0].focusFreq === 0.1 && items[2].kind === 'raise');
  ok('[V1.19] 三路汇总等于 1', (() => { const t = threeWay(items); return near(t.fold + t.call + t.raise, 1); })());

  // 13×13 类别索引：i===j 对子 / i>j 同花 / i<j 非同花
  ok('[V1.19] 对子 6 种花色组合', comboCodesForClass(12, 12).length === 6);
  ok('[V1.19] 同花 4 种花色组合', comboCodesForClass(12, 5).length === 4);
  ok('[V1.19] 非同花 12 种花色组合', comboCodesForClass(5, 12).length === 12);
  const blocked = comboCodesForClass(12, 5, ['As']);
  ok('[V1.19] 公共牌阻挡的组合被剔除', blocked.length === 3 && blocked.every(x => !x.startsWith('As')));
  ok('[V1.19] 组合码忽略牌序便于比对', comboKey('6cAc') === comboKey('Ac6c'));

  const overview = freqOverviewHtml(items, items);
  ok('[V1.19] 总览含全范围/你的手牌两行 + 可点击色块',
    /全范围/.test(overview) && /你的手牌/.test(overview) && (overview.match(/data-act="freqAction"/g) || []).length === 6);
  ok('[V1.19] 总览标注最高/最低与高低差', /最高/.test(overview) && /最低非零/.test(overview) && /高低差/.test(overview));

  const cell = { fold: 0.2, call: 0.55, raise: 0.25, main: 'call', mix: true, n: 4, cards: ['Ac6c', 'Ad6d', 'Ah6h', 'As6s'] };
  const detail = freqCellHtml({
    label: 'A6s', cell, items,
    combos: comboCodesForClass(12, 4, ['Kh', '7s', '2c']),
    focusCode: 'Ac6c', mode: 'gto'
  });
  ok('[V1.19] 花色详情列出完整花色符号', /A♣|A♦|A♥|A♠/.test(detail) && (detail.match(/class="fd-combo[\s"]/g) || []).length === 4);
  ok('[V1.19] 你的手牌组合有高亮与手牌级频率', /is-focus/.test(detail) && /你的手牌/.test(detail));
  ok('[V1.19] 剥削档详情并排给出 GTO 基线', /GTO 基线/.test(freqCellHtml({ label: 'A6s', cell, gtoCell: cell, combos: [], mode: 'exploit' })));

  const actionDetail = freqActionHtml({ kind: 'call', rows: [{ i: 12, j: 5, label: 'A6s', cell, freq: 0.55 }], title: 'GTO 均衡' });
  ok('[V1.19] 动作详情可继续下钻到手牌类别', /data-act="freqCell"/.test(actionDetail) && /A6s/.test(actionDetail));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
if (fail) process.exit(1);
