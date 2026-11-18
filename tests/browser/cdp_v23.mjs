/* cdp_v23.mjs —— V1.13 专项：剥削入口可见 / 画像切换 / 深码全下消除 / 盲注底池口径 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';import { tmpdir } from 'node:os';import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT=fileURLToPath(new URL('../..', import.meta.url)),PORT = 4404,DP = 4504;
const profile=mkdtempSync(join(tmpdir(),'poker_v23_'));
const srv=spawn('python3',['-m','http.server',String(PORT),'--bind','127.0.0.1'],{cwd:ROOT,stdio:'ignore'});
const chrome=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--remote-debugging-port='+DP,'--user-data-dir='+profile,'--no-sandbox','--disable-dev-shm-usage','--no-first-run','--disable-extensions','about:blank'],{stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0; const ok=(n,c,e='')=>{if(c){pass++;console.log('  PASS  '+n+(e?'  '+e:''));}else{fail++;console.log('  FAIL  '+n+'  '+e);}};
async function main(){
 let t;for(let i=0;i<60;i++){try{t=await(await fetch(`http://127.0.0.1:${DP}/json/list`)).json();if(t.some(x=>x.type==='page'))break;}catch{}await sleep(200);}
 const ws=new WebSocket(t.find(x=>x.type==='page').webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r));
 let id=0;const p=new Map();ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id&&p.has(m.id)){p.get(m.id)(m);p.delete(m.id);}});
 const send=(method,params={})=>new Promise(r=>{const n=++id;p.set(n,r);ws.send(JSON.stringify({id:n,method,params}));});
 const ev=async x=>{const m=await send('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true});return m.result?.exceptionDetails?{__err:m.result.exceptionDetails.text}:m.result?.result?.value;};
 await send('Page.enable');await send('Runtime.enable');
 await send('Page.navigate',{url:`http://127.0.0.1:${PORT}/index.html#/new`});
 for(let i=0;i<80;i++){if(await ev("document.readyState==='complete' && !!document.querySelector('#app')?.innerHTML.length"))break;await sleep(200);}

 const HH=`# PokerGTO HH v1\nGame: NLHE\nStakes: SB=1 BB=2\nTable: 6max\nHero: BTN [3c3d]\nStacks: Hero=500 Villain=500 (BB)\nPreflop:  BTN raise 3.5, BB raise 14.0, BTN raise 40.0, BB raise 132.0`;
 await ev("document.querySelector('[data-act=wizTab][data-v=paste]')?.click(); true");await sleep(250);
 await ev(`(() => { const t=document.querySelector('#pasteText'); if(t){t.value=${JSON.stringify(HH)};t.dispatchEvent(new Event('input',{bubbles:true}));} return !!t; })()`);
 await ev("document.querySelector('[data-act=parsePaste]')?.click(); true");await sleep(400);
 await ev("document.querySelector('[data-act=useParsed]')?.click(); true");await sleep(2600);

 // P1-1 剥削入口默认可见
 const bar=await ev(`(() => ({ exists:!!document.querySelector('.exploit-bar'), modes:[...document.querySelectorAll('.exploit-bar [data-act=setMode]')].map(b=>b.textContent.trim()), arch:document.querySelectorAll('.exploit-bar [data-act=setArchetype]').length, paramsBtn:document.querySelector('[data-act=toggleParams]')?.textContent.trim()||'' }))()`);
 ok('剥削设置条默认可见（无需展开参数）',bar.exists && bar.modes.length===2,JSON.stringify(bar.modes));
 ok('求解参数按钮文案含「剥削画像」',/剥削画像/.test(bar.paramsBtn),bar.paramsBtn);
 ok('GTO 模式下不显示画像按钮',bar.arch===0,'arch='+bar.arch);

 // GTO 深码：不再 100% 全下
 const whyG=await ev(`[...document.querySelectorAll('.why-line')].map(x=>x.textContent.trim())`);
 ok('GTO 主推非全下',/^推荐「(?!全下)/.test(whyG[0]||''),whyG[0]);
 ok('GTO 无「100% 全下」',!/推荐「全下[^」]*」（频率 100%/.test(whyG.join(' ')),whyG[0]);

 // 切剥削模式 → 画像按钮出现 → 选 CS
 await ev("document.querySelector('.exploit-bar [data-act=setMode][data-v=exploit]')?.click(); true");await sleep(500);
 const archs=await ev(`[...document.querySelectorAll('.exploit-bar [data-act=setArchetype]')].map(b=>({v:b.dataset.v,t:b.textContent.trim()}))`);
 ok('剥削模式下 5 类画像常驻可见',archs.length===5,JSON.stringify(archs.map(a=>a.v)));
 await ev("document.querySelector('.exploit-bar [data-act=setArchetype][data-v=cs]')?.click(); true");await sleep(500);
 // V1.14：剥削画像变更需显式确认后才重算
 await ev("document.querySelector('[data-act=confirmExploit]')?.click();true");await sleep(300);
 let whyE=[];for(let i=0;i<120;i++){ whyE=await ev(`[...document.querySelectorAll('.why-line')].map(x=>x.textContent.trim())`); const b=await ev("document.querySelector('#liveBadge')?.textContent||''"); if(whyE.length&&/已就绪/.test(b))break; await sleep(250); }
 console.log('  剥削 why:',JSON.stringify(whyE).slice(0,400));
    console.log('  画像选中:',JSON.stringify(await ev(`[...document.querySelectorAll('.exploit-bar .chip.on')].map(b=>b.textContent.trim())`)));
 console.log('  剥削 diag:',JSON.stringify(await ev(`({badge:document.querySelector('#liveBadge')?.textContent||'',node:document.querySelector('.dp-node')?.textContent||'',msg:document.querySelector('.live-msg')?.textContent||'',txt:document.querySelector('#app')?.innerText.slice(0,300)})`)));
 ok('剥削模式（跟注站）主推仍非全下',/^推荐「(?!全下)/.test(whyE[0]||''),whyE[0]);
 ok('风险提示：全下尺度已不进入动作集',!/风险提示/.test(whyE.join(' ')),whyE.filter(l=>/风险/.test(l)).join(' ')||'none');

 // P2 盲注底池口径
 const HH2=`# PokerGTO HH v1\nGame: NLHE\nStakes: SB=1 BB=2\nTable: 6max\nHero: BB [Kc4c]\nStacks: Hero=100 Villain=100 (BB)\nPreflop: BTN raise 6.0, BB call 6.0\nFlop: [Kd6h9s]  BB check, BTN bet 9.0`;
 await ev("document.querySelector('[data-act=wizTab][data-v=paste]')?.click(); true");await sleep(250);
 await ev(`(() => { const t=document.querySelector('#pasteText'); if(t){t.value=${JSON.stringify(HH2)};t.dispatchEvent(new Event('input',{bubbles:true}));} return !!t; })()`);
 await ev("document.querySelector('[data-act=parsePaste]')?.click(); true");await sleep(400);
 await ev("document.querySelector('[data-act=useParsed]')?.click(); true");await sleep(2600);
 const pot=await ev(`(() => ({node:document.querySelector('.dp-node')?.textContent||'', why:[...document.querySelectorAll('.why-line')].map(x=>x.textContent.trim()) }))()`);
 ok('盲注口径：底池=22（与累计投入自洽）',/22(\.0)?\s*BB/.test(pot.node)||/22(\.0)?\s*BB/.test(pot.why.join(' ')),pot.node.slice(0,120));
 ok('无 JS 异常',await ev("(window.__errors||[]).length === 0"));
 await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await sleep(300);
 const ov=await ev("document.documentElement.scrollWidth - document.documentElement.clientWidth");
 ok('手机 390px 无横向溢出',ov<=2,'overflow='+ov);
 ws.close();console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);if(fail)process.exitCode=1;
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{chrome.kill();srv.kill();});
