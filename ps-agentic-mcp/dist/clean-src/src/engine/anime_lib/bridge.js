import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { powershell, runProcess } from './process.js';

const root = fileURLToPath(new URL('../', import.meta.url));
// All plugin instances in this host share a queue. The PowerShell worker also uses a Windows mutex.
let queue = Promise.resolve();
export function exclusive(work) {
  const pending = queue.then(work);
  queue = pending.catch(() => {});
  return pending;
}
const literal = value => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export class PhotoshopBridge {
  constructor(config = {}, { runProcess: runner = runProcess } = {}) {
    this.runner = runner;
    this.timeout = config.timeoutMs ?? 180000;
    this.outputDir = config.outputDir || path.join(process.env.DSH_HOME || path.join(homedir(), '.dsh'), 'outputs', 'photoshop');
  }
  async run(operation, args = {}, signal) {
    if (process.platform !== 'win32') throw new Error('本插件的 Photoshop COM 桥接目前仅支持 Windows 桌面版 Photoshop');
    signal?.throwIfAborted();
    const readOnly=operation==='status'||operation==='info';
    const timeout=readOnly?Math.min(this.timeout,15000):this.timeout;
    const temp = await mkdtemp(path.join(tmpdir(), 'dsh-ps-'));
    const request = path.join(temp, 'request.json'), cancel = path.join(temp, 'cancel'), result = path.join(temp, 'result.json');
    try {
      await writeFile(request, literal({ operation, args, cancel_file: cancel, deadline: Date.now() + timeout }), 'utf8');
      const script = path.join(temp, 'run.jsx');
      const engine = await readFile(path.join(root, 'photoshop', 'engine.jsx'), 'utf8');
      await writeFile(script, `var DSH_REQUEST_FILE=${literal(request)};\n${engine}`, 'utf8');
      await this.runner(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA',
        '-File', path.join(root, 'scripts', 'invoke-photoshop.ps1'), '-ScriptPath', script, '-ResultPath', result,
        '-CancelPath', cancel, '-TimeoutSeconds', String(Math.ceil(timeout / 1000)),...(readOnly?['-RequireRunning']:[])], {
        signal, timeout: timeout + 2000, cancelGraceMs:readOnly?1000:15000,
        ...(readOnly?{timeoutMessage:'Photoshop 状态查询超时；未执行绘图。停止自动重试，待用户处理忙碌或弹窗后再检查。'}:{}),
        onCancel: () => writeFile(cancel, 'cancel', 'utf8')
      });
      const value = JSON.parse((await readFile(result, 'utf8')).replace(/^\uFEFF/, ''));
      if (!value.ok) throw new Error(value.error || 'Photoshop 操作失败');
      return value.value;
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
  async outputPath(prefix = 'preview', extension = 'png') {
    await mkdir(this.outputDir, { recursive: true });
    return path.join(this.outputDir, `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.${extension}`);
  }
}

export async function sampleImage(imagePath, maxSide = 192, signal, options = {}) {
  if (process.platform !== 'win32') throw new Error('图像采样目前需要 Windows System.Drawing');
  const extra = options.preserveAlpha ? ['-PreserveAlpha'] : [];
  if (options.crop) for (const key of ['x', 'y', 'width', 'height']) extra.push('-Crop' + key[0].toUpperCase() + key.slice(1), String(options.crop[key]));
  const stdout = await runProcess(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(root, 'scripts', 'sample-image.ps1'), '-ImagePath', imagePath, '-MaxSide', String(maxSide), ...extra], { signal, timeout: 60000 });
  const data = JSON.parse(stdout);
  const rgb = Buffer.from(data.rgb, 'base64');
  if (rgb.length !== data.width * data.height * 3) throw new Error('参考图采样数据不完整');
  const alpha = data.alpha ? Buffer.from(data.alpha, 'base64') : undefined;
  if (alpha && alpha.length !== data.width * data.height) throw new Error('参考图透明度数据不完整');
  return { ...data, rgb, ...(alpha ? { alpha } : {}) };
}
