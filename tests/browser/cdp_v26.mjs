/* cdp_v26.mjs —— V1.16 专项：范围条件化收益（隐含赔率 + 诈唬捕捉价值）本地部署验证 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('../..', import.meta.url)), PORT = 4406, DP = 4506;
const profile = mkdtempSync(join(tmpdir(), 'poker_v26_'));
const srv = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--remote-debugging-port=' + DP, '--user-data-dir=' + profile, '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--disable-extensions', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log('  PASS  ' + n + (e ? '  ' + e : '')); } else { fail++; console.log('  FAIL  ' + n + '  ' + e); } };

const HH_K4 = `# PokerGTO HH v1
Game: NLHE
Stakes: SB=1 BB=2
Table: 6max
Hero: BTN [Kc4d]
Stacks: Hero=100 Villain=100 (BB)
Preflop:  BTN raise 2.7, BB raise 8.8, BTN call 6.1
Flop: [Kh7s2c]  BB bet 8.8`;

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

  // 导入 K4 翻后场景
  await ev("document.querySelector('[data-act=wizTab][data-v=paste]')?.click(); true"); await sleep(250);
  await ev(`(() => { const t=document.querySelector('#pasteText'); if(t){t.value=${JSON.stringify(HH_K4)};t.dispatchEvent(new Event('input',{bubbles:true}));} return !!t; })()`);
  await ev("document.querySelector('[data-act=parsePaste]')?.click(); true"); await sleep(400);
  await ev("document.querySelector('[data-act=useParsed]')?.click(); true"); await sleep(600);
  for (let i = 0; i < 200; i++) { const b = await ev("document.querySelector('#liveBadge')?.textContent||''"); if (/已就绪/.test(b)) break; await sleep(250); }

  const g = await ev(`({
    badge: document.querySelector('#liveBadge')?.textContent||'',
    why: [...document.querySelectorAll('.why-line')].map(x=>x.textContent.trim()),
    acs: [...document.querySelectorAll('.ac')].map(x=>x.innerText.replace(/\\s+/g,' ').trim())
  })`);
  ok('K4 翻后场景实时预览完成', /已就绪/.test(g.badge) && g.why.length > 0, g.badge);

  const why = g.why.join(' ');
  const cond = g.why.find(x => x.includes('范围条件化')) || '';
  ok('展示范围条件化口径', /范围条件化/.test(why), cond.slice(0, 200));
  ok('区分下注范围与跟注范围', /下注范围/.test(cond) && /价值范围/.test(cond), cond.slice(0, 200));
  const eqs = (cond.match(/权益(?:降到)?\s*([\d.]+)%/g) || []);
  ok('展示 call 与 raise 两个条件权益', eqs.length >= 2 && /权益降到/.test(cond), eqs.join(' '));
  const implied = g.why.find(x => x.includes('隐含赔率')) || '';
  ok('展示隐含赔率（非河牌）', /隐含赔率/.test(why) && /BB/.test(implied), implied.slice(0, 160));

  const raise100 = g.acs.filter(t => /加注至/.test(t) && /(99|100)%/.test(t));
  ok('K4 不再出现 100% raise 建议', raise100.length === 0, raise100.join(' | ') || '无');
  const callCard = g.acs.find(t => /跟注/.test(t)) || '';
  ok('行动选项含跟注', !!callCard, callCard.slice(0, 120));
  ok('无 JS 异常', await ev("(window.__errors||[]).length === 0"), JSON.stringify(await ev("window.__errors||[]")));

  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await sleep(300);
  const ov = await ev("document.documentElement.scrollWidth - document.documentElement.clientWidth");
  ok('手机 390px 无横向溢出', ov <= 2, 'overflow=' + ov);
  ws.close(); console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`); if (fail) process.exitCode = 1;
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => { chrome.kill(); srv.kill(); });
