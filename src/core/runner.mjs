/**
 * runner —— 执行层。CLI（psx）和 MCP server 共用这一份，避免两处逻辑漂移。
 *
 * 后端：
 *   com   走 PowerShell + COM 驱动桌面版 Photoshop（默认）
 *   mock  在 Node 的 vm 里跑同一份 .jsx，只把宿主对象换成模拟层（PSX_BACKEND=mock）
 *
 * 默认是 com 而不是 mock：宁可明确报 photoshop_not_available，也不让调用方
 * 把模拟结果当成真的改了图。
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TOOLS, BY_NAME, listTools, groups, groupOf, GROUP_LABELS } from '../cli/catalog.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const ENGINE = path.join(ROOT, 'src/engine/anime_engine.jsx');
const CORE = path.join(ROOT, 'src/engine/ps_core.jsx');
const SERIALIZE = path.join(ROOT, 'src/engine/serialize.jsx');
const EXT = path.join(ROOT, 'src/engine/ext.jsx');
const WORKER = path.join(ROOT, 'src/host/ps-worker.ps1');
const DIALOG_HANDLER = path.join(ROOT, 'src/host/dialog-handler.ps1');

/**
 * 跑宿主侧的弹窗处理器。
 * 弹窗为什么必须在这里处理：原生模态框弹出时，执行 DoJavaScript 的那条 JSX 线程
 * 就是被冻住的线程，PS 侧无法自救；只有独立宿主进程能 EnumWindows 看到并点掉它。
 */
function runDialogHandler(action, policy) {
  if (!fs.existsSync(DIALOG_HANDLER)) {
    return { ok: false, error: 'host_missing', message: '缺少 src/host/dialog-handler.ps1' };
  }
  const r = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', DIALOG_HANDLER, '-Action', action, '-Policy', policy
  ], { encoding: 'utf8', timeout: 30000 });

  if (r.error) {
    return { ok: false, error: 'powershell_unavailable', message: `无法启动 PowerShell：${r.error.message}` };
  }
  const text = (r.stdout || '').trim();
  if (!text) {
    return {
      ok: false,
      error: 'dialog_handler_no_output',
      message: `弹窗处理器无输出。stderr=${(r.stderr || '').trim().slice(0, 400)}`
    };
  }
  const last = text.split(/\r?\n/).pop();
  try { return JSON.parse(last); }
  catch { return { ok: false, error: 'dialog_handler_bad_json', message: text.slice(0, 400) }; }
}

/** 这些 engine op 不针对已有文档，缺失 document_id 时不该去查 status。 */
const NO_DOC_OP = new Set(['status', 'create', 'open']);

// ---------------------------------------------------------------- mock 后端

async function makeMockBackend() {
  const { createJsxHost } = await import('../mock/jsx-host.mjs');
  const host = await createJsxHost({ workDir: path.join(ROOT, 'tests/.work') });
  // 只读一次，常驻进程里别重复读盘
  const coreBundle = [CORE, EXT, SERIALIZE].map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const seeded = { done: false };

  return {
    name: 'mock',
    persistent: true,
    async call(tool, args) {
      if (tool.kind === 'engine') {
        return host.runJsxFile(ENGINE, { operation: tool.op, args: args || {} });
      }
      const literal = JSON.stringify(args || {})
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
      const wrapper = `${coreBundle}
;(function () {
  var a = ${literal};
  var r = (${tool.expr});
  return __PSX.safe(typeof r === 'undefined' ? 'ok' : r);
}());`;
      const raw = host.evalJsx(wrapper, `core:${tool.name}`);
      return JSON.parse(raw);
    },
    ensureDoc() {
      if (seeded.done) return;
      seeded.done = true;
      // 造一个「典型工作文档」而不是只有背景层：文字工具（text.update / text.style）
      // 需要真有文字层可操作，否则离线自检会给出假阴性。
      host.bootstrapDocument({
        id: 1, name: 'mock.psd', width: 1200, height: 900,
        layers: [
          { id: 1, name: 'Background', isBackgroundLayer: true },
          { id: 2, name: 'Title', kindName: 'TEXT', contents: 'Mock Title' },
          { id: 3, name: 'Shape 1' }
        ]
      });
    },
    seed(spec) { host.bootstrapDocument(spec); },
    close() {}
  };
}

