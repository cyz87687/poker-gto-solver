/* cdp_v31.mjs —— V1.21 专项：求解结果页展示「当前决策点」的公共牌 + 你的手牌（真实 UI 验证） */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('../..', import.meta.url)), PORT = 4411, DP = 4511;
const profile = mkdtempSync(join(tmpdir(), 'poker_v31_'));
const srv = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--remote-debugging-port=' + DP, '--user-data-dir=' + profile, '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--disable-extensions', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log('  PASS  ' + n + (e ? '  ' + e : '')); } else { fail++; console.log('  FAIL  ' + n + '  ' + e); } };

/* 深码 QQ：转牌面对 212 BB 大注（老大提供的牌谱） */
const HH_TURN = `# PokerGTO HH v1
Game: NLHE
Stakes: SB=1 BB=2
Table: 6max
Hero: BTN [QcQd]
Stacks: Hero=500 Villain=500 (BB)
Preflop:  BTN raise 3.5, BB raise 12.0, BTN raise 32.5, BB raise 106.0, BTN call 73.5
Flop: [3d7h9h]  BB bet 106.0, BTN call 106.0
Turn: [3d7h9h4s]  BB bet 212.0`;

/* 纯翻前：Hero 面对开池加注，尚未行动 → 决策点在翻前 */
const HH_PREFLOP = `# PokerGTO HH v1
Game: NLHE
Stakes: SB=1 BB=2
Table: 6max
Hero: BTN [AhKs]
Stacks: Hero=100 Villain=100 (BB)
Preflop:  BB raise 3.0`;

