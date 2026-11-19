/* cdp_v28.mjs —— V1.18 专项：河牌教学拆解 + Hero 策略分区热力图（真实 UI 验证） */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('../..', import.meta.url)), PORT = 4408, DP = 4508;
const profile = mkdtempSync(join(tmpdir(), 'poker_v28_'));
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

  // 导入河牌牌谱
  await ev("document.querySelector('[data-act=wizTab][data-v=paste]')?.click(); true"); await sleep(250);
  await ev(`(() => { const t=document.querySelector('#pasteText'); if(t){t.value=${JSON.stringify(HH)};t.dispatchEvent(new Event('input',{bubbles:true}));} return !!t; })()`);
  await ev("document.querySelector('[data-act=parsePaste]')?.click(); true"); await sleep(400);
  await ev("document.querySelector('[data-act=useParsed]')?.click(); true"); await sleep(600);

  // 正式解算并进结果页
  await ev("document.querySelector('[data-act=beginSolve]')?.click(); true");
  let inResult = false;
  for (let i = 0; i < 240; i++) {
    inResult = await ev("!!document.querySelector('.river-lesson') && !!document.querySelector('#heatHero .strat-grid')");
    if (inResult) break;
    await sleep(300);
  }
  ok('河牌场景进入结果页并渲染 V1.18 区块', inResult === true);

  const d = await ev(`({
    lessonTitle: document.querySelector('.lesson-hd')?.textContent||'',
    lessonSecs: [...document.querySelectorAll('.lesson-sec')].map(x=>x.textContent.replace(/\\s+/g,' ').trim()),
    combos: [...document.querySelectorAll('.lesson-combo')].map(x=>x.textContent.trim()),
    stratCells: document.querySelectorAll('#heatHero .strat-grid .cell').length,
    stratLetters: [...document.querySelectorAll('#heatHero .strat-grid .cell')].map(x=>x.textContent.trim()).filter(Boolean).slice(0,200),
    stratLegend: document.querySelector('#heatHero .strat-legend')?.textContent||'',
    focusRing: document.querySelectorAll('#heatHero .strat-grid .cell[style*="outline"]').length
  })`);
  ok('教学块标题正确', /河牌决策教学/.test(d.lessonTitle), d.lessonTitle);
  ok('教学四段齐全（赔率/MDF/拆解/画像调整）', d.lessonSecs.length === 4, 'secs=' + d.lessonSecs.length);
  ok('教学展示抓诈门槛 28.6%', d.lessonSecs.some(s => /28\.6%/.test(s)), (d.lessonSecs[0]||'').slice(0,140));
  ok('教学解释 MDF 与高频跟注', d.lessonSecs.some(s => /MDF/.test(s) && /高频跟注/.test(s)), (d.lessonSecs[1]||'').slice(0,140));
  ok('教学含 TAG/LAG 频率调整', d.lessonSecs.some(s => /TAG/.test(s) && /LAG/.test(s)), (d.lessonSecs[3]||'').slice(0,140));
  ok('教学展示价值/诈唬组合及数量', d.combos.length >= 4 && d.combos.some(x => /QJs/.test(x)), d.combos.slice(0,8).join(' '));
  ok('策略热力图为 13×13 = 169 格', d.stratCells === 169, 'cells=' + d.stratCells);
  ok('策略格子标注动作字母 F/C/R', /[FCR]/.test(d.stratLetters.join('')) && d.stratLetters.some(x => /^[FCR]\d*$/.test(x)), d.stratLetters.slice(0,12).join(' '));
  ok('策略图例含三色说明', /弃牌/.test(d.stratLegend) && /跟注/.test(d.stratLegend) && /加注/.test(d.stratLegend), d.stratLegend.slice(0,120));
  ok('你的手牌聚焦格有蓝框标记', d.focusRing >= 1, 'focusRing=' + d.focusRing);

  // 完整花色 tooltip
  const tip = await ev("document.querySelector('#heatHero .strat-grid .cell[title]')?.getAttribute('title')||''");
  ok('格子 tooltip 含完整花色与三路频率', /[2-9TJQKA][cdhs][2-9TJQKA][cdhs]/.test(tip) && /弃/.test(tip) && /跟/.test(tip) && /加/.test(tip), tip.slice(0,160));

  ok('无 JS 异常', await ev("(window.__errors||[]).length === 0"), JSON.stringify(await ev("window.__errors||[]")));
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await sleep(300);
  const ov = await ev("document.documentElement.scrollWidth - document.documentElement.clientWidth");
  ok('手机 390px 无横向溢出', ov <= 2, 'overflow=' + ov);
  ws.close(); console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`); if (fail) process.exitCode = 1;
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => { chrome.kill(); srv.kill(); });