// ---------------------------------------------------------------- COM 后端

function makeComBackend() {
  return {
    name: 'com',
    persistent: true,
    async call(tool, args) {
      if (!fs.existsSync(WORKER)) {
        return { ok: false, error: 'host_missing', message: '缺少 src/host/ps-worker.ps1' };
      }
      const payload = JSON.stringify({
        name: tool.name, kind: tool.kind, op: tool.op, expr: tool.expr, args: args || {}
      });
      const r = spawnSync('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WORKER],
        { input: payload, encoding: 'utf8', timeout: 180000 });

      if (r.error) {
        return { ok: false, error: 'powershell_unavailable', message: `无法启动 PowerShell：${r.error.message}` };
      }
      const text = (r.stdout || '').trim();
      if (!text) {
        return {
          ok: false,
          error: 'worker_no_output',
          message: `COM worker 无输出。stderr=${(r.stderr || '').trim().slice(0, 400)}`
        };
      }
      const last = text.split(/\r?\n/).pop();
      try { return JSON.parse(last); }
      catch { return { ok: false, error: 'worker_bad_json', message: text.slice(0, 400) }; }
    },
    ensureDoc() {},
    seed() {},
    close() {}
  };
}

// ---------------------------------------------------------------- ComfyUI

/**
 * 找 ComfyUI 根目录（含 input / output 的那一层）。
 * 绘世整合包的实际布局是 D:/ComfyUI/ComfyUI/ComfyUI，所以按候选列表逐个探测，
 * 而不是写死一层。
 */
export function resolveComfyRoot(explicit) {
  const candidates = [
    explicit,
    process.env.PSX_COMFY_ROOT,
    'D:/ComfyUI/ComfyUI/ComfyUI',
    'D:/ComfyUI/ComfyUI',
    'D:/ComfyUI',
    'C:/ComfyUI'
  ].filter(Boolean);

  for (const c of candidates) {
    const p = String(c).replace(/\\/g, '/');
    try {
      if (fs.statSync(p).isDirectory() && (fs.existsSync(path.join(p, 'output')) || fs.existsSync(path.join(p, 'main.py')))) {
        return p;
      }
    } catch { /* 不存在就继续 */ }
  }
  return null;
}

function comfyStatus() {
  const root = resolveComfyRoot();
  if (!root) {
    return Promise.resolve({
      ok: false,
      error: 'comfy_root_not_found',
      message: '找不到 ComfyUI 根目录，请设置 PSX_COMFY_ROOT',
      hint: '例如 PSX_COMFY_ROOT=D:/ComfyUI/ComfyUI/ComfyUI'
    });
  }
  const input = path.join(root, 'input');
  const output = path.join(root, 'output');
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: 8188, path: '/system_stats', timeout: 1500 }, (res) => {
      res.resume();
      resolve({
        ok: true, root, input, output,
        inputExists: fs.existsSync(input), outputExists: fs.existsSync(output),
        server: res.statusCode === 200 ? 'listening' : `http_${res.statusCode}`,
        note: '文件级衔接：export 写 input，place_latest 读 output。不做 API 提交'
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: true, root, input, output, server: 'not_listening' }); });
    req.on('error', () => resolve({ ok: true, root, input, output, server: 'not_listening' }));
  });
}

