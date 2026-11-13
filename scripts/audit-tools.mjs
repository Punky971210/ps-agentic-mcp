#!/usr/bin/env node
/**
 * 目录自检 —— 用每条工具的 demo 在 mock 后端跑一遍。
 *
 * 目的：91 条工具里任何一条参数名写错、实现缺失、调用约定不匹配，都会在这里
 * 暴露，而不是等装完 PS 才发现。needs='ps' 的（依赖真实文件 IO）跳过并单列。
 *
 * 用法：node scripts/audit-tools.mjs [--verbose]
 */
import { createRunner, TOOLS, groupOf } from '../src/core/runner.mjs';

const verbose = process.argv.includes('--verbose');

const runner = createRunner({ backend: 'mock' });
const rows = [];

for (const tool of TOOLS) {
  const args = { ...(tool.demo || {}) };
  const r = await runner.call(tool.name, args);
  const ok = r.ok !== false;
  rows.push({
    name: tool.name,
    group: groupOf(tool.name),
    kind: tool.kind,
    needs: tool.needs || 'mock',
    ok,
    skipped: !ok && tool.needs === 'ps',
    error: ok ? null : (r.error || 'unknown'),
    message: ok ? null : String(r.message || '').slice(0, 120)
  });
}

runner.close();

const failed = rows.filter((r) => !r.ok && !r.skipped);
const skipped = rows.filter((r) => r.skipped);
const passed = rows.filter((r) => r.ok);

const pad = (s, n) => String(s).padEnd(n);
console.log('='.repeat(78));
console.log(`工具自检：${rows.length} 条  通过 ${passed.length}  跳过(需真机) ${skipped.length}  失败 ${failed.length}`);
console.log('='.repeat(78));

if (failed.length) {
  console.log('\n[失败] 这些在离线层就跑不通，装 PS 后也不可能对：');
  for (const r of failed) {
    console.log(`  ${pad(r.name, 24)} ${pad(r.group, 10)} ${r.error}  ${r.message || ''}`);
  }
}

if (verbose && skipped.length) {
  console.log('\n[跳过] 语义依赖真实 PS（文件读写 / 系统 ML），离线不判：');
  for (const r of skipped) console.log(`  ${pad(r.name, 24)} ${r.error}  ${r.message || ''}`);
}

const byGroup = new Map();
for (const r of rows) {
  const g = byGroup.get(r.group) || { ok: 0, fail: 0, skip: 0 };
  if (r.ok) g.ok++;
  else if (r.skipped) g.skip++;
  else g.fail++;
  byGroup.set(r.group, g);
}
console.log('\n[分组]');
for (const [g, v] of byGroup) {
  const flag = v.fail ? '  <-- 有失败' : '';
  console.log(`  ${pad(g, 12)} ok=${pad(v.ok, 3)} skip=${pad(v.skip, 3)} fail=${pad(v.fail, 3)}${flag}`);
}

process.exit(failed.length ? 1 : 0);
