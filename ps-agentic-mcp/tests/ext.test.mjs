/**
 * ext.jsx 回归 —— 补齐 ps_core 缺的 adb 差集，以及官方 MCP 的语义等价物。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJsxHost } from '../src/mock/jsx-host.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
// vm realm 里创建的数组与主 realm 原型不同，deepEqual 会判不等；
// 一律走 JSON 往返再做结构断言。
const json = (v) => JSON.parse(JSON.stringify(v));
const PRELUDE = read('src/engine/ps_core.jsx') + '\n' + read('src/engine/serialize.jsx');

async function withExt(spec = {}) {
  const host = await createJsxHost({ workDir: path.join(root, 'tests/.work') });
  host.bootstrapDocument({ id: 1, name: 'ext.psd', width: 1200, height: 900, ...spec });
  host.evalJsx(PRELUDE, 'prelude.jsx');
  host.evalJsx(read('src/engine/ext.jsx'), 'ext.jsx');
  return host;
}

test('ext: listLayers 保留自定义字段（不被 DOM 白名单裁掉）', async () => {
  const host = await withExt({
    layers: [
      { id: 10, name: 'line' },
      { id: 11, name: 'group', kind: 8, children: [] }
    ]
  });
  const out = JSON.parse(host.evalJsx('__PSX.safe(PSX.listLayers(null, { maxDepth: 3 }))'));
  assert.equal(out.ok, true);
  assert.equal(out.value.count, 2);
  assert.equal(out.value.layers[0].path, 'line');
  assert.equal(out.value.layers[0].depth, 0);
  assert.equal(out.value.layers[1].typename, 'LayerSet');
  assert.equal(out.value.layers[0].__plain, undefined, '__plain 是内部标记，不应出现在输出里');
});

test('ext: autoTone 走 PS 原生 autoLevelsEvent', async () => {
  const host = await withExt();
  const applied = host.evalJsx("PSX.autoTone({}).applied");
  assert.equal(applied, 'autoLevelsEvent');
  const actions = host.mock.ps.log.filter((e) => e.channel === 'action' && e.name === 'executeAction');
  assert.ok(actions.length >= 1, '应通过 executeAction 触发');
});

test('ext: autoTone 可切换成 autoContrastEvent', async () => {
  const host = await withExt();
  assert.equal(host.evalJsx("PSX.autoTone({ mode: 'contrast' }).applied"), 'autoContrastEvent');
});

test('ext: cropAndResize 对超宽画布做居中裁剪', async () => {
  // 1200x900 (ratio 1.333) → 目标 1:1，应裁成 900x900，left=150
  const host = await withExt();
  const out = host.evalJsx('PSX.cropAndResize({ width: 1080, height: 1080 })');
  assert.deepEqual(json(out.cropped), [900, 900]);
  const crop = host.callsOf('doc.crop');
  assert.equal(crop.length, 1, '应发出一次裁剪');
  const resize = host.callsOf('doc.resizeImage');
  assert.equal(resize.length, 1, '应发出一次缩放');
});

test('ext: cropAndResize 同比例时不裁剪，只缩放', async () => {
  const host = await withExt({ width: 1000, height: 1000 });
  const out = host.evalJsx('PSX.cropAndResize({ width: 512, height: 512 })');
  assert.deepEqual(json(out.cropped), [1000, 1000]);
  assert.equal(host.callsOf('doc.crop').length, 0, '比例一致不该裁剪');
  assert.equal(host.callsOf('doc.resizeImage').length, 1);
});

test('ext: cropAndResize 缺参数时明确报错', async () => {
  const host = await withExt();
  assert.throws(() => host.evalJsx('PSX.cropAndResize({})'), /需要 width 与 height/);
});

test('ext: exportLayers 结束后恢复所有图层可见性', async () => {
  const host = await withExt({
    layers: [
      { id: 10, name: 'a', visible: true },
      { id: 11, name: 'b', visible: false }
    ]
  });
  const out = host.evalJsx("PSX.exportLayers('D:/out/layers')");
  assert.equal(out.exported, 2);
  const doc = host.mock.app.activeDocument;
  assert.equal(doc.layers[0].visible, true, '原可见图层应恢复可见');
  assert.equal(doc.layers[1].visible, false, '原隐藏图层应恢复隐藏');
});

test('ext: updateText 拒绝非文字图层', async () => {
  const host = await withExt({ layers: [{ id: 10, name: 'pixels', kind: 1 }] });
  assert.throws(() => host.evalJsx('PSX.updateText({ layer_id: 10, contents: "hi" })'), /不是文字层/);
});

test('ext: updateText 改文字层文案与字号', async () => {
  const host = await withExt({ layers: [{ id: 10, name: 'title', kind: 2, contents: 'old' }] });
  const out = host.evalJsx('PSX.updateText({ layer_id: 10, contents: "新标题", size: 48 })');
  assert.equal(out.contents, '新标题');
  const layer = host.mock.app.activeDocument.layers[0];
  assert.equal(layer.textItem.size.value, 48);
});

test('ext: applyAdjustments 按顺序叠多个调整层', async () => {
  const host = await withExt();
  host.evalJsx(`PSX.applyAdjustments([
    { kind: 'brightness', brightness: 5 },
    { kind: 'levels', shadow: 10, white: 245 },
    { kind: 'vibrance', vibrance: 20 }
  ])`);
  const actions = host.mock.ps.log.filter((e) => e.channel === 'action' && e.name === 'executeAction');
  assert.equal(actions.length, 3, '三个调整应各自触发一次 executeAction');
});

test('ext: applyAdjustments 遇到未知类型明确报错', async () => {
  const host = await withExt();
  assert.throws(() => host.evalJsx("PSX.applyAdjustments([{ kind: 'magic' }])"), /不支持的调整类型/);
});

test('ext: lensBlur 传半径与焦距', async () => {
  const host = await withExt();
  const out = host.evalJsx('PSX.lensBlur({ radius: 12, focal: 300 })');
  assert.equal(out.radius, 12);
  assert.ok(host.mock.ps.log.some((e) => e.channel === 'action' && e.name === 'executeAction'));
});
