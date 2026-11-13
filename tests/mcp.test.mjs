/**
 * MCP server 协议测试。
 *
 * 不引 MCP SDK —— 直接按协议发 NDJSON、读 NDJSON，验证的是「客户端看到的东西」，
 * 而不是我们的内部函数。这样 dsh 接上去出问题时，能立刻区分是协议层还是能力层。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(root, 'src/mcp/server.mjs');

class Client {
  constructor() {
    this.proc = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = '';
    this.stderr = '';

    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => {
      this.buffer += chunk;
      let idx;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        const waiter = this.pending.get(msg.id);
        if (waiter) {
          this.pending.delete(msg.id);
          waiter.resolve(msg);
        }
      }
    });
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (c) => { this.stderr += c; });
  }

  request(method, params) {
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method };
    if (params !== undefined) payload.params = params;
    this.proc.stdin.write(JSON.stringify(payload) + '\n');
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => reject(new Error(`超时：${method}\nstderr=${this.stderr}`)), 25000);
    });
  }

  notify(method, params) {
    const payload = { jsonrpc: '2.0', method };
    if (params !== undefined) payload.params = params;
    this.proc.stdin.write(JSON.stringify(payload) + '\n');
  }

  /** tools/call 的语法糖：取出 content[0].text 并解析成对象 */
  async call(name, args) {
    const res = await this.request('tools/call', { name, arguments: args });
    assert.ok(res.result, `tools/call 应返回 result，实际：${JSON.stringify(res.error)}`);
    const text = res.result.content[0].text;
    return JSON.parse(text);
  }

  kill() { this.proc.kill(); }
}

async function withClient(fn) {
  const c = new Client();
  try {
    const init = await c.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'ps-agent-test', version: '0' }
    });
    assert.equal(init.result.serverInfo.name, 'ps-agent');
    c.notify('notifications/initialized');
    return await fn(c);
  } finally {
    c.kill();
  }
}

test('initialize 返回协议版本与 tools 能力', async () => {
  await withClient(async (c) => {
    const res = await c.request('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
    assert.equal(res.jsonrpc, '2.0');
    assert.equal(res.result.protocolVersion, '2024-11-05');
    assert.ok(res.result.capabilities.tools, '必须声明 tools 能力');
    assert.match(res.result.instructions, /ps_search/);
  });
});

test('tools/list 只暴露 4 个元工具', async () => {
  await withClient(async (c) => {
    const res = await c.request('tools/list');
    const names = res.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['ps_describe', 'ps_plan', 'ps_run', 'ps_search']);
    for (const t of res.result.tools) {
      assert.equal(t.inputSchema.type, 'object', `${t.name} 的 inputSchema 必须是 object`);
      assert.ok(t.description.length > 20, `${t.name} 的说明要有信息量`);
    }
  });
});

test('工具面常驻成本远小于全量注册', async () => {
  await withClient(async (c) => {
    const res = await c.request('tools/list');
    const bytes = Buffer.byteLength(JSON.stringify(res.result.tools), 'utf8');
    // 4 个元工具的 schema 合计压到 6KB 内（约 1.5k tokens），全量 91 个会到 40KB+
    assert.ok(bytes < 6000, `元工具 schema 体积应 <6KB，实际 ${bytes}`);
  });
});

test('ps_search 无参返回能力域概览', async () => {
  await withClient(async (c) => {
    const out = await c.call('ps_search', {});
    assert.equal(out.ok, true);
    assert.ok(out.total >= 90, `应覆盖全部工具，实际 ${out.total}`);
    assert.ok(Array.isArray(out.groups) && out.groups.length >= 15);
    const layer = out.groups.find((g) => g.group === 'layer');
    assert.ok(layer, '应有 layer 分组');
    assert.ok(layer.label.length > 0, '分组要有人话说明');
  });
});

test('ps_search 能按中文意图命中工具', async () => {
  await withClient(async (c) => {
    const out = await c.call('ps_search', { query: '合并图层' });
    assert.equal(out.ok, true);
    const names = out.hits.map((h) => h.name);
    assert.ok(names.includes('layer.merge_down'), `应命中 merge_down，实际 ${names.join(',')}`);
    assert.ok(out.next.includes('ps_describe'));
  });
});

test('ps_search 支持分组与离线过滤', async () => {
  await withClient(async (c) => {
    const byGroup = await c.call('ps_search', { group: 'sel' });
    assert.ok(byGroup.hits.every((h) => h.group === 'sel'));

    const offline = await c.call('ps_search', { query: 'save', offline_only: true });
    assert.ok(offline.hits.every((h) => h.offline === true));
  });
});