function latestFile(dir, pattern) {
  if (!fs.existsSync(dir)) return null;
  const re = pattern ? new RegExp(pattern) : /\.(png|jpg|jpeg|webp)$/i;
  const files = fs.readdirSync(dir)
    .filter((f) => re.test(f))
    .map((f) => ({ f, p: path.join(dir, f), t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return files.length ? files[0] : null;
}

// ---------------------------------------------------------------- Runner

export class Runner {
  constructor({ backend = 'com', workDir } = {}) {
    this.backendName = String(backend || 'com').toLowerCase() === 'mock' ? 'mock' : 'com';
    this.workDir = workDir;
    this._backend = null;
    this.stats = { calls: 0, failures: 0 };
  }

  async backend() {
    if (!this._backend) {
      this._backend = this.backendName === 'mock' ? await makeMockBackend() : makeComBackend();
    }
    return this._backend;
  }

  /** 解析并校验工具；未知工具给出近似建议。 */
  tool(name) {
    const t = BY_NAME.get(name);
    if (t) return t;
    const near = TOOLS.filter((x) => x.name.includes(String(name)) || String(name).includes(groupOf(x.name)))
      .slice(0, 5).map((x) => x.name);
    const err = new Error(`未知工具 ${name}${near.length ? `；相近的有：${near.join(', ')}` : ''}`);
    err.code = 'unknown_tool';
    err.suggestions = near;
    throw err;
  }

  async call(name, args = {}, opts = {}) {
    const tool = this.tool(name);
    this.stats.calls++;

    // node 类工具在 Node 侧执行，必要时回头再调引擎工具
    if (tool.kind === 'node') {
      const out = await this._callNode(tool, args, opts);
      if (out && out.ok === false) this.stats.failures++;
      return { tool: tool.name, backend: 'node', ...out };
    }

    const backend = await this.backend();
    if (backend.name === 'mock' && !opts.noSeed) backend.ensureDoc();

    // 只传调用方给的东西。demo 只用于 ps_describe 展示与目录自检，
    // 绝不能在这里兜底 —— 否则「缺必填参数」会被悄悄补成示例值，
    // 调用方以为按自己的意图改了图，实际跑的是 demo。
    const merged = { ...(tool.defaults || {}), ...(args || {}) };
    // document_id 支持从顶层 opts 注入（agent 不必每条都带）
    if (opts.documentId !== undefined && merged.document_id === undefined) merged.document_id = opts.documentId;

    // engine 的绝大多数 op 都走 getDocument(args.document_id)，不传就抛
    // 「找不到 document_id=undefined」。与其让每次调用都要求 agent 先 status，
    // 这里在缺失时补一次 —— 只在真缺的时候多一个往返，正常调用没有额外成本。
    if (tool.kind === 'engine' && merged.document_id === undefined && !NO_DOC_OP.has(tool.op)) {
      const st = await backend.call(BY_NAME.get('status'), {});
      const docs = st && st.value && st.value.documents;
      if (docs && docs.length) merged.document_id = docs[0].document_id;
    }

    const missing = (tool.required || []).filter((k) => merged[k] === undefined || merged[k] === null || merged[k] === '');
    if (missing.length) {
      this.stats.failures++;
      return {
        tool: tool.name,
        backend: backend.name,
        ok: false,
        error: 'missing_args',
        message: `缺少必填参数：${missing.join(', ')}`,
        required: tool.required,
        demo: tool.demo
      };
    }

    // 运行期参数校验（H3）：此前 additionalProperties:false 只活在 describe 生成器，
    // 运行期零校验 —— 传 bogusxyz=hello 也会返回 ok:true，调用方以为参数生效了。
    // 这里只拦「未知参数」这一类（最危险且零误伤）：拼错名字会被静默丢弃，用户拿到假成功。
    const declared = new Set([...Object.keys(tool.args || {}), 'document_id']);
    const unknown = Object.keys(merged).filter((k) => !declared.has(k));
    if (unknown.length) {
      this.stats.failures++;
      return {
        tool: tool.name,
        backend: backend.name,
        ok: false,
        error: 'unknown_args',
        message: `未知参数：${unknown.join(', ')}。该工具接受：${[...declared].join(', ') || '无参数'}`,
        unknown,
        accepted: [...declared],
        demo: tool.demo
      };
    }

    // 几何校验（D1）：shape.* / sel.rect / sel.oval 走同一套矩形语义。
    // 实测两种坏形态：矩形反序（r<l）会触发 PS 原生弹窗并冻结实例；零面积（r==l）
    // 反而返回 ok:true —— L1 里那条 shape.rect PASS 就是零面积假通过。
    // 这里在调用前拦掉，两种坏形态都变成可读错误。
    const recty = ['l', 't', 'r', 'b'].every((k) => merged[k] !== undefined);
    if (recty && (Number(merged.r) <= Number(merged.l) || Number(merged.b) <= Number(merged.t))) {
      this.stats.failures++;
      return {
        tool: tool.name,
        backend: backend.name,
        ok: false,
        error: 'bad_geometry',
        message: `矩形无效：需要 r>l 且 b>t，收到 l=${merged.l} t=${merged.t} r=${merged.r} b=${merged.b}`,
        got: { l: merged.l, t: merged.t, r: merged.r, b: merged.b }
      };
    }
    if (tool.name === 'shape.line' && merged.x1 !== undefined) {
      if (Number(merged.x1) === Number(merged.x2) && Number(merged.y1) === Number(merged.y2)) {
        this.stats.failures++;
        return {
          tool: tool.name,
          backend: backend.name,
          ok: false,
          error: 'bad_geometry',
          message: `直线无效：起点与终点重合 (${merged.x1},${merged.y1})`
        };
      }
    }

    // 运行期上下文预检（B2）：这组工具缺前置状态时会触发 PS 原生告警框并把
    // 整个实例冻结 —— 实测一次冻结 = 28s 超时 + 解卡 + 连带污染后续几十条调用。
    // 这里花一次 status（约 1.3s）换掉那个最坏形态。
    const NEEDS_SELECTION = new Set([
      'sel.grow', 'sel.expand', 'sel.contract', 'sel.smooth', 'sel.border',
      'sel.intersect_rect', 'sel.bounds', 'sel.copy', 'sel.copy_merged',
      'sel.cut', 'sel.paste', 'sel.delete', 'sel.similar', 'sel.fill',
      'mask.add'
    ]);
    const NEEDS_LAYER = new Set(['mask.add', 'mask.invert', 'mask.delete', 'mask.hide']);
    if (NEEDS_SELECTION.has(tool.name) || NEEDS_LAYER.has(tool.name)) {
      const st = await backend.call(BY_NAME.get('status'), {});
      const sval = (st && st.value) || {};
      const sdocs = sval.documents || [];
      if (!sdocs.length) {
        this.stats.failures++;
        return { tool: tool.name, backend: backend.name, ok: false, error: 'no_document', message: '没有打开的文档，请先 doc.open / doc.create' };
      }
      const targetId = merged.document_id !== undefined ? merged.document_id : sval.active_document_id;
      const sdoc = sdocs.find((d) => d.document_id === targetId) || sdocs[0];
      if (NEEDS_SELECTION.has(tool.name) && !(sdoc.selection && sdoc.selection.active)) {
        this.stats.failures++;
        return {
          tool: tool.name,
          backend: backend.name,
          ok: false,
          error: 'no_selection',
          message: `${tool.name} 需要活动选区。无选区时该命令会弹 PS 原生告警框并冻结整个实例（实测 28s 超时 + 连带失败），已在调用前拦下。`,
          hint: 'node src/cli/psx.mjs run sel.rect --arg l=10 --arg t=10 --arg r=200 --arg b=200'
        };
      }
      if (NEEDS_LAYER.has(tool.name) && (sdoc.active_layer_id === null || sdoc.active_layer_id === undefined)) {
        this.stats.failures++;
        return { tool: tool.name, backend: backend.name, ok: false, error: 'no_layer', message: '没有可作用的图层，请先建立或选中图层' };
      }
    }

    let raw;
    try {
      // layer.place 走宿主侧两段式（剪贴板）：PS 27 不允许关闭「非最前」文档，而该错误
      // 在 JSX 内是不可捕获的运行时错误。拆成多次 DoJavaScript 后每步的活动文档都干净：
      //   开源文档 → 全选 → 拷贝 → 关源文档 → 在目标文档粘贴（即得到置入图层）
      if (tool.name === 'layer.place') {
        raw = await this._placeViaClipboard(merged, backend);
      } else {
        raw = await backend.call(tool, merged);
      }
    } catch (e) {
      this.stats.failures++;
      return { tool: tool.name, backend: backend.name, ok: false, error: 'host_error', message: String(e && e.message || e) };
    }
    const out = { tool: tool.name, backend: backend.name, ...raw };
    if (out.ok === false) this.stats.failures++;
    return out;
  }

  async _callNode(tool, args, opts) {
    switch (tool.name) {
      case 'batch.run':
        return this.plan(args.steps || [], {
          stopOnError: args.stop_on_error !== false,
          documentId: args.document_id !== undefined ? args.document_id : opts.documentId
        });

      case 'history.undo_n': {
        const n = Math.max(1, Number(args.times) || 1);
        const done = [];
        for (let i = 0; i < n; i++) {
          const r = await this.call('history.undo', { document_id: args.document_id }, opts);
          done.push(r.ok !== false);
          if (r.ok === false) break;
        }
        return { ok: true, undone: done.filter(Boolean).length, requested: n };
      }

      case 'comfy.status':
        return comfyStatus();

      case 'comfy.export': {
        const st = await comfyStatus();
        if (st.ok === false) return st;
        const name = args.filename || `ps-${Date.now()}.png`;
        const target = path.join(st.input, name);
        try { fs.mkdirSync(st.input, { recursive: true }); } catch { /* 已存在 */ }
        const saved = await this.call('save.png', { path: target.replace(/\\/g, '/'), document_id: args.document_id }, opts);
        if (saved.ok === false) return { ok: false, error: 'save_failed', detail: saved };
        return {
          ok: true,
          file: target,
          comfy_input_name: name,
          hint: '把这个文件名填到 ComfyUI 的 LoadImage 节点'
        };
      }

      case 'comfy.place_latest': {
        const st = await comfyStatus();
        if (st.ok === false) return st;
        let picked;
        if (args.filename) {
          picked = { f: args.filename, p: path.join(st.output, args.filename) };
        } else {
          picked = latestFile(st.output, args.pattern);
        }
        if (!picked) return { ok: false, error: 'no_output_file', message: `在 ${st.output} 没找到图片` };
        if (!fs.existsSync(picked.p)) return { ok: false, error: 'file_not_found', message: picked.p };
        const placed = await this.call('layer.place', {
          path: picked.p.replace(/\\/g, '/'), x: args.x, y: args.y, document_id: args.document_id
        }, opts);
        return { ok: placed.ok !== false, file: picked.p, place: placed };
      }

      case 'dialog.scan':
        return runDialogHandler('scan', 'auto');

      case 'dialog.handle': {
        const policy = args.policy || 'auto';
        const out = runDialogHandler('handle', policy);
        if (out.ok === false) return out;
        const handled = out.handled || [];
        return {
          ok: true,
          policy,
          handled_count: handled.length,
          handled,
          remaining: (out.dialogs || []).length - handled.length,
          hint: handled.length > 0
            ? '弹窗已处理，原调用可能已返回错误，重试该命令即可'
            : '当前没有可处理的弹窗'
        };
      }

      default:
        return { ok: false, error: 'node_tool_unimplemented', message: `node 工具 ${tool.name} 没有处理器` };
    }
  }

  /**
   * layer.place 的宿主侧两段式实现（剪贴板通道）。
   * 为什么不走 JSX：PS 27 关闭「非最前」文档抛的是不可捕获的运行时错误，
   * 于是「层已置入成功」会被误报为失败并遗留临时文档。拆成多次 DoJavaScript，
   * 每步活动文档由 document_id 锚定（H2），即可稳定收尾。
   */
  async _placeViaClipboard(args, backend) {
    const targetId = args.document_id;
    const byName = (n) => BY_NAME.get(n);
    const step = (n, extra) => backend.call(byName(n), { ...extra });

    const opened = await step('doc.open', { path: args.path });
    if (!opened || opened.ok === false) {
      return { ok: false, error: 'place_open_failed', message: (opened && opened.message) || '无法打开素材文件' };
    }
    const srcId = opened.value && opened.value.document_id;
    if (srcId === undefined) {
      return { ok: false, error: 'place_open_failed', message: '打开素材后没有拿到 document_id' };
    }

    let copied = null;
    try {
      await step('sel.all', { document_id: srcId });
      copied = await step('sel.copy', { document_id: srcId });
    } finally {
      await step('doc.close', { document_id: srcId, save: false });
    }
    if (!copied || copied.ok === false) {
      return { ok: false, error: 'place_copy_failed', message: (copied && copied.message) || '拷贝素材内容失败' };
    }

    const pasted = await step('sel.paste', { document_id: targetId });
    if (!pasted || pasted.ok === false) {
      return { ok: false, error: 'place_paste_failed', message: (pasted && pasted.message) || '粘贴到目标文档失败' };
    }
    return {
      ok: true,
      value: {
        document_id: targetId,
        layer_id: pasted.value && pasted.value.layer_id,
        placed: true,
        via: 'clipboard-two-phase',
        source_closed: true
      }
    };
  }

  /** 串跑多步，保持文档状态。返回逐步结果，方便定位哪一步崩的。 */
  async plan(steps, { stopOnError = true, documentId } = {}) {
    const results = [];
    for (const step of steps) {
      const name = typeof step === 'string' ? step : step.name;
      const args = (typeof step === 'string' ? {} : step.args) || {};
      const docId = (typeof step === 'object' && step.document_id !== undefined) ? step.document_id : documentId;
      const r = await this.call(name, args, { documentId: docId });
      results.push({ step: results.length + 1, name, ok: r.ok !== false, result: r });
      if (r.ok === false && stopOnError) break;
    }
    const failed = results.filter((r) => !r.ok);
    return {
      ok: failed.length === 0,
      total: steps.length,
      completed: results.length,
      failed: failed.length,
      results
    };
  }

  close() {
    if (this._backend && this._backend.close) this._backend.close();
    this._backend = null;
  }
}

/** 同步构造；后端在第一次调用时才初始化（避免仅查询工具面时也去碰 PowerShell）。 */
export function createRunner(opts = {}) {
  return new Runner(opts);
}

// ---------------------------------------------------------------- 检索

/**
 * 中文 → 英文/工具名的意图别名。
 *
 * 工具名和摘要都是英文标识符 + 简短中文说明，而用户（和 agent）更常用「合并图层」
 * 这种纯中文说法。没有这层映射，中文查询会全空 —— 这是三段式方案最容易翻车的地方。
 */
const ALIASES = {
  合并: ['merge'], 拼合: ['flatten'], 复制: ['duplicate', 'copy'], 删除: ['delete'],
  编组: ['group'], 成组: ['group'], 解散: ['ungroup'], 属性: ['props'],
  不透明: ['opacity'], 混合: ['blend'], 可见: ['visible'], 顺序: ['move', 'order'],
  图层: ['layer'], 导出: ['export'], 置入: ['place'], 智能对象: ['smart'],
  蒙版: ['mask'], 遮罩: ['mask'], 选区: ['sel', 'selection'], 选择: ['sel', 'select'],
  主体: ['subject'], 天空: ['sky'], 反选: ['inverse'], 羽化: ['feather'],
  扩展: ['expand'], 收缩: ['contract'], 平滑: ['smooth'], 边框: ['border'], 填充: ['fill'],
  文字: ['text'], 字体: ['font'], 行距: ['leading'], 字距: ['tracking'], 文案: ['contents'],
  标题: ['text'], 字幕: ['text'], 加字: ['text'], 排版: ['text', 'font'],
  形状: ['shape'], 矩形: ['rect'], 椭圆: ['oval', 'ellipse'], 圆角: ['rounded'],
  直线: ['line'], 多边形: ['polygon'],
  调整: ['adj', 'adjust'], 亮度: ['brightness'], 对比: ['contrast'], 曲线: ['curves'],
  色阶: ['levels'], 色相: ['hue'], 饱和: ['satur'], 自然饱和: ['vibrance'],
  黑白: ['black', 'white'], 色彩平衡: ['colorbalance', 'color_balance'],
  曝光: ['exposure'], 反相: ['invert'], 渐变映射: ['gradientmap', 'gradient_map'],
  阈值: ['threshold'], 色调分离: ['posterize'], 照片滤镜: ['photofilter', 'photo_filter'],
  可选颜色: ['selectivecolor', 'selective_color'], 通道: ['channel'],
  投影: ['shadow'], 描边: ['stroke'], 内阴影: ['innershadow', 'inner_shadow'],
  发光: ['glow'], 斜面: ['bevel'], 浮雕: ['bevel'], 叠加: ['overlay'],
  模糊: ['blur'], 高斯: ['gaussian'], 动感: ['motion'],
  旋转: ['rotate'], 翻转: ['flip'], 缩放: ['resize', 'scale'], 裁剪: ['crop'], 裁切: ['crop'],
  方形: ['crop', 'resize'], 正方形: ['crop', 'resize'], 尺寸: ['resize', 'crop'],
  拉直: ['straighten'], 保存: ['save'], 打开: ['open'], 新建: ['create'],
  线稿: ['lineart'], 描线: ['lineart'], 上色: ['paint'], 改色: ['recolor', 'local_edit'],
  生图: ['comfy'], 出图: ['comfy'], 批量: ['batch'], 撤销: ['undo'], 状态: ['status']
};

/** 把查询串展开成「原串 + 分词 + 中文别名对应的英文词」。 */
function expandTerms(query) {
  const q = String(query).toLowerCase();
  const terms = new Set([q]);
  // 点号和常见分隔符都算边界：查 "layer.fly" 时也要能拆出 "layer" 去命中同组工具
  for (const w of q.split(/[\s,，、./]+/).filter(Boolean)) terms.add(w);
  for (const [cn, ens] of Object.entries(ALIASES)) {
    if (q.includes(cn)) for (const e of ens) terms.add(e);
  }
  return [...terms];
}

/**
 * 三阶段检索的第一阶段（ps_search 用）。
 * 评分有意做得可预测：精确名 > 末段命中 > 名字含 > 摘要含 > 分组含，
 * 命中的词越多分越高。
 */
export function searchTools(query, { group, limit = 12, offlineOnly = false } = {}) {
  let pool = TOOLS;
  if (group) pool = pool.filter((t) => groupOf(t.name) === group || t.name === group);
  if (offlineOnly) pool = pool.filter((t) => t.needs !== 'ps');
  if (!query) return pool.slice(0, limit).map(brief);

  const q = String(query).toLowerCase().trim();
  const terms = expandTerms(query);
  const scored = [];

  for (const t of pool) {
    const n = t.name.toLowerCase();
    const tail = n.split('.').pop();
    const s = String(t.summary || '').toLowerCase();
    const g = groupOf(n);
    let score = 0;

    if (n === q) score += 120;
    for (const term of terms) {
      if (!term) continue;
      if (tail === term) score += 45;
      else if (tail.includes(term)) score += 28;
      else if (n.includes(term)) score += 16;
      if (s.includes(term)) score += 8;
      if (g.includes(term)) score += 5;
    }
    if (score > 0) scored.push({ t, score });
  }

  scored.sort((a, b) => b.score - a.score || a.t.name.localeCompare(b.t.name));
  return scored.slice(0, limit).map((x) => brief(x.t));
}

function brief(t) {
  return {
    name: t.name,
    group: groupOf(t.name),
    summary: t.summary,
    offline: t.needs !== 'ps',
    required: t.required || []
  };
}

export function describeTool(name) {
  const t = BY_NAME.get(name);
  if (!t) {
    const near = searchTools(name, { limit: 5 }).map((x) => x.name);
    return { ok: false, error: 'unknown_tool', message: `没有 ${name}`, suggestions: near };
  }
  return {
    ok: true,
    name: t.name,
    group: groupOf(t.name),
    kind: t.kind,
    summary: t.summary,
    args: t.args,
    required: t.required || [],
    demo: t.demo || {},
    defaults: t.defaults || undefined,
    offline: t.needs !== 'ps',
    cloud: !!t.cloud,
    inputSchema: toJsonSchema(t),
    note: t.source ? `语义对齐：${t.source}` : undefined
  };
}

/**
 * 把简化的 args 表转成 JSON Schema。
 * 这一层存在的意义：agent 拿到的必须是标准 schema，而不是我们的内部约定。
 */
export function toJsonSchema(tool) {
  const props = {};
  for (const [k, v] of Object.entries(tool.args || {})) {
    props[k] = typeToSchema(v);
  }
  return {
    type: 'object',
    properties: props,
    required: tool.required || [],
    additionalProperties: false
  };
}

function typeToSchema(spec) {
  const s = String(spec);
  const m = s.match(/^array<(.+)>$/);
  if (m) return { type: 'array', items: typeToSchema(m[1]) };
  if (s === 'number') return { type: 'number' };
  if (s === 'boolean') return { type: 'boolean' };
  if (s === 'string') return { type: 'string' };
  if (s === 'object') return { type: 'object' };
  return { type: 'string' };
}

/** 概览：分组 + 每组条数 + 说明。ps_search 无参时用。 */
export function overview() {
  const g = groups();
  return {
    total: TOOLS.length,
    groups: [...g.entries()].map(([name, list]) => ({
      group: name,
      label: GROUP_LABELS[name] || name,
      count: list.length,
      examples: list.slice(0, 3).map((t) => t.name)
    }))
  };
}

export { TOOLS, BY_NAME, listTools, groups, groupOf, GROUP_LABELS };
