#!/usr/bin/env node
/**
 * ps-agent MCP server —— 三段式（search / describe / run）。
 *
 * 为什么不是 91 个工具直接注册：
 *   91 个完整 schema 常驻约 9–12k tokens，而一次任务实际只用到 3–8 个。
 *   三段式把这个成本压到约 300 tokens，代价是每次新任务多一轮检索。
 *
 * 协议：JSON-RPC 2.0 over stdio，一行一条消息（NDJSON）。
 * 依赖：零。不引 @modelcontextprotocol/sdk —— 装机环境装不了包也能跑，
 *      而且我们只需要 tools 一个能力，手写比引依赖更可控。
 *
 * 切记：stdout 只允许协议消息，任何日志走 stderr。
 */
import readline from 'node:readline';
import { createRunner, searchTools, describeTool, overview, listTools, BY_NAME } from '../core/runner.mjs';

const SERVER = { name: 'ps-agent', version: '0.2.1' };
// 2024-11-05 是目前兼容面最广的版本；客户端请求更新的版本时按它的回。
const PROTOCOL_FALLBACK = '2024-11-05';

const runners = new Map();

function getRunner(backend) {
  const key = backend === 'mock' ? 'mock' : 'com';
  if (!runners.has(key)) runners.set(key, createRunner({ backend: key }));
  return runners.get(key);
}

// ---------------------------------------------------------------- 工具定义

const META_TOOLS = [
  {
    name: 'ps_search',
    description:
      '第一步：按意图检索 Photoshop 能力。不带 query 返回能力域概览（20 个分组 + 每组条数）。' +
      '带 query 返回最相关的工具名与一句话说明。找到候选后再用 ps_describe 看参数。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '自然语言或工具名片段，例如「合并图层」「导出 png」「裁剪成 1080」' },
        group: { type: 'string', description: '限定能力域：layer / sel / mask / adj / fx / text / shape / filter / xf / save / image / lineart / paint / comfy / batch …' },
        limit: { type: 'number', description: '返回条数，默认 12' },
        offline_only: { type: 'boolean', description: '只列不依赖真机 Photoshop 的工具' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'ps_describe',
    description:
      '第二步：取单个工具的完整参数 schema 与可直接照抄的示例（demo）。调用前必看，' +
      '尤其 demo 里的坐标、颜色格式、路径写法。',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'ps_search 返回的工具名，例如 layer.group' } },
      required: ['name'],
      additionalProperties: false
    }
  },
  {
    name: 'ps_run',
    description:
      '第三步：执行一个工具。返回 JSON。ok=false 时看 error 字段：' +
      'photoshop_not_available=本机没装 PS；missing_args=缺必填参数；unknown_tool=名字不对。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '工具名' },
        args: { type: 'object', description: '工具参数，键名见 ps_describe 的 inputSchema' },
        document_id: { type: 'number', description: '可选。多文档时指定目标文档，省去每个工具都传' },
        backend: { type: 'string', enum: ['com', 'mock'], description: '默认 com（真实 PS）。mock 只用于离线验证调用链' }
      },
      required: ['name'],
      additionalProperties: false
    }
  },
  {
    name: 'ps_plan',
    description:
      '一次提交多步并串跑，保持文档状态。适合批量导出、批量套版、' +
      '「建画布→画形状→加文字→存盘」这类流水线。返回逐步结果，能定位是哪一步崩的。',
    inputSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          description: '步骤数组，元素为 { name, args? }，也接受纯字符串',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              args: { type: 'object' },
              document_id: { type: 'number' }
            },
            required: ['name']
          }
        },
        stop_on_error: { type: 'boolean', description: '默认 true。false 时出错继续跑下一步' },
        document_id: { type: 'number', description: '整批默认目标文档' },
        backend: { type: 'string', enum: ['com', 'mock'] }
      },
      required: ['steps'],
      additionalProperties: false
    }
  }
];

// ---------------------------------------------------------------- 工具实现

async function callMetaTool(name, args) {
  switch (name) {
    case 'ps_search': {
      if (!args.query && !args.group) return { ok: true, ...overview() };
      const hits = searchTools(args.query || '', {
        group: args.group,
        limit: Number(args.limit) || 12,
        offlineOnly: !!args.offline_only
      });
      return {
        ok: true,
        query: args.query || null,
        group: args.group || null,
        count: hits.length,
        hits,
        next: hits.length ? `用 ps_describe 看 ${hits[0].name} 的参数` : '换个说法，或先用 ps_search 无参看能力域概览'
      };
    }

    case 'ps_describe':
      return describeTool(args.name);

    case 'ps_run': {
      if (!BY_NAME.has(args.name)) {
        return {
          ok: false,
          error: 'unknown_tool',
          message: `没有 ${args.name}`,
          suggestions: searchTools(args.name, { limit: 5 }).map((x) => x.name)
        };
      }
      const runner = getRunner(args.backend);
      return runner.call(args.name, args.args || {}, { documentId: args.document_id });
    }

    case 'ps_plan': {
      const runner = getRunner(args.backend);
      return runner.plan(args.steps || [], {
        stopOnError: args.stop_on_error !== false,
        documentId: args.document_id
      });
    }

    default:
      throw new Error(`未实现的元工具：${name}`);
  }
}

// ---------------------------------------------------------------- JSON-RPC

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function ok(id, result) { send({ jsonrpc: '2.0', id, result }); }

function fail(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });
}

async function handle(msg) {
  const { id, method, params } = msg;

  // 通知没有 id，不回包
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize': {
      const requested = params && params.protocolVersion;
      ok(id, {
        protocolVersion: requested || PROTOCOL_FALLBACK,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER,
        instructions:
          'Photoshop 本地自动化。用法：ps_search 找能力 → ps_describe 看参数 → ps_run 执行。' +
          '多步任务用 ps_plan 一次提交。改图前先 status 看当前文档；会破坏结构的操作（flatten）先 save.psd。'
      });
      return;
    }

    case 'notifications/initialized':
    case 'initialized':
      return;

    case 'ping':
      if (!isNotification) ok(id, {});
      return;

    case 'tools/list':
      ok(id, { tools: META_TOOLS });
      return;

    case 'tools/call': {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      if (!META_TOOLS.some((t) => t.name === name)) {
        fail(id, -32602, `未知工具 ${name}`);
        return;
      }
      try {
        const result = await callMetaTool(name, args);
        const text = JSON.stringify(result, null, 2);
        ok(id, {
          content: [{ type: 'text', text }],
          isError: result && result.ok === false
        });
      } catch (e) {
        // 工具内部异常按 MCP 约定作为 isError 内容返回，而不是协议错误
        ok(id, {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'tool_exception', message: String(e && e.message || e) }, null, 2) }],
          isError: true
        });
      }
      return;
    }

    case 'resources/list':
      ok(id, { resources: [] });
      return;

    case 'prompts/list':
      ok(id, { prompts: [] });
      return;

    default:
      if (isNotification) return;
      fail(id, -32601, `不支持的方法：${method}`);
  }
}

function main() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      fail(null, -32700, 'JSON 解析失败');
      return;
    }
    // 并发处理，但每个响应各自独立（id 保证客户端能对上）
    handle(msg).catch((e) => {
      fail(msg.id ?? null, -32603, String(e && e.message || e));
    });
  });

  rl.on('close', () => {
    for (const r of runners.values()) r.close();
    process.exit(0);
  });

  process.stderr.write(`[ps-agent] MCP server ready. ${listTools().length} tools behind 4 meta-tools.\n`);
}

main();
