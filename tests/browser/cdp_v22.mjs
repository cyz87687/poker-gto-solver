/* cdp_v22.mjs —— V1.12 浏览器端到端：500bb 5bet 局面 33 不再 100% 全下 + 既有契约回归 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PORT = 4403, DP = 4503;
const PROFILE = mkdtempSync(join(tmpdir(), 'poker_v22_'));
const srv = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--remote-debugging-port=' + DP, '--user-data-dir=' + PROFILE, '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--disable-extensions', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const ok = (n, c, e = '') => { if (c) { pass++; console.log('  PASS  ' + n + (e ? '  ' + e : '')); } else { fail++; console.log('  FAIL  ' + n + '  ' + e); } };
async function main() {
  let targets; for (let i = 0; i < 60; i++) { try { targets = await (await fetch(`http://127.0.0.1:${DP}/json/list`)).json(); if (targets.some(t => t.type === 'page')) break; } catch {} await sleep(200); }
  const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let id = 0; const pend = new Map(); ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  const send = (method, params = {}) => new Promise(r => { const n = ++id; pend.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  const ev = async expr => { const m = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return m.result?.exceptionDetails ? { __err: m.result.exceptionDetails.text } : m.result?.result?.value; };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html#/new` });
  for (let i = 0; i < 80; i++) { if (await ev("document.readyState==='complete' && !!document.querySelector('#app')?.innerHTML.length")) break; await sleep(200); }

  const HH = `# PokerGTO HH v1
Game: NLHE
Stakes: SB=1 BB=2
Table: 6max
Hero: BTN [3c3d]
Stacks: Hero=500 Villain=500 (BB)
Preflop:  BTN raise 3.5, BB raise 14.0, BTN raise 40.0, BB raise 132.0`;
  await ev("document.querySelector('[data-act=wizTab][data-v=paste]')?.click(); true"); await sleep(300);
  await ev(`(() => { const t=document.querySelector('#pasteText'); if(t){t.value=${JSON.stringify(HH)};t.dispatchEvent(new Event('input',{bubbles:true}));} return !!t; })()`);
  await ev("document.querySelector('[data-act=parsePaste]')?.click(); true"); await sleep(400);
  const parsed = await ev("(() => ({ok:!!document.querySelector('[data-act=useParsed]:not([disabled])'),txt:document.querySelector('#app')?.innerText.slice(0,300)}))()");
  ok('HH 解析成功', parsed.ok, parsed.txt);
  await ev("document.querySelector('[data-act=useParsed]')?.click(); true"); await sleep(600);
  let badge = ''; for (let i = 0; i < 120; i++) { badge = await ev("document.querySelector('#liveBadge')?.textContent||''"); if (/已就绪|不可用|停用/.test(badge)) break; await sleep(250); }
  ok('实时预览完成', /已就绪/.test(badge), badge);

  const snap = await ev(`(() => ({
    why:[...document.querySelectorAll('.why-line')].map(x=>x.textContent.trim()),
    labels:[...document.querySelectorAll('.ac-grid .ac-card')].map(c=>({t:c.textContent.trim().slice(0,40),rec:!!c.querySelector('.ac-rec')})),
    note:document.querySelector('#app')?.innerText||''
  }))()`);
  console.log('  快照 why:', JSON.stringify(snap.why).slice(0,600));
  console.log('  快照 cards:', JSON.stringify(snap.labels).slice(0,500));
  ok('推荐文案不再是全下', !/推荐「全下/.test(snap.why.join(' ')), snap.why[0]);
  ok('推荐文案不再指向全下（弃牌或跟注）', /推荐「(弃牌|跟注)/.test(snap.why.join(' ')), snap.why[0]);
  ok('权益未虚高到宽范围水平（<55%）', /权益约 (1\d|2\d|3\d|4\d|5[0-4])\./.test(snap.why.join(' ')), snap.why.find(l=>/手牌/.test(l))||'');
  ok('解释中披露范围收窄口径（V1.15 绝对宽度口径）', /范围收窄至全范围/.test(snap.why.join(' ')), snap.why.find(l=>/范围口径/.test(l))||'');
  ok('无 100% 全下文案', !/100%/.test((snap.why[0]||'')+'全下'));
  ok('无 JS 异常', await ev("(window.__errors||[]).length === 0"));

  // 既有契约：手机无溢出
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(300);
  const overflow = await ev("document.documentElement.scrollWidth - document.documentElement.clientWidth");
  ok('手机 390px 无横向溢出', overflow <= 2, 'overflow=' + overflow);
  ws.close(); console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`); if (fail) process.exitCode = 1;
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => { chrome.kill(); srv.kill(); });
