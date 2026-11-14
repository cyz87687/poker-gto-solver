/* selftest.mjs —— 纯逻辑自测（Node 运行：npm test / node tests/selftest.mjs） */
import {
  parseCard, cardStr, eval7, presetMatrix, emptyMatrix, matrixToCombos,
  comboEquityVsRange, mulberry32, applyRangeWidth
} from '../js/cards.js';
import {
  parseHH, validateHand, deriveState, serializeHH, defaultHand, heroDecisionIndices,
  handProfitBB, handClass, positionsFor, parseActionText, normalizeActionAmounts,
  postflopOrder, firstToActPostflop, heroIsOOP, solveReadiness
} from '../js/hand.js';
import { solveCore, previewCore, ARCHETYPE_PARAMS } from '../js/solver-core.js';
import {
  initDB, state, commit, upsertSession, upsertHand, sessionNet, computeStats,
  escapeHtml, exportJSON, importJSON, exportSessionsCSV
} from '../js/db.js';

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
  ok('空牌谱列出缺失项', r0.items.filter(x => !x.ok).length >= 2, JSON.stringify(r0.items.filter(x => !x.ok).map(x => x.key)));
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

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
if (fail) process.exit(1);
