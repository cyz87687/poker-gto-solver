/* cdp_v21.mjs —— V1.11 浏览器回归：推荐文案金额与「加注至」选项同源 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PORT = 4401;
const PROFILE = mkdtempSync(join(tmpdir(), 'poker_v21_'));
const srv = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--remote-debugging-port=4297', `--user-data-dir=${PROFILE}`,
  '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--disable-extensions', 'about:blank'
], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); } else { fail++; console.log('  FAIL  ' + name + '  ' + extra); } };

async function cdp(url) {
  const r = await fetch(url); return r.json();
}
async function main() {
  let targets;
  for (let i = 0; i < 60; i++) { try { targets = await cdp('http://127.0.0.1:4297/json/list'); if (targets.some(t => t.type === 'page')) break; } catch {} await sleep(200); }
  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let id = 0; const pending = new Map();
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise(r => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  const evalJs = async expr => {
    const m = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (m.result?.exceptionDetails) return { __err: m.result.exceptionDetails.text };
    return m.result?.result?.value;
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html#/new` });
  for (let i = 0; i < 80; i++) { if (await evalJs("document.readyState === 'complete' && !!document.querySelector('#app')?.innerHTML.length")) break; await sleep(200); }

  // 构造用户反馈局面：Hero BB，翻后面对下注且存在加注空间（求解器会给出 11.1 / 23.9 附近的尺度）
  const HH = `# PokerGTO HH v1
Game: NLHE
Stakes: SB=1 BB=2
Table: 6max
Hero: BB [3c4c]
Stacks: Hero=100 Villain=100 (BB)
Preflop: UTG fold, MP fold, CO fold, BTN raise 5, SB fold, BB call 3
Flop: [Kd6h9s]  BB check, BTN bet 4.8, BB call 4.8
Turn: [Kd6h9s5s]  BB check, BTN bet 4.8`;
  writeFileSync('/tmp/v21_hh.txt', HH);
  // 直接写入 localStorage 草稿（与 IndexedDB 镜像同键），避免逐牌点击
  const draftExpr = `(async () => {
    const raw = localStorage.getItem('poker_gto_review_state_v1');
    const s = raw ? JSON.parse(raw) : { version:1, settings:{period:'30d',currency:'¥',solvePreset:'fast',lastBackupAt:null}, sessions:[], hands:[], jobs:[], ranges:[], tags:[], updatedAt:new Date().toISOString() };
    s.draft = __DRAFT__;
    localStorage.setItem('poker_gto_review_state_v1', JSON.stringify(s));
    return !!s.draft;
  })()`;

  // 用页面自身的 parseHH 生成 draft：通过向导粘贴流程
  await evalJs("document.querySelector('[data-act=wizTab][data-v=paste]')?.click(); true");
  await sleep(300);
  await evalJs(`(() => { const t = document.querySelector('#pasteText'); if (t) { t.value = ${JSON.stringify(HH)}; t.dispatchEvent(new Event('input',{bubbles:true})); } return !!t; })()`);
  await evalJs("document.querySelector('[data-act=parsePaste]')?.click(); true");
  await sleep(400);
  const parseState = await evalJs(`(() => ({ ok: !!document.querySelector('[data-act=useParsed]:not([disabled])'), txt: document.querySelector('#app')?.innerText.slice(0, 400) }))()`);
  ok('HH 解析成功可载入', parseState.ok, parseState.txt);
  await evalJs("document.querySelector('[data-act=useParsed]')?.click(); true");
  await sleep(600);

  // 等待实时预览完成
  let badge = '';
  for (let i = 0; i < 100; i++) {
    badge = await evalJs("document.querySelector('#liveBadge')?.textContent || ''");
    if (/已就绪|不可用|停用/.test(badge)) break;
    await sleep(250);
  }
  ok('实时预览求解完成', /已就绪/.test(badge), badge);

  const snap = await evalJs(`(() => {
    const why = [...document.querySelectorAll('.why-line')].map(x => x.textContent.trim());
    const grid = document.querySelector('#decisionCards');
    const raiseBtns = [...document.querySelectorAll('.ac-raise_to .sz[data-amt]')].map(b => ({ amt: Number(b.dataset.amt), txt: b.textContent.trim() }));
    const betBtns = [...document.querySelectorAll('.ac-bet .sz[data-amt]')].map(b => ({ amt: Number(b.dataset.amt), txt: b.textContent.trim() }));
    const stats = [...document.querySelectorAll('.ac-raise_to .ac-stat')].map(x => x.textContent.trim());
    const rec = document.querySelector('.ac-raise_to .ac-rec') ? true : false;
    return { why, solveKey: grid?.dataset.solveKey || '', raiseBtns, betBtns, stats, rec, src: document.querySelector('.ac-raise_to .ac-sub')?.textContent.trim() || '' };
  })()`);
  console.log('  快照：', JSON.stringify(snap));

  ok('求解结果驱动选项（grid 带 solveKey）', !!snap.solveKey, snap.solveKey.slice(0, 60));
  ok('存在「为什么推荐」文案', snap.why.length > 0, JSON.stringify(snap.why).slice(0, 200));
  ok('存在加注至档位按钮', snap.raiseBtns.length > 0, JSON.stringify(snap.raiseBtns).slice(0, 200));

  // 核心断言：为什么推荐里出现的每个「加注至 X BB」，都能在加注档位按钮中找到同额按钮
  const whyAmounts = [];
  for (const line of snap.why) {
    const re = /加注至\s+([0-9]+(?:\.[0-9]+)?)\s*BB/g; let m;
    while ((m = re.exec(line))) whyAmounts.push(Number(m[1]));
  }
  ok('推荐文案含具体加注至金额', whyAmounts.length > 0, JSON.stringify(whyAmounts));
  const amts = snap.raiseBtns.map(b => b.amt);
  const missing = whyAmounts.filter(a => !amts.some(x => Math.abs(x - a) < 0.05));
  ok('推荐提到的所有加注金额均出现在选项中（无缺失）', missing.length === 0, 'missing=' + JSON.stringify(missing) + ' options=' + JSON.stringify(amts));
  ok('档位标签为「均衡档」（源自求解）', snap.raiseBtns.some(b => /均衡档/.test(b.txt)), JSON.stringify(snap.raiseBtns).slice(0, 200));
  ok('档位不再使用固定「最小加注/2× 尺度/3× 尺度」', !snap.raiseBtns.some(b => /最小加注|2× 尺度|3× 尺度/.test(b.txt)), JSON.stringify(snap.raiseBtns).slice(0, 200));
  ok('加注档位带频率/EV 统计内联', snap.stats.length > 0, JSON.stringify(snap.stats).slice(0, 160));

  // 点击档位录入，验证行动流金额 = 按钮金额（无丢精度）
  if (amts.length) {
    const target = amts[0];
    await evalJs(`(() => { const b = [...document.querySelectorAll('.ac-raise_to .sz[data-amt]')].find(x => Number(x.dataset.amt) === ${target}); b?.click(); return !!b; })()`);
    await sleep(400);
    const tl = await evalJs(`document.querySelector('#app').innerText.match(/加注至\\s*${target.toFixed(1)}\\s*BB/)?.[0] || ''`);
    ok('点击求解档位可正确录入行动', !!tl, tl || 'no timeline match');
  }

  const jsErr = await evalJs(`window.__errors || []`);
  ok('页面无 JS 运行时错误', Array.isArray(jsErr) && jsErr.length === 0, JSON.stringify(jsErr));
  ws.close();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  if (fail) process.exitCode = 1;
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => { chrome.kill(); srv.kill(); });
