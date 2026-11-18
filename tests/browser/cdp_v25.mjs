/* cdp_v25.mjs —— V1.15 专项：对手范围绝对宽度口径（本地部署）+ V1.14 回归 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('../..', import.meta.url)), PORT = 4405, DP = 4505;
const profile = mkdtempSync(join(tmpdir(), 'poker_v25_'));
const srv = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--remote-debugging-port=' + DP, '--user-data-dir=' + profile, '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--disable-extensions', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log('  PASS  ' + n + (e ? '  ' + e : '')); } else { fail++; console.log('  FAIL  ' + n + '  ' + e); } };

const HH33 = `# PokerGTO HH v1\nGame: NLHE\nStakes: SB=1 BB=2\nTable: 6max\nHero: BTN [3c3d]\nStacks: Hero=100 Villain=100 (BB)\nPreflop:  BTN raise 3.5, BB raise 12.0`;

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

  // 导入用户场景
  await ev("document.querySelector('[data-act=wizTab][data-v=paste]')?.click(); true"); await sleep(250);
  await ev(`(() => { const t=document.querySelector('#pasteText'); if(t){t.value=${JSON.stringify(HH33)};t.dispatchEvent(new Event('input',{bubbles:true}));} return !!t; })()`);
  await ev("document.querySelector('[data-act=parsePaste]')?.click(); true"); await sleep(400);
  await ev("document.querySelector('[data-act=useParsed]')?.click(); true"); await sleep(600);
  for (let i = 0; i < 160; i++) { const b = await ev("document.querySelector('#liveBadge')?.textContent||''"); if (/已就绪/.test(b)) break; await sleep(250); }

  const g = await ev(`({
    badge: document.querySelector('#liveBadge')?.textContent||'',
    why: [...document.querySelectorAll('.why-line')].map(x=>x.textContent.trim()),
    acs: [...document.querySelectorAll('.ac')].map(x=>x.innerText.replace(/\\s+/g,' ').trim())
  })`);
  ok('实时预览完成', /已就绪/.test(g.badge) && g.why.length > 0, g.badge);

  const scope = g.why.find(x => x.includes('范围口径')) || '';
  ok('范围口径改用绝对宽度表述', /全范围/.test(scope) && /%/.test(scope), scope.slice(0, 190));
  const pct = (scope.match(/全范围\s*([\d.]+)%/) || [])[1];
  ok('对手范围宽度落在 9%~15%（旧口径为 36.5%）', pct != null && Number(pct) > 9 && Number(pct) < 15, 'pct=' + pct);
  ok('范围口径标注加注档位与位置对', /3bet/.test(scope) && /BTN/.test(scope), scope.slice(0, 120));

  const raise100 = g.acs.filter(t => /加注至/.test(t) && /(99|100)%/.test(t));
  ok('33 不再出现 100% 4bet 建议', raise100.length === 0, raise100.join(' | ') || '无');
  ok('行动选项含弃牌与跟注', g.acs.some(t => /弃牌/.test(t)) && g.acs.some(t => /跟注/.test(t)), g.acs.slice(0, 3).join(' | '));

  // 切剥削模式 → 确认按钮 → 确认后重算，范围口径应带风格倍率
  await ev("document.querySelector('.exploit-bar [data-act=setMode][data-v=exploit]')?.click(); true"); await sleep(400);
  const c1 = await ev(`({confirm:!!document.querySelector('.live-confirm'),badge:document.querySelector('#liveBadge')?.textContent||'',btn:document.querySelector('[data-act=confirmExploit]')?.textContent.trim()||''})`);
  ok('剥削模式默认显示确认按钮', c1.confirm && c1.btn === '确认并重新解算', JSON.stringify(c1).slice(0, 160));
  await ev("document.querySelector('.exploit-bar [data-act=setArchetype][data-v=lag]')?.click(); true"); await sleep(350);
  await ev("document.querySelector('[data-act=confirmExploit]')?.click(); true"); await sleep(400);
  for (let i = 0; i < 200; i++) { const b = await ev("document.querySelector('#liveBadge')?.textContent||''"); if (/已就绪/.test(b)) break; await sleep(250); }
  const ex = await ev(`({
    badge: document.querySelector('#liveBadge')?.textContent||'',
    why: [...document.querySelectorAll('.why-line')].map(x=>x.textContent.trim()),
    acs: [...document.querySelectorAll('.ac')].map(x=>x.innerText.replace(/\\s+/g,' ').trim())
  })`);
  const scopeL = ex.why.find(x => x.includes('范围口径')) || '';
  ok('确认后重新求解完成', /已就绪/.test(ex.badge), ex.badge);
  ok('剥削口径标注风格倍率（松凶 ×1.40）', /风格\s*×1\.40/.test(scopeL), scopeL.slice(0, 190));
  const pctL = (scopeL.match(/全范围\s*([\d.]+)%/) || [])[1];
  ok('松凶对手 3bet 范围宽于 GTO', pctL != null && pct != null && Number(pctL) > Number(pct), `GTO=${pct}% LAG=${pctL}%`);
  const raise100L = ex.acs.filter(t => /加注至/.test(t) && /(99|100)%/.test(t));
  ok('松凶画像下 33 同样不出现 100% 4bet', raise100L.length === 0, raise100L.join(' | ') || '无');
  ok('无 JS 异常', await ev("(window.__errors||[]).length === 0"), JSON.stringify(await ev("window.__errors||[]")));

  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await sleep(300);
  const ov = await ev("document.documentElement.scrollWidth - document.documentElement.clientWidth");
  ok('手机 390px 无横向溢出', ov <= 2, 'overflow=' + ov);
  ws.close(); console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`); if (fail) process.exitCode = 1;
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => { chrome.kill(); srv.kill(); });
