import { spawn } from 'node:child_process';

export function asError(reason,fallback='操作失败') {
  if(reason instanceof Error)return reason;
  if(typeof reason==='string'&&reason.trim())return new Error(reason);
  if(typeof reason?.message==='string'&&reason.message.trim())return new Error(reason.message);
  if(typeof reason?.reason==='string'&&reason.reason.trim())return new Error(reason.reason);
  return new Error(fallback);
}

export const powershell = process.platform === 'win32'
  ? `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
  : 'powershell.exe';

// Always pass data as arguments/files. No shell interpolation or executable JS from the model.
export function runProcess(command, args, { signal, onCancel, timeout = 120000, cancelGraceMs = 15000, timeoutMessage } = {}) {
  return new Promise((resolve, reject) => {
    if(signal?.aborted)throw asError(signal.reason,'操作已取消');
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stdout = '', stderr = '', stopped, hardTimer;
    const cancel = reason => {
      if (stopped) return;
      stopped = asError(reason,'操作已取消');
      Promise.resolve(onCancel?.()).catch(() => {});
      // Photoshop checks the marker between strokes. Give its script time to restore state.
      hardTimer = setTimeout(() => child.kill(), cancelGraceMs);
      if (!onCancel) child.kill();
    };
    const abort = () => cancel(signal.reason || new Error('操作已取消'));
    const timer = setTimeout(() => cancel(new Error(timeoutMessage || '操作超时；画布可能已完成部分笔画。停止重试，先检查已保存任务和实际画布，必要时撤销。')), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    const cleanup = () => { clearTimeout(timer); clearTimeout(hardTimer); signal?.removeEventListener('abort', abort); };
    child.stdout.on('data', data => { stdout = (stdout + data.toString('utf8')).slice(-2_000_000); });
    child.stderr.on('data', data => { stderr = (stderr + data.toString('utf8')).slice(-10000); });
    child.on('error', error => { cleanup(); reject(error); });
    child.on('close', code => {
      cleanup();
      if (stopped) reject(stopped);
      else if (code !== 0) reject(new Error(stderr.trim() || stdout.trim() || `${command} exited ${code}`));
      else resolve(stdout.replace(/^\uFEFF/, '').trim());
    });
  });
}
