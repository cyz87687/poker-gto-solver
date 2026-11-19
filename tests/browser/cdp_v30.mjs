/* cdp_v30.mjs —— V1.20 专项：面对下注的「全下」选项 + 策略格写手牌 + 坚果可加注（真实 UI 验证） */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('../..', import.meta.url)), PORT = 4410, DP = 4510;
const profile = mkdtempSync(join(tmpdir(), 'poker_v30_'));
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
  ok('河牌结果页渲染完成', ready === true);

  // ① 动作集含「全下」：频率面板与 EV 表都应出现
  const d = await ev(`({
    tiles: [...document.querySelectorAll('.freq-tile')].map(x=>x.querySelector('.ft-label').textContent.trim()+' '+x.querySelector('.ft-pct').textContent.trim()),
    evRows: [...document.querySelectorAll('.ev-table tbody tr')].map(r=>r.textContent.replace(/\\s+/g,' ').trim()),
    cellLabels: [...document.querySelectorAll('#heatHero .strat-grid .cell')].map(x=>x.textContent.trim()).filter(Boolean),
    legend: document.querySelector('#heatHero .strat-legend')?.textContent||''
  })`);
  ok('频率面板出现「全下」动作（唯一可行的加注形态）', d.tiles.some(t => /全下/.test(t)), d.tiles.join(' | '));
  ok('EV 表含「全下 70.8 BB」一行', d.evRows.some(r => /全下/.test(r)), d.evRows.join(' || ').slice(0, 200));

  // ② 策略格写手牌类别
  ok('策略格写入手牌类别而非动作字母', d.cellLabels.length > 50 && d.cellLabels.every(x => /^[2-9TJQKA]{1,2}[so]?$/.test(x)),
    d.cellLabels.slice(0, 10).join(' '));
  ok('图例说明含「格内=手牌类别」「斜分=混合策略」', /格内=手牌类别/.test(d.legend) && /斜分=混合策略/.test(d.legend), d.legend.slice(0, 160));

  // ③ 坚果 QJs 加注 100%（不再是只能弃/跟）
  const qjsTip = await ev(`(() => { const c=[...document.querySelectorAll('#heatHero .strat-grid .cell')].find(x=>x.textContent.trim()==='QJs'); return c ? (c.getAttribute('title')||'') : ''; })()`);
  ok('河牌坚果 QJs 主策略为加注', /主策略 加注/.test(qjsTip) && /加 100%/.test(qjsTip), qjsTip.slice(0, 140));

  // ④ 弱牌 K4 仍以跟注为主
  const focusScope = await ev(`(() => { const rows=[...document.querySelectorAll('.freq-scope')]; const r=rows[rows.length-1]; return r ? r.textContent.replace(/\\s+/g,' ').trim() : ''; })()`);
  ok('你的手牌仍以跟注为主（≥80%）', /跟注/.test(focusScope) && /8[0-9]\.[0-9]%|9[0-9]\.[0-9]%/.test(focusScope), focusScope.slice(0, 180));

  // ⑤ 点击坚果格 → 花色详情
  await ev(`(() => { const c=[...document.querySelectorAll('#heatHero .strat-grid .cell')].find(x=>x.textContent.trim()==='QJs'); if(c){c.click();return true;} return false; })()`);
  await sleep(300);
  const modal = await ev(`({
    title: document.querySelector('.freq-detail .fd-title')?.textContent||'',
    combos: document.querySelectorAll('.freq-detail .fd-combo').length,
    hasShove: /全下/.test(document.querySelector('.freq-detail')?.textContent||'')
  })`);
  ok('点击 QJs 弹出花色详情（4 个花色组合）', /QJs/.test(modal.title) && modal.combos === 4, modal.title + ' combos=' + modal.combos);
  await ev("document.querySelector('.freq-detail [data-act=closeModal]')?.click(); true"); await sleep(150);

  ok('无 JS 异常', await ev("(window.__errors||[]).length === 0"), JSON.stringify(await ev("window.__errors||[]")));
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); await sleep(300);
  const ov = await ev("document.documentElement.scrollWidth - document.documentElement.clientWidth");
  ok('手机 390px 无横向溢出', ov <= 2, 'overflow=' + ov);
  const mob = await ev("(() => { const c=document.querySelector('#heatHero .strat-grid .cell[data-act]'); const r=c.getBoundingClientRect(); return {w:Math.round(r.width), t:c.textContent.trim()}; })()");
  ok('手机端格内仍显示手牌类别', /^[2-9TJQKA]{1,2}[so]?$/.test(mob.t) && mob.w > 10, JSON.stringify(mob));

  ws.close(); console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`); if (fail) process.exitCode = 1;
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => { chrome.kill(); srv.kill(); });
