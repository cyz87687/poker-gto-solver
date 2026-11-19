/* cdp_v29.mjs —— V1.19 专项：图形化频率总览 + 点击下钻花色组合（真实 UI 验证） */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('../..', import.meta.url)), PORT = 4409, DP = 4509;
const profile = mkdtempSync(join(tmpdir(), 'poker_v29_'));
const srv = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--remote-debugging-port=' + DP, '--user-data-dir=' + profile, '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--disable-extensions', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log('  PASS  ' + n + (e ? '  ' + e : '')); } else { fail++; console.log('  FAIL  ' + n + '  ' + e); } };

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

  await ev("document.querySelector('[data-act=wizTab][data-v=paste]')?.click(); true"); await sleep(250);
  await ev(`(() => { const t=document.querySelector('#pasteText'); if(t){t.value=${JSON.stringify(HH)};t.dispatchEvent(new Event('input',{bubbles:true}));} return !!t; })()`);
  await ev("document.querySelector('[data-act=parsePaste]')?.click(); true"); await sleep(400);
  await ev("document.querySelector('[data-act=useParsed]')?.click(); true"); await sleep(600);
  await ev("document.querySelector('[data-act=beginSolve]')?.click(); true");
  let ready = false;
  for (let i = 0; i < 240; i++) {
    ready = await ev("!!document.querySelector('.freq-panel') && !!document.querySelector('#heatHero .strat-grid')");
    if (ready) break;
    await sleep(300);
  }
  ok('结果页渲染频率总览与策略网格', ready === true);

  const d = await ev(`({
    scopes: [...document.querySelectorAll('.freq-scope > b')].map(x=>x.textContent.trim()),
    tiles: document.querySelectorAll('.freq-tile').length,
    badges: [...document.querySelectorAll('.ft-badge')].map(x=>x.textContent.trim()),
    summary: document.querySelector('.freq-summary')?.textContent||'',
    segs: document.querySelectorAll('.freq-panel .fd-seg').length,
    widthSum: [...document.querySelectorAll('.freq-panel .freq-scope')].map(row=>[...row.nextElementSibling?.querySelectorAll('.fd-seg')||[]].reduce((s,x)=>s+parseFloat(x.style.width),0).toFixed(1)),
    clickableCells: document.querySelectorAll('#heatHero .strat-grid .cell[data-act=freqCell]').length,
    tileInfo: [...document.querySelectorAll('.freq-tile')].map(x=>x.dataset.kind+':'+x.querySelector('.ft-label').textContent+':'+x.querySelector('.ft-pct').textContent)
  })`);
  ok('双口径总览：全范围 + 你的手牌', d.scopes.length === 2 && /全范围/.test(d.scopes[0]) && /你的手牌/.test(d.scopes[1]), d.scopes.join(' / '));
  ok('动作色块渲染且带频率数值', d.tiles >= 4 && d.badges.length >= 2, 'tiles=' + d.tiles + ' badges=' + d.badges.join(','));
  ok('高低差摘要可见', /最高/.test(d.summary) && /高低差/.test(d.summary), d.summary.slice(0, 130));
  ok('比例条宽度合计≈100%', d.segs >= 4 && d.widthSum.every(x => Math.abs(Number(x) - 100) < 1), 'sums=' + d.widthSum.join(','));
  ok('策略格可点击下钻', d.clickableCells > 50, 'cells=' + d.clickableCells);

  // 点击热力格 → 详情弹层
  await ev("(() => { const c=document.querySelector('#heatHero .strat-grid .cell[data-act=freqCell]'); if(c){c.click();return true;} return false; })()");
  await sleep(300);
  const cellDetail = await ev(`({
    title: document.querySelector('.freq-detail .fd-title')?.textContent||'',
    combos: document.querySelectorAll('.freq-detail .fd-combo').length,
    suits: /[♣♦♥♠]/.test(document.querySelector('.freq-detail .fd-combos')?.textContent||''),
    bars: document.querySelectorAll('.freq-detail .fd-bar').length,
    focus: document.querySelectorAll('.freq-detail .fd-combo.is-focus').length,
    close: !!document.querySelector('.freq-detail [data-act=closeModal]')
  })`);
  ok('点击热力格弹出花色频率详情', /频率详情/.test(cellDetail.title) && cellDetail.combos > 0, cellDetail.title);
  ok('详情列出花色组合与三路频率条', cellDetail.suits && cellDetail.bars >= 1, 'combos=' + cellDetail.combos + ' bars=' + cellDetail.bars);
  ok('详情可关闭', cellDetail.close === true);
  await ev("document.querySelector('.freq-detail [data-act=closeModal]')?.click(); true"); await sleep(150);
  ok('关闭后弹层消失', await ev("!document.querySelector('.freq-detail')"));

  // 点击动作色块 → 手牌类别清单 → 再下钻到花色（选弃牌，确保该动作在网格中有类别）
  const tile = await ev("(() => { const t=document.querySelector('.freq-tile[data-kind=fold]')||document.querySelector('.freq-tile[data-kind=call]')||document.querySelector('.freq-tile'); if(t){t.click();return {kind:t.dataset.kind,label:t.querySelector('.ft-label').textContent};} return null; })()");
  await sleep(250);
  const actionDetail = await ev(`({
    title: document.querySelector('.freq-detail .fd-title')?.textContent||'',
    rows: document.querySelectorAll('.fd-class-row[data-act=freqCell]').length
  })`);
  ok('点击动作色块展开手牌类别清单', /手牌类别分布/.test(actionDetail.title) && actionDetail.rows > 0, actionDetail.title + ' rows=' + actionDetail.rows);
  await ev("document.querySelector('.fd-class-row')?.click(); true"); await sleep(250);
  ok('类别清单可继续下钻到花色详情', await ev("!!document.querySelector('.freq-detail .fd-combos') && document.querySelectorAll('.freq-detail .fd-combo').length>0"));
  await ev("document.querySelector('.freq-detail [data-act=closeModal]')?.click(); true"); await sleep(150);

  ok('无 JS 异常', await ev("(window.__errors||[]).length === 0"), JSON.stringify(await ev("window.__errors||[]")));
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await sleep(300);
  const ov = await ev("document.documentElement.scrollWidth - document.documentElement.clientWidth");
  ok('手机 390px 无横向溢出', ov <= 2, 'overflow=' + ov);
  await ev("document.querySelector('#heatHero .strat-grid .cell[data-act=freqCell]')?.click(); true"); await sleep(250);
  const m = await ev(`({ combos: getComputedStyle(document.querySelector('.fd-combos')).gridTemplateColumns, panelW: document.querySelector('.freq-detail').getBoundingClientRect().width })`);
  ok('手机端详情为两列花色卡且不超屏', /px.*px/.test(m.combos) && m.panelW <= 390, JSON.stringify(m));

  ws.close(); console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`); if (fail) process.exitCode = 1;
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => { chrome.kill(); srv.kill(); });
