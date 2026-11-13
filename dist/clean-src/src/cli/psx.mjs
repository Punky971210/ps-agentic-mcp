#!/usr/bin/env node
/**
 * psx —— Photoshop 自动化的命令行入口。
 *
 * 这一层只做三件事：解析参数、调 runner、打印 JSON。所有能力都在 core/runner.mjs，
 * MCP server 用的是同一份，所以 CLI 能跑通的调用 MCP 也一定能跑通。
 *
 * 用法：
 *   psx groups                        看有哪些能力域
 *   psx tools [group]                 列工具
 *   psx describe layer.group          看单条工具的 schema 与示例
 *   psx run sel.rect --arg l=10 ...
 *   psx run status
 *   psx batch --file ops.json         串跑多步并逐步回报
 *   psx search 合并 图层               三阶段检索的第一阶段（等价 ps_search）
 *
 * 后端：
 *   --backend com    默认，驱动桌面版 Photoshop（需要 PS 26+）
 *   --backend mock   在 Node 里跑同一份 .jsx，只换宿主对象（离线开发/回归用）
 *   也可用 PSX_BACKEND 环境变量
 */
import fs from 'node:fs';
import {
  createRunner, searchTools, describeTool, overview,
  listTools, groups, groupOf
} from '../core/runner.mjs';

// ---------- 参数解析 ----------
function parseArgv(argv) {
  const out = { _: [], args: {}, flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--arg') {
      const raw = String(argv[++i] || '');
      const eq = raw.indexOf('=');
      if (eq < 0) continue;
      out.args[raw.slice(0, eq)] = coerce(raw.slice(eq + 1));
    } else if (a.startsWith('--')) {
      const body = a.slice(2);
      const eq = body.indexOf('=');
      const key = eq < 0 ? body : body.slice(0, eq);
      const inline = eq < 0 ? undefined : body.slice(eq + 1);
      out.flags[key] = inline !== undefined ? coerce(inline) : (argv[i + 1] && !String(argv[i + 1]).startsWith('--') ? coerce(argv[++i]) : true);
    } else {
      out._.push(a);
    }
  }
  return out;
}

function coerce(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null') return null;
  const s = String(v);
  if (s !== '' && /^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s.startsWith('[') || s.startsWith('{')) {
    try { return JSON.parse(s); } catch { return v; }
  }
  return v;
}

function print(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function help() {
  return `psx —— 本地 Photoshop 自动化（${listTools().length} 条工具）

用法
  psx groups                        能力域概览
  psx tools [group]                 列工具
  psx describe <name>               schema + 可执行示例
  psx search <关键字>               检索（ps_search 的等价物）
  psx run <name> [--arg k=v]        执行
  psx batch --file ops.json         串跑多步

后端
  --backend com    默认，驱动桌面版 Photoshop
  --backend mock   离线模拟层（不需要装 PS）

示例
  psx run status
  psx run doc.create --arg width=1200 --arg height=900
  psx run shape.rect --arg l=40 --arg t=40 --arg r=240 --arg b=160 --arg 'color=[255,120,60]'
  psx run layer.list --arg maxDepth=4
  psx run comfy.status
`;
}

async function main() {
  const argv = parseArgv(process.argv.slice(2));
  const cmd = argv._[0];

  if (!cmd || cmd === 'help' || argv.flags.help) {
    process.stdout.write(help());
    return 0;
  }

  if (cmd === 'groups') { print(overview()); return 0; }

  if (cmd === 'tools') {
    const only = argv._[1];
    if (only) {
      const g = groups().get(only);
      if (!g) {
        print({ ok: false, error: `未知分组 ${only}`, groups: [...groups().keys()] });
        return 2;
      }
      print(g.map((t) => ({ name: t.name, summary: t.summary, required: t.required || [], demo: t.demo })));
      return 0;
    }
    print(listTools());
    return 0;
  }

  if (cmd === 'describe') {
    const out = describeTool(argv._[1]);
    print(out);
    return out.ok === false ? 2 : 0;
  }

  if (cmd === 'search') {
    const q = argv._.slice(1).join(' ');
    print({
      query: q,
      hits: searchTools(q, {
        group: argv.flags.group,
        limit: Number(argv.flags.limit) || 12,
        offlineOnly: !!argv.flags.offline
      })
    });
    return 0;
  }

  const backend = argv.flags.backend || process.env.PSX_BACKEND || 'com';
  const runner = await createRunner({ backend });

  try {
    if (cmd === 'batch') {
      const file = argv.flags.file;
      if (!file) { print({ ok: false, error: 'batch 需要 --file <ops.json>' }); return 2; }
      const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
      const out = await runner.plan(spec.ops || spec, {
        stopOnError: spec.stop_on_error !== false
      });
      print({ backend: runner.backendName, ...out });
      return out.ok ? 0 : 1;
    }

    const name = cmd === 'run' ? argv._[1] : cmd;
    if (!name) { print({ ok: false, error: '缺少工具名' }); return 2; }

    const args = { ...argv.args };
    if (argv.flags.doc !== undefined) args.document_id = coerce(argv.flags.doc);

    const result = await runner.call(name, args);
    print({ backend: runner.backendName, ...result });
    return result.ok === false ? 1 : 0;
  } finally {
    runner.close();
  }
}

main().then((code) => process.exit(code)).catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, error: 'unhandled', message: String(e && e.stack || e) }, null, 2) + '\n');
  process.exit(1);
});
