/* tests/browser/run-all.mjs —— 依次执行浏览器回归（需要本机安装 Google Chrome）
 * 用法：node tests/browser/run-all.mjs
 * 每个脚本独立拉起一次 python http.server 与 headless Chrome，端口互不冲突。
 */
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(dir).filter(f => /^cdp_.*\.mjs$/.test(f)).sort();
let total = 0, failed = 0;
for (const f of files) {
  console.log(`\n===== ${f} =====`);
  const code = await new Promise(res => {
    const p = spawn('node', [join(dir, f)], { stdio: 'inherit' });
    p.on('exit', c => res(c ?? 1));
  });
  if (code !== 0) failed++;
  total++;
}
console.log(`\n浏览器回归：${total - failed}/${total} 个脚本通过`);
if (failed) process.exitCode = 1;
