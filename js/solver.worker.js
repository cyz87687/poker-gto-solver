/* solver.worker.js —— Web Worker 求解协议（PRD 8.1）
 * 单个 Worker 只处理一个任务；主线程负责排队与通过 terminate 实现取消。
 */
import { solveCore, previewCore } from './solver-core.js';

self.onmessage = ev => {
  const msg = ev.data || {};
  const { type, jobId } = msg;
  const started = Date.now();
  const progress = (pct, label, info) => {
    const elapsed = Date.now() - started;
    const etaMs = pct > 0.05 ? Math.round(elapsed * (1 - pct) / pct) : null;
    self.postMessage({
      type: 'progress', jobId, pct: Math.max(0, Math.min(1, pct)), label, etaMs,
      // V1.14：停止指标随进度实时回传；迭代次数仅作辅助信息
      exploitabilityMbb: info && info.exploitabilityMbb != null ? info.exploitabilityMbb : null,
      targetMbb: info && info.targetMbb != null ? info.targetMbb : null,
      converged: !!(info && info.converged),
      iterations: info && info.iterations != null ? info.iterations : null
    });
  };
  try {
    if (type === 'solve') {
      const result = solveCore(msg.req, progress);
      self.postMessage({ type: 'result', jobId, result });
    } else if (type === 'preview') {
      const result = previewCore(msg.req, msg.actionLabel || '', progress);
      self.postMessage({ type: 'previewResult', jobId, result });
    } else {
      self.postMessage({ type: 'error', jobId, message: '未知任务类型：' + type });
    }
  } catch (err) {
    self.postMessage({ type: 'error', jobId, message: err && err.message ? err.message : String(err) });
  }
};
