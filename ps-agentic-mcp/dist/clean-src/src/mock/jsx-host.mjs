/**
 * ExtendScript 宿主 —— 在 Node 里跑真实 .jsx 引擎，无需安装 Photoshop。
 *
 * 用法：
 *   const host = await createJsxHost({ workDir });
 *   await host.loadMock();                       // 载入 Photoshop DOM 模拟
 *   const doc = host.bootstrapDocument({...});   // 造一个文档
 *   const out = await host.runJsx('engine.jsx', { operation: 'status', args: {} });
 *
 * 关键约束（踩过的坑，勿改）：
 *  - 所有对象必须在 vm realm 内创建。宿主 realm 的 Array 传进去，
 *    `x instanceof Array` 会 false，engine 的 stringify 会退化成对象输出。
 *  - ExtendScript 预处理指令（#target / #include / #includepath）不是合法 JS，
 *    必须先剥行，否则 SyntaxError。
 *  - $.global 在真实 ExtendScript 里就是全局对象本身；mock 里指向 vm 的 globalThis。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { charIDToTypeID, stringIDToTypeID } from './typeid.mjs';

const PREPROCESSOR = /^\s*#(target|include|includepath|script|strict)\b.*$/gm;

export function stripExtendScriptDirectives(source) {
  return source.replace(PREPROCESSOR, '');
}

export async function createJsxHost(options = {}) {
  const workDir = options.workDir || process.cwd();
  const sandbox = Object.create(null);

  const hostBridge = {
    readFile(p) {
      return fs.readFileSync(normalize(p), 'utf8');
    },
    writeFile(p, content) {
      const target = normalize(p);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, 'utf8');
      return true;
    },
    exists(p) {
      try { return fs.existsSync(normalize(p)); } catch { return false; }
    },
    mkdirp(p) {
      fs.mkdirSync(normalize(p), { recursive: true });
      return true;
    },
    charIDToTypeID,
    stringIDToTypeID
  };

  const context = vm.createContext(sandbox, {
    name: 'psx-jsx',
    codeGeneration: { strings: true, wasm: false }
  });

  // 注入宿主能力（函数跨 realm 调用是安全的；对象/数组不要预建）
  context.__hostBridge = hostBridge;
  context.DSH_REQUEST_FILE = path.join(normalize(workDir), '__request.json');
  vm.runInContext('globalThis.global = globalThis; globalThis.$ = globalThis.$ || {};', context);

  let mockLoaded = false;
  const host = {
    context,
    workDir: normalize(workDir),
    get mock() {
      if (!mockLoaded) throw new Error('先调用 loadMock()');
      return context.__PSMOCK;
    },
    /** 载入 DOM 模拟层 */
    loadMock() {
      if (mockLoaded) return host.mock;
      const src = fs.readFileSync(new URL('./psdom.jsx', import.meta.url), 'utf8');
      vm.runInContext(src, context, { filename: 'psdom.jsx' });
      mockLoaded = true;
      return context.__PSMOCK;
    },
    reset() {
      if (mockLoaded) context.__PSMOCK.reset();
    },
    /** 造文档（模拟用户已经打开/新建了一张图） */
    bootstrapDocument(spec = {}) {
      host.loadMock();
      const ps = context.__PSMOCK;
      const doc = vm.runInContext(
        `__PSMOCK.makeDocument(${JSON.stringify({
          id: spec.id ?? 1,
          name: spec.name ?? 'test.psd',
          width: spec.width ?? 1024,
          height: spec.height ?? 1024,
          resolution: spec.resolution ?? 72
        })})`,
        context
      );
      if (spec.layers) {
        doc.layers = spec.layers.map((l, i) => {
          // kindName 是给人读的（'TEXT' / 'GROUP' / 'NORMAL'）。数值枚举只在 vm 里有，
          // 所以解析必须发生在 vm 内，而不是在宿主侧硬编码 2/8。
          const { kindName, ...rest } = l;
          const payload = JSON.stringify({ id: l.id ?? i + 1, ...rest });
          return vm.runInContext(
            `(function (spec, kindName) {
               if (kindName) spec.kind = LayerKind[kindName];
               if (spec.children && spec.children.length) {
                 spec.children = spec.children.map(function (c) {
                   if (c.kindName) c.kind = LayerKind[c.kindName];
                   return __PSMOCK.makeLayer(c);
                 });
               }
               return __PSMOCK.makeLayer(spec);
             })(${payload}, ${JSON.stringify(kindName || null)})`,
            context
          );
        });
        doc.layers.forEach((l) => { l.parent = doc; });
        doc.activeLayer = doc.layers[0];
      }
      context.__PSMOCK.app.documents.push(doc);
      context.__PSMOCK.app.activeDocument = doc;
      return doc;
    },
    /** 执行一段 .jsx 源码，返回其返回值 */
    evalJsx(source, filename = 'inline.jsx') {
      const code = stripExtendScriptDirectives(source);
      return vm.runInContext(code, context, { filename });
    },
    /** 执行一个 .jsx 文件 */
    runJsxFile(file, request) {
      const source = fs.readFileSync(normalize(file), 'utf8');
      return host.runJsxSource(source, request, path.basename(file));
    },
    /**
     * 模拟 dsh-photoshop-anime 的调用协议：
     * 写 request.json → 设 DSH_REQUEST_FILE → 执行 engine.jsx → 解析返回的 JSON 字符串。
     */
    runJsxSource(source, request, filename = 'engine.jsx') {
      if (request !== undefined) {
        const reqPath = context.DSH_REQUEST_FILE;
        fs.mkdirSync(path.dirname(reqPath), { recursive: true });
        const payload = { cancel_file: path.join(path.dirname(reqPath), '__cancel.flag'), deadline: Date.now() + 60000, ...request };
        fs.writeFileSync(reqPath, JSON.stringify(payload), 'utf8');
      }
      const raw = host.evalJsx(source, filename);
      if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) return JSON.parse(trimmed);
        return trimmed;
      }
      return raw;
    },
    /** 记录到的副作用列表（断言用） */
    calls() {
      return host.mock.summary();
    },
    callsOf(name) {
      return host.mock.ps.log.filter((e) => e.name === name);
    },
    history() {
      return host.mock.ps.history.slice();
    }
  };

  return host;
}

function normalize(p) {
  const s = String(p).replace(/^file:\/\//, '');
  return path.isAbsolute(s) ? path.normalize(s) : path.resolve(s);
}
