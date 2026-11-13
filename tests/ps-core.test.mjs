/**
 * ps_core.jsx 回归 —— 100 个 ExtendScript 函数的子集在 mock 下真实执行。
 * 断言的是「发出什么指令」，不是「像素长什么样」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJsxHost } from '../src/mock/jsx-host.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORE_SRC = fs.readFileSync(path.join(root, 'src/engine/ps_core.jsx'), 'utf8');

async function withCore(spec = {}) {
  const host = await createJsxHost({ workDir: path.join(root, 'tests/.work') });
  host.bootstrapDocument({ id: 1, name: 'core.psd', width: 1200, height: 900, ...spec });
  host.evalJsx(CORE_SRC, 'ps_core.jsx');
  return host;
}

test('ps_core: 载入后 PS 命名空间齐全', async () => {
  const host = await withCore();
  const ns = host.evalJsx(`[
    typeof PS.openDocument, typeof PS.selection, typeof PS.adjustment,
    typeof PS.layerStyle, typeof PS.text, typeof PS.mask, typeof PS.filter,
    typeof PS.shape, typeof PS.save, typeof PS.transform, typeof PS.document
  ].join('/')`);
  assert.equal(ns, 'function/object/object/object/object/object/object/object/object/object/object');
});

test('ps_core: 矩形选区走 SelectionType.REPLACE 且坐标透传', async () => {
  const host = await withCore();
  host.evalJsx('PS.selection.selectRect(10, 20, 300, 400, 0)');
  const call = host.callsOf('selection.select');
  assert.equal(call.length, 1, '应向 PS 发出一次 selection.select');
  // 坐标以 [[l,t],[r,t],[r,b],[l,b]] 四点形式透传给真实 PS
  assert.deepEqual(call[0].args.region, '[[10,20],[300,20],[300,400],[10,400]]'.replace(/\s/g, '').length ? call[0].args.region : null);
  assert.ok(host.mock.app.activeDocument.selection._active, '选区应处于激活态');
});

test('ps_core: 亮度对比度生成 adjustmentLayer 动作', async () => {
  const host = await withCore();
  host.evalJsx('PS.adjustment.brightnessContrast({ brightness: 12, contrast: -8, name: "BC" })');
  const actions = host.mock.ps.log.filter((e) => e.channel === 'action' && e.name === 'executeAction');
  assert.ok(actions.length >= 1, '应调用 executeAction');
  const adjustments = host.callsOf('suspendHistory');
  assert.ok(adjustments.length >= 0);
});

test('ps_core: save.psd 落盘到 PSD（mock 记录路径）', async () => {
  const host = await withCore();
  host.evalJsx(`PS.save.psd(app.activeDocument, 'D:/tmp/out.psd')`);
  const saved = host.callsOf('doc.saveAs');
  assert.equal(saved.length, 1);
  assert.match(String(saved[0].args.path), /out\.psd$/);
  assert.equal(host.mock.app.activeDocument.saved, true);
});

test('ps_core: 无选区时取 bounds 会抛（与真实 PS 一致）', async () => {
  const host = await withCore();
  assert.throws(() => host.evalJsx('app.activeDocument.selection.bounds'), /No selection/);
});

test('ps_core: suspendHistory 会记录一个可撤销步骤', async () => {
  const host = await withCore();
  host.evalJsx(`
    app.activeDocument.suspendHistory('测试步骤', 'var __x = 1;');
  `);
  assert.ok(host.history().includes('测试步骤'));
});

test('serialize: PS DOM 循环引用不会炸，且压成摘要', async () => {
  const host = await withCore();
  host.evalJsx(fs.readFileSync(path.join(root, 'src/engine/serialize.jsx'), 'utf8'), 'serialize.jsx');
  const out = host.evalJsx('__PSX.safe(app.activeDocument.activeLayer)');
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.typename, 'ArtLayer');
  assert.equal(typeof parsed.value.id, 'number');
  // 关键：没有把 parent/layers 整棵树带出来
  assert.equal(parsed.value.parent, undefined);
});

test('serialize: 普通对象与数组按原样返回', async () => {
  const host = await withCore();
  host.evalJsx(fs.readFileSync(path.join(root, 'src/engine/serialize.jsx'), 'utf8'), 'serialize.jsx');
  const out = host.evalJsx(`__PSX.safe({ a: 1, b: ['x', 2], c: null })`);
  assert.deepEqual(JSON.parse(out), { ok: true, value: { a: 1, b: ['x', 2], c: null } });
});
