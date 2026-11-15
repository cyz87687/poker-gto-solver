/* charts.js —— Canvas 图表（无外部依赖，离线可用）
 * 红涨绿跌：盈利红、亏损绿（A 股习惯）
 */
import { RANKS, classLabel } from './cards.js';

const UP = '#d92b2b', DOWN = '#128a56', ACCENT = '#3b5bdb';
const GRID = '#e6e9ef', TEXT = '#5c6675', SURFACE = '#ffffff';
function setup(canvas, cssW, cssH) {
  const dpr = Math.min(2.5, (typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1));
  canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
  canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.fillStyle = SURFACE; ctx.fillRect(0, 0, cssW, cssH);
  return { ctx, w: cssW, h: cssH };
}
function niceRange(min, max) {
  if (min === max) { min -= 1; max += 1; }
  const pad = (max - min) * 0.15;
  return [min - pad, max + pad];
}
export function drawCurve(canvas, points, opts = {}) {
  const cssW = canvas.parentElement ? Math.max(280, canvas.parentElement.clientWidth) : 600;
  const h = opts.height || 190;
  const { ctx, w } = setup(canvas, cssW, h);
  const pad = { l: 48, r: 12, t: 14, b: 26 };
  const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  if (!points.length) {
    ctx.fillStyle = TEXT; ctx.font = '12px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('暂无对局数据', w / 2, h / 2); return () => null;
  }
  const vals = points.map(p => p.value);
  let [lo, hi] = niceRange(Math.min(0, ...vals), Math.max(0, ...vals));
  const y = v => pad.t + ih - (v - lo) / (hi - lo) * ih;
  const x = i => pad.l + (points.length === 1 ? iw / 2 : i * iw / (points.length - 1));
  ctx.strokeStyle = GRID; ctx.lineWidth = 1;
  for (let k = 0; k <= 4; k++) {
    const v = lo + (hi - lo) * k / 4, yy = y(v);
    ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(w - pad.r, yy); ctx.stroke();
    ctx.fillStyle = TEXT; ctx.font = '10px sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText(v.toFixed(0), pad.l - 6, yy);
  }
  if (lo < 0 && hi > 0) {
    ctx.strokeStyle = '#c9ced8'; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(pad.l, y(0)); ctx.lineTo(w - pad.r, y(0)); ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.beginPath();
  points.forEach((p, i) => { const xx = x(i), yy = y(p.value); i ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy); });
  ctx.strokeStyle = ACCENT; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
  const last = points[points.length - 1];
  ctx.fillStyle = last.value >= 0 ? UP : DOWN;
  ctx.beginPath(); ctx.arc(x(points.length - 1), y(last.value), 3.5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = TEXT; ctx.font = '10px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const step = Math.max(1, Math.ceil(points.length / 5));
  points.forEach((p, i) => { if (i % step === 0 || i === points.length - 1) ctx.fillText(String(p.label || '').slice(0, 8), x(i), h - pad.b + 6); });
  return px => {
    if (points.length === 1) return points[0];
    const i = Math.round((px - pad.l) / iw * (points.length - 1));
    return points[Math.max(0, Math.min(points.length - 1, i))] || null;
  };
}
export function drawBars(canvas, values, opts = {}) {
  const cssW = canvas.parentElement ? Math.max(280, canvas.parentElement.clientWidth) : 600;
  const h = opts.height || 170;
  const { ctx, w } = setup(canvas, cssW, h);
  const pad = { l: 46, r: 12, t: 12, b: 26 };
  const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  if (!values.length) { ctx.fillStyle = TEXT; ctx.font = '12px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('暂无对局数据', w / 2, h / 2); return; }
  const max = Math.max(1, ...values.map(v => Math.abs(v.value)));
  const lo = -max * 1.1, hi = max * 1.1;
  const y = v => pad.t + ih - (v - lo) / (hi - lo) * ih;
  ctx.strokeStyle = GRID; ctx.lineWidth = 1;
  for (const v of [hi, 0, lo]) {
    const yy = y(v); ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(w - pad.r, yy); ctx.stroke();
    ctx.fillStyle = TEXT; ctx.font = '10px sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText(v.toFixed(0), pad.l - 6, yy);
  }
  const bw = Math.min(34, iw / values.length * 0.65);
  values.forEach((v, i) => {
    const xx = pad.l + (i + 0.5) * iw / values.length - bw / 2;
    const yy = y(Math.max(0, v.value)), y0 = y(0);
    ctx.fillStyle = v.value >= 0 ? UP : DOWN;
    ctx.fillRect(xx, Math.min(yy, y0), bw, Math.max(2, Math.abs(y0 - yy)));
    if (values.length <= 14) {
      ctx.fillStyle = TEXT; ctx.font = '10px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(String(v.label || '').slice(0, 6), xx + bw / 2, h - pad.b + 6);
    }
  });
}
function heatColor(v) {
  const t = Math.max(0, Math.min(1, v));
  const a = [238, 242, 255], b = [59, 91, 219];
  const c = a.map((x, i) => Math.round(x + (b[i] - x) * t));
  return { fill: `rgb(${c[0]},${c[1]},${c[2]})`, light: t > 0.55 };
}
export function renderHeatmapGrid(container, matrix, opts = {}) {
  const title = opts.title || '范围热力图';
  const legend = opts.legend || '颜色越深 = 该处进攻/加注频率越高';
  let html = `<div class="small muted" style="margin-bottom:6px">${title}</div><div class="range-wrap"><div class="heat-grid">`;
  html += '<div class="hdr"></div>';
  for (let j = 12; j >= 0; j--) html += `<div class="hdr">${RANKS[j]}</div>`;
  for (let i = 12; i >= 0; i--) {
    html += `<div class="hdr">${RANKS[i]}</div>`;
    for (let j = 12; j >= 0; j--) {
      const v = (matrix && matrix[i] && matrix[i][j]) || 0;
      const c = heatColor(v);
      html += `<div class="cell" style="background:${c.fill};color:${c.light ? '#fff' : '#26303f'}" title="${classLabel(i, j)}: ${(v * 100).toFixed(0)}%">${classLabel(i, j)}</div>`;
    }
  }
  html += '</div></div>';
  html += `<div class="legend" style="margin-top:6px"><span>${legend}</span><span><i style="background:${heatColor(0).fill}"></i>低</span><span><i style="background:${heatColor(1).fill}"></i>高</span></div>`;
  container.innerHTML = html;
}
/** 结果页导出 PNG：生成一张自包含的复盘摘要图 */
export function buildResultImage(result, hand, meta = {}) {
  const w = 760, h = 560;
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#3b5bdb'; ctx.fillRect(0, 0, w, 6);
  ctx.fillStyle = '#1c2330'; ctx.font = '600 22px sans-serif'; ctx.fillText('Poker GTO 复盘摘要', 28, 44);
  ctx.fillStyle = '#5c6675'; ctx.font = '13px sans-serif';
  ctx.fillText(`${meta.date || ''}   ${meta.handCards || ''}   ${meta.board || ''}   ${result.decisionNode || ''}`, 28, 70);
  ctx.fillStyle = '#f0f2f5'; ctx.fillRect(28, 84, w - 56, 34);
  ctx.fillStyle = '#5c6675'; ctx.font = '12px sans-serif';
  ctx.fillText(result.phase === 'preflop' ? '求解口径：翻前近似（起手牌范围权益分档 + 街内 CFR，未展开翻后博弈树）' : '求解口径：10 档牌力抽象 + 街内有限博弈树 + CFR 线性平均（近似均衡）', 38, 106);
  ctx.fillStyle = '#1c2330'; ctx.font = '600 15px sans-serif';
  ctx.fillText(result.mode === 'exploit' ? `剥削路线（对手画像：${result.archetypeLabel || ''}）` : 'GTO 均衡输出', 28, 148);
  const rows = result.actions || [];
  const cols = result.mode === 'exploit' ? ['动作', '剥削频率', '动作 EV(BB)', 'GTO 频率'] : ['动作', '均衡频率', '动作 EV(BB)', '标签'];
  const xs = [30, 330, 470, 620];
  ctx.fillStyle = '#f0f2f5'; ctx.fillRect(28, 160, w - 56, 30);
  ctx.fillStyle = '#5c6675'; ctx.font = '12px sans-serif';
  cols.forEach((c, i) => ctx.fillText(c, xs[i], 180));
  rows.forEach((a, i) => {
    const yy = 210 + i * 30;
    ctx.fillStyle = i % 2 ? '#fafbfd' : '#ffffff'; ctx.fillRect(28, yy - 18, w - 56, 28);
    ctx.fillStyle = '#1c2330'; ctx.font = '13px sans-serif';
    const freq = (a.freq * 100).toFixed(1) + '%';
    const tag = a.freq >= 0.66 ? '高频' : a.freq >= 0.33 ? '混合' : a.freq > 0 ? '低频' : '零频率';
    ctx.fillText(a.label || a.type, xs[0], yy);
    ctx.fillText(freq, xs[1], yy);
    ctx.fillStyle = Number(a.ev) >= 0 ? '#d92b2b' : '#128a56';
    ctx.fillText(Number(a.ev).toFixed(2), xs[2], yy);
    ctx.fillStyle = '#1c2330';
    ctx.fillText(result.mode === 'exploit' ? ((result.gtoActions?.[i]?.freq ?? 0) * 100).toFixed(1) + '%' : tag, xs[3], yy);
  });
  let y = 240 + rows.length * 30;
  ctx.fillStyle = '#1c2330'; ctx.font = '600 14px sans-serif'; ctx.fillText('关键指标', 28, y); y += 24;
  ctx.font = '13px sans-serif'; ctx.fillStyle = '#5c6675';
  const lines = [
    `底池 ${result.pot} BB / 有效后手 ${result.stacks} BB / 迭代 ${result.iterations} 次`,
    result.evLossBB != null ? `实现 EV 差 ${result.evLossBB} BB（基准：${result.mode === 'exploit' ? '剥削路线' : 'GTO 均衡'}）` : '未录入实际动作，隐藏实现 EV 差',
    result.exploitGainBB != null ? `剥削增益 ${result.exploitGainBB} BB（基于对手画像假设）` : `可剥削度 ${result.exploitabilityMbb ?? '—'} mbb/hand`,
    result.phase === 'preflop' ? '口径：翻前近似解，仅供范围对抗参考' : (result.mode === 'exploit' ? '口径：冻结对手画像后求 Hero 最优应对' : '口径：近似均衡（牌力分档抽象 + 街内有限博弈树）')
  ];
  lines.forEach(l => { ctx.fillText(l, 28, y); y += 22; });
  ctx.fillStyle = '#8b94a3'; ctx.font = '11px sans-serif';
  ctx.fillText('Poker GTO 复盘解算器 · 数据保存在本机浏览器', 28, h - 22);
  return cv.toDataURL('image/png');
}
