/**
 * ExtendScript 兼容性检查（ES3 + Adobe 扩展）。
 *
 * 为什么必须有：adb-mcp 的命令层是 ES6+（async/await、箭头、const、模板串、
 * 解构、展开）。直接搬进 .jsx 在 Photoshop 里是 SyntaxError，而且报错只给
 * 一行行号，定位成本高。这个 lint 在 Node 侧提前拦掉。
 *
 * 检测分三档：
 *   error —— 语法级，ExtendScript 直接解析失败
 *   warn  —— 运行时缺失（ES3 没有这些内置方法）
 *   info  —— 语义陷阱（typeof 行为、数组方法链）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SYNTAX = [
  [/\bfunction\s*\*/, 'generator 函数'],
  [/\basync\s+function\b/, 'async 函数'],
  [/\bawait\s+/, 'await'],
  [/=>/, '箭头函数'],
  [/\b(const|let)\s+[A-Za-z_$]/, 'const/let 声明'],
  [/\bclass\s+[A-Za-z_$]/, 'class 声明'],
  [/`/, '模板字符串'],
  [/\.\.\./, '展开/剩余运算符'],
  [/\bfor\s*\([^)]*\bof\b/, 'for...of'],
  [/\b(import|export)\s/, 'ESM 模块语法'],
  [/\?\./, '可选链'],
  [/\?\?/, '空值合并']
];

const RUNTIME = [
  [/\bObject\.assign\b/, 'Object.assign（ES3 无）'],
  [/\bObject\.keys\b/, 'Object.keys（ES3 无）'],
  [/\bObject\.defineProperty\b/, 'Object.defineProperty（不要依赖）'],
  [/\bArray\.isArray\b/, 'Array.isArray（ES3 无）'],
  [/\bArray\.from\b/, 'Array.from（ES3 无）'],
  [/\bJSON\./, 'JSON 对象（ExtendScript 无内建 JSON，用引擎自带的 parse/stringify）'],
  [/\bPromise\b/, 'Promise（ExtendScript 无）'],
  [/\b(Map|Set|WeakMap|WeakSet)\s*[({]/, 'ES6 集合类型'],
  [/\bNumber\.(isNaN|isInteger|isFinite)\b/, 'Number.*（ES3 无）'],
  [/\.(includes|startsWith|endsWith|padStart|padEnd|repeat|trimStart|trimEnd)\s*\(/, 'ES6+ 字符串方法'],
  [/\.(find|findIndex|map|filter|forEach|reduce|some|every|flat|flatMap)\s*\(/, 'ES5+ 数组迭代方法（ES3 无）'],
  [/\bSymbol\b/, 'Symbol'],
  [/\bProxy\b/, 'Proxy']
];

const INFO = [
  [/\btypeof\s+\w+\s*===?\s*['"]undefined['"]/, 'typeof 比较（ExtendScript 中 ok，注意 undeclared 与 undefined 差异）'],
  [/\.bind\s*\(/, 'Function.prototype.bind（ES3 无）'],
  [/\bparseInt\([^,)]*\)/, 'parseInt 未指定基数（ExtendScript 可能按 8 进制）']
];

function lintFile(file) {
  const src = fs.readFileSync(file, 'utf8');
  // 先抹掉块注释（保留换行以维持行号）—— 注释里的反引号、=> 之类是误报主源
  const cleaned = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const lines = cleaned.split(/\r?\n/);
  const findings = [];
  // 跳过 #target / #include 预处理行，它们由宿主剥离
  lines.forEach((line, i) => {
    if (/^\s*#(target|include|includepath|script|strict)\b/.test(line)) return;
    // 去掉行内字符串与注释，降低误报（粗略但有效）
    const code = line
      .replace(/\/\/.*$/, '')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""');
    for (const [re, label] of SYNTAX) if (re.test(code)) findings.push({ level: 'error', line: i + 1, label, text: line.trim() });
    for (const [re, label] of RUNTIME) if (re.test(code)) findings.push({ level: 'warn', line: i + 1, label, text: line.trim() });
    for (const [re, label] of INFO) if (re.test(code)) findings.push({ level: 'info', line: i + 1, label, text: line.trim() });
  });
  return findings;
}

const targets = process.argv.slice(2);
const files = targets.length
  ? targets
  : fs.readdirSync(path.join(root, 'src/engine'))
      .filter((f) => f.endsWith('.jsx'))
      .map((f) => path.join(root, 'src/engine', f));

let errors = 0, warns = 0, infos = 0;
for (const file of files) {
  const findings = lintFile(file);
  const rel = path.relative(root, file).replace(/\\/g, '/');
  if (!findings.length) { console.log(`✓ ${rel}  ES3 兼容`); continue; }
  console.log(`\n${rel}`);
  for (const f of findings) {
    const tag = f.level === 'error' ? '✗' : f.level === 'warn' ? '!' : 'i';
    console.log(`  ${tag} ${String(f.line).padStart(4)}  ${f.label}  |  ${f.text.slice(0, 90)}`);
    if (f.level === 'error') errors++;
    else if (f.level === 'warn') warns++;
    else infos++;
  }
}

console.log(`\n合计：error ${errors} / warn ${warns} / info ${infos}`);
process.exit(errors > 0 ? 1 : 0);