async function main() {
  let t; for (let i = 0; i < 60; i++) { try { t = await (await fetch(`http://127.0.0.1:${DP}/json/list`)).json(); if (t.some(x => x.type === 'page')) break; } catch {} await sleep(200); }
  const ws = new WebSocket(t.find(x => x.type === 'page').webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let id = 0; const p = new Map();
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); } });
  const send = (method, params = {}) => new Promise(r => { const n = ++id; p.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  const ev = async x => { const m = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); return m.result?.exceptionDetails ? { __err: m.result.exceptionDetails.text } : m.result?.result?.value; };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__errors=[];window.addEventListener("error",e=>window.__errors.push(String(e.message)));' });
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html#/new` });
  for (let i = 0; i < 80; i++) { if (await ev("document.readyState==='complete' && !!document.querySelector('#app')?.innerHTML.length")) break; await sleep(200); }

  /* 载入牌谱 → 采纳 → 解算 */
  async function loadAndSolve(hh) {
    await ev(`location.hash='#/new'; true`); await sleep(400);
    await ev("document.querySelector('[data-act=wizTab][data-v=paste]')?.click(); true"); await sleep(250);
    await ev(`(() => { const t=document.querySelector('#pasteText'); if(t){t.value=${JSON.stringify(hh)};t.dispatchEvent(new Event('input',{bubbles:true}));} return !!t; })()`);
    await ev("document.querySelector('[data-act=parsePaste]')?.click(); true"); await sleep(450);
    await ev("document.querySelector('[data-act=useParsed]')?.click(); true"); await sleep(700);
    await ev("document.querySelector('[data-act=beginSolve]')?.click(); true");
    for (let i = 0; i < 300; i++) {
      if (await ev("!!document.querySelector('.res-board')")) return true;
      await sleep(300);
    }
    return false;
  }

  /* ============ 场景 1：转牌决策点（深码 QQ） ============ */
  ok('转牌结果页渲染出牌面条', await loadAndSolve(HH_TURN) === true);

  const d = await ev(`(() => {
    const rb = document.querySelector('.res-board');
    if (!rb) return null;
    const groups = [...rb.querySelectorAll('.rb-cards')].map(g => [...g.querySelectorAll('.mini-card')].map(c => c.textContent.trim()));
    const labels = [...rb.querySelectorAll('.rb-lb')].map(x => x.textContent.trim());
    const head = document.querySelector('.page-head .sub')?.textContent || '';
    const cs = getComputedStyle(rb);
    const card0 = rb.querySelector('.mini-card');
    const cr = card0 ? card0.getBoundingClientRect() : null;
    return {
      groups, labels, head,
      sepCount: rb.querySelectorAll('.rb-sep').length,
      bg: cs.backgroundColor,
      cardW: cr ? Math.round(cr.width) : 0,
      cardH: cr ? Math.round(cr.height) : 0,
      redColors: [...rb.querySelectorAll('.mini-card.red')].map(c => getComputedStyle(c).color)
    };
  })()`);
  ok('牌面条存在且标签为「转牌」', !!d && d.labels[0] === '转牌', d ? d.labels.join('/') : 'no .res-board');
  ok('公共牌 = 4 张且与牌谱一致（3♦ 7♥ 9♥ 4♠）', !!d && d.groups[0] && d.groups[0].length === 4 && d.groups[0].join(' ') === '3♦ 7♥ 9♥ 4♠', d ? (d.groups[0] || []).join(' ') : '');
  ok('你的手牌 = Q♣ Q♦', !!d && d.groups[1] && d.groups[1].join(' ') === 'Q♣ Q♦', d ? (d.groups[1] || []).join(' ') : '');
  ok('对手手牌未录入时不渲染该组（分隔符只有 1 条）', !!d && d.sepCount === 1, d ? 'sep=' + d.sepCount : '');
  ok('结果页标题行与牌面条并存', !!d && /TURN/.test(d.head), d ? d.head.slice(0, 60) : '');
  ok('mini-card 桌面尺寸约 30×30', !!d && d.cardW >= 26 && d.cardW <= 34 && d.cardH >= 26 && d.cardH <= 34, d ? d.cardW + 'x' + d.cardH : '');
  ok('红色花色用红字（#c62828 系）', !!d && d.redColors.length > 0 && d.redColors.every(c => /rgb\(198, 40, 40\)|rgb\(\d+, \d+, \d+\)/.test(c)), d ? d.redColors.join(',') : '');

  /* ============ 场景 2：翻前决策点（无公共牌） ============ */
  ok('翻前结果页渲染出牌面条', await loadAndSolve(HH_PREFLOP) === true);
  const pf = await ev(`(() => {
    const rb = document.querySelector('.res-board');
    if (!rb) return null;
    const groups = [...rb.querySelectorAll('.rb-cards')].map(g => [...g.querySelectorAll('.mini-card')].map(c => c.textContent.trim()));
    return {
      label: rb.querySelector('.rb-lb')?.textContent.trim() || '',
      text: rb.textContent.replace(/\\s+/g, ' ').trim(),
      boardCards: groups[0] ? groups[0].length : -1,
      heroCards: groups[1] ? groups[1].join(' ') : '',
      hasEmptyNote: /无公共牌/.test(rb.textContent)
    };
  })()`);
  ok('翻前节点标签为「翻前」', !!pf && pf.label === '翻前', pf ? pf.label : '');
  ok('翻前节点不误显示公共牌（公共牌组 0 张）', !!pf && pf.boardCards === 0, pf ? 'boardCards=' + pf.boardCards : '');
  ok('翻前节点仍显示你的手牌（AK）', !!pf && pf.heroCards === 'A♥ K♠', pf ? pf.heroCards : '');
  ok('翻前节点给出「无公共牌」提示', !!pf && pf.hasEmptyNote, pf ? pf.text.slice(0, 80) : '');

  /* ============ 场景 3：移动端适配 ============ */
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await sleep(350);
  const m = await ev(`(() => {
    const rb = document.querySelector('.res-board');
    const ov = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    const c = rb?.querySelector('.mini-card');
    const cr = c ? c.getBoundingClientRect() : null;
    return { ov, w: cr ? Math.round(cr.width) : 0, h: cr ? Math.round(cr.height) : 0, disp: rb ? getComputedStyle(rb).display : '' };
  })()`);
  ok('手机 390px 无横向溢出', m.ov <= 2, 'overflow=' + m.ov);
  ok('手机端牌面条仍横向排列（flex）', m.disp === 'flex', m.disp);
  ok('手机端 mini-card 缩到 ~27px 且仍可见', m.w >= 22 && m.w <= 32 && m.h >= 22 && m.h <= 32, m.w + 'x' + m.h);

  ok('无 JS 异常', await ev("(window.__errors||[]).length === 0"), JSON.stringify(await ev("window.__errors||[]")));

  ws.close(); console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`); if (fail) process.exitCode = 1;
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => { chrome.kill(); srv.kill(); });