test('ps_describe 给出 JSON Schema 与可执行示例', async () => {
  await withClient(async (c) => {
    const out = await c.call('ps_describe', { name: 'layer.group' });
    assert.equal(out.ok, true);
    assert.equal(out.inputSchema.type, 'object');
    assert.deepEqual(out.inputSchema.required, ['layer_ids']);
    assert.equal(out.inputSchema.properties.layer_ids.type, 'array');
    assert.equal(out.inputSchema.properties.layer_ids.items.type, 'number');
    assert.ok(Array.isArray(out.demo.layer_ids), 'demo 必须能直接抄');
  });
});

test('ps_describe 对错名字给相近建议', async () => {
  await withClient(async (c) => {
    const out = await c.call('ps_describe', { name: 'layer.merge' });
    assert.equal(out.ok, false);
    assert.equal(out.error, 'unknown_tool');
    assert.ok(out.suggestions.length > 0);
  });
});

test('ps_run 在 mock 后端执行真实 .jsx', async () => {
  await withClient(async (c) => {
    const out = await c.call('ps_run', { name: 'status', backend: 'mock' });
    assert.equal(out.ok, true);
    assert.equal(out.backend, 'mock');
    assert.equal(out.value.documents.length, 1);
    assert.equal(out.value.documents[0].name, 'mock.psd');
  });
});

test('缺必填参数时明确报错，且不拿 demo 兜底', async () => {
  await withClient(async (c) => {
    const out = await c.call('ps_run', { name: 'doc.create', args: { name: 'x' }, backend: 'mock' });
    assert.equal(out.ok, false, 'demo 里的 width/height 不能被当成调用方的输入');
    assert.equal(out.error, 'missing_args');
    assert.deepEqual(out.required, ['width', 'height']);
    assert.ok(out.demo.width > 0, '报错时要带上示例，方便调用方纠正');

    // 明确给了必填参数就应该能跑
    const good = await c.call('ps_run', { name: 'doc.create', args: { width: 800, height: 600, name: 'ok' }, backend: 'mock' });
    assert.equal(good.ok, true);
  });
});

test('ps_run 未知工具返回建议', async () => {
  await withClient(async (c) => {
    const out = await c.call('ps_run', { name: 'layer.fly', backend: 'mock' });
    assert.equal(out.ok, false);
    assert.equal(out.error, 'unknown_tool');
    assert.ok(out.suggestions.length > 0);
  });
});

test('ps_plan 串跑多步并逐步回报', async () => {
  await withClient(async (c) => {
    const out = await c.call('ps_plan', {
      backend: 'mock',
      steps: [
        { name: 'status' },
        { name: 'sel.rect', args: { l: 0, t: 0, r: 100, b: 100 } },
        { name: 'adj.brightness', args: { brightness: 10 } }
      ]
    });
    assert.equal(out.ok, true);
    assert.equal(out.completed, 3);
    assert.equal(out.failed, 0);
    assert.deepEqual(out.results.map((r) => r.name), ['status', 'sel.rect', 'adj.brightness']);
  });
});

test('ps_plan 出错即停并指出是哪一步', async () => {
  await withClient(async (c) => {
    const out = await c.call('ps_plan', {
      backend: 'mock',
      steps: [
        { name: 'status' },
        { name: 'doc.create', args: { name: 'no-size' } },
        { name: 'status' }
      ]
    });
    assert.equal(out.ok, false);
    assert.equal(out.completed, 2, '应在第 2 步停下');
    assert.equal(out.results[1].ok, false);
    assert.equal(out.results[1].result.error, 'missing_args');
  });
});

test('ps_plan 支持 stop_on_error=false 继续执行', async () => {
  await withClient(async (c) => {
    const out = await c.call('ps_plan', {
      backend: 'mock',
      stop_on_error: false,
      steps: [
        { name: 'doc.create', args: { name: 'bad' } },
        { name: 'status' }
      ]
    });
    assert.equal(out.completed, 2);
    assert.equal(out.failed, 1);
    assert.equal(out.results[1].ok, true);
  });
});

test('默认后端是 com，未装 PS 时返回 photoshop_not_available', async () => {
  await withClient(async (c) => {
    const out = await c.call('ps_run', { name: 'status' });
    if (out.ok === true) {
      // 装了 PS 的机器上这条会成功，属于正常
      assert.ok(out.backend === 'com');
      return;
    }
    assert.equal(out.backend, 'com');
    assert.equal(out.error, 'photoshop_not_available');
    assert.match(out.hint, /mock/);
  });
});

test('未知方法返回 -32601，不崩', async () => {
  await withClient(async (c) => {
    const res = await c.request('resources/subscribe', { uri: 'x' });
    assert.equal(res.error.code, -32601);
    // 之后仍能正常工作
    const ping = await c.request('ping');
    assert.deepEqual(ping.result, {});
  });
});

test('非法 JSON 不导致进程退出', async () => {
  await withClient(async (c) => {
    c.proc.stdin.write('{not json}\n');
    const ping = await c.request('ping');
    assert.deepEqual(ping.result, {});
  });
});
