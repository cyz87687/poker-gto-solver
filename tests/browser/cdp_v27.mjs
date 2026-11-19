/* cdp_v27.mjs —— V1.17 专项：TAG 剥削档 K4 加注转负 EV、翻前/翻后弃牌解耦、跨街极化。
 * 在真实 UI 上验证：K4 面对 TAG cbet 时跟注主推、加注 EV 为负且不主推；切 LAG 后加注恢复正 EV。 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('../..', import.meta.url)), PORT = 4407, DP = 4507;
const profile = mkdtempSync(join(tmpdir(), 'poker_v27_'));
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
  const untilReady = async () => { for (let i = 0; i < 240; i++) { const b = await ev("document.querySelector('#liveBadge')?.textContent||''"); if (/已就绪/.test(b)) return true; await sleep(250); } return false; };
  ok('K4 翻后场景实时预览完成', await untilReady());

  // 切到剥削模式 + 紧凶 TAG（首切显示确认按钮，需点击确认后重算）
  await ev("document.querySelector('[data-act=setMode][data-v=exploit]')?.click(); true"); await sleep(300);
  const confirmVisible = await ev("!!document.querySelector('[data-act=confirmExploit]')");
  ok('剥削模式默认显示确认按钮', confirmVisible === true);
  await ev("document.querySelector('[data-act=setArchetype][data-v=tag]')?.click(); true"); await sleep(300);
  await ev("document.querySelector('[data-act=confirmExploit]')?.click(); true"); await sleep(300);
  ok('TAG 画像确认后重新求解完成', await untilReady());

  const g = await ev(`({
    why: [...document.querySelectorAll('.why-line')].map(x=>x.textContent.trim()),
    acs: [...document.querySelectorAll('.ac')].map(x=>x.innerText.replace(/\\s+/g,' ').trim())
  })`);
  const why = g.why.join(' ');
  const cond = g.why.find(x => x.includes('范围条件化')) || '';
  ok('TAG 剥削档展示范围条件化口径', /范围条件化/.test(cond), cond.slice(0, 200));
  // TAG 被跟注范围应显著收窄（eqCont 降到 13.9%，低于 GTO 的 50%）
  const eqCont = (cond.match(/权益降到\s*([\d.]+)%/) || [])[1];
  ok('TAG 被跟注权益显著低于 GTO（价值子集收窄）', eqCont != null && Number(eqCont) < 30, 'eqCont=' + eqCont + '%');

  // 手牌级条件 EV（行动卡 EV 是范围平均，手牌级才反映你这手牌）：TAG 加注应为负
  const handEv = g.why.find(x => x.includes('手牌级条件 EV')) || '';
  ok('TAG 档展示手牌级条件 EV 对比', /手牌级条件 EV/.test(why) && /加注最高/.test(handEv), handEv.slice(0, 160));
  const raiseEvM = handEv.match(/加注最高\s*([+-]?[\d.]+)\s*BB/);
  const tagRaiseEv = raiseEvM ? Number(raiseEvM[1]) : null;
  ok('TAG 档手牌级加注 EV 为负', tagRaiseEv != null && tagRaiseEv < 0, 'raiseEv=' + tagRaiseEv);
  ok('TAG 档判定造池不划算', /负 EV，造池不划算/.test(handEv), handEv.slice(0, 160));
  // 主推应为跟注（卡上带「推荐」且 EV 正）
  const rec = g.acs.find(t => /推荐/.test(t)) || '';
  ok('TAG 档主推为跟注（非加注）', /跟注/.test(rec) && !/加注至[^·]*推荐/.test(rec), rec.slice(0, 120));
  const raise100 = g.acs.filter(t => /加注至/.test(t) && /(99|100)%/.test(t));
  ok('TAG 档不出现 100% raise', raise100.length === 0, raise100.join(' | ') || '无');

  // 切 LAG：加注 EV 应恢复为正且弃牌率高
  await ev("document.querySelector('[data-act=setArchetype][data-v=lag]')?.click(); true"); await sleep(300);
  const confirmLag = await ev("!!document.querySelector('[data-act=confirmExploit]')");
  if (confirmLag) await ev("document.querySelector('[data-act=confirmExploit]')?.click(); true");
  // 先等求解结束（badge=已就绪 且 why 区非空），再等 why 反映 LAG 口径（加注最高为正）
  let g2;
  for (let i = 0; i < 240; i++) {
    g2 = await ev(`({ badge:document.querySelector('#liveBadge')?.textContent||'', why: [...document.querySelectorAll('.why-line')].map(x=>x.textContent.trim()) })`);
    const line = (g2.why || []).find(x => x.includes('手牌级条件 EV')) || '';
    const m = line.match(/加注最高\s*([+-]?[\d.]+)\s*BB/);
    if (/已就绪/.test(g2.badge) && m && Number(m[1]) > 0) break;
    await sleep(250);
  }
  ok('LAG 画像重新求解完成', /已就绪/.test(g2.badge) && (g2.why || []).length > 0, g2.badge);
  const lagHandEv = (g2.why || []).find(x => x.includes('手牌级条件 EV')) || '';
  const lagRaiseEvM = lagHandEv.match(/加注最高\s*([+-]?[\d.]+)\s*BB/);
  const lagRaiseEv = lagRaiseEvM ? Number(lagRaiseEvM[1]) : null;
  ok('LAG 档加注 EV 优于 TAG', lagRaiseEv != null && tagRaiseEv != null && lagRaiseEv > tagRaiseEv + 5,
    `lag=${lagRaiseEv} tag=${tagRaiseEv}`);

  ok('无 JS 异常', await ev("(window.__errors||[]).length === 0"), JSON.stringify(await ev("window.__errors||[]")));
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await sleep(300);
  const ov = await ev("document.documentElement.scrollWidth - document.documentElement.clientWidth");
  ok('手机 390px 无横向溢出', ov <= 2, 'overflow=' + ov);
  ws.close(); console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`); if (fail) process.exitCode = 1;
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => { chrome.kill(); srv.kill(); });
