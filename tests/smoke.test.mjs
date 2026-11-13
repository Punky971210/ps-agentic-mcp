/**
 * 冒烟测试：证明「没装 Photoshop」也能对引擎做真实回归。
 * 跑：node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJsxHost, stripExtendScriptDirectives } from '../src/mock/jsx-host.mjs';
import { charIDToTypeID, describeTypeID } from '../src/mock/typeid.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = path.join(root, 'src/engine/anime_engine.jsx');
const CORE = path.join(root, 'src/engine/ps_core.jsx');

test('charIDToTypeID 与 Adobe 的字节打包一致', () => {
  assert.equal(charIDToTypeID('HstS'), 0x48737453);
  assert.equal(charIDToTypeID('slct'), 0x736c6374);
  assert.equal(charIDToTypeID('null'), 0x6e756c6c);
  assert.equal(charIDToTypeID('T   '), 0x54202020);
  assert.equal(describeTypeID(charIDToTypeID('HstS')), "'HstS'");
});

test('剥离 ExtendScript 预处理指令后仍是合法 JS', () => {
  const src = '#target photoshop\n#include "lib.jsx"\nvar a = 1;';
  const out = stripExtendScriptDirectives(src);
  assert.ok(!out.includes('#target'));
  assert.ok(!out.includes('#include'));
  assert.ok(out.includes('var a = 1;'));
});

test('engine.jsx 在 mock 里跑通 status', async () => {
  const host = await createJsxHost({ workDir: path.join(root, 'tests/.work') });
  host.bootstrapDocument({ id: 7, name: 'demo.psd', width: 800, height: 600 });
  const out = host.runJsxFile(ENGINE, { operation: 'status', args: {} });

  assert.equal(out.ok, true, `引擎报错：${out.error}`);
  assert.equal(out.value.active_document_id, 7);
  assert.equal(out.value.documents.length, 1);
  assert.equal(out.value.documents[0].width, 800);
  assert.equal(out.value.documents[0].height, 600);
  assert.equal(out.value.documents[0].selection.active, false);
});

test('engine.jsx 的 info 返回真实图层树', async () => {
  const host = await createJsxHost({ workDir: path.join(root, 'tests/.work') });
  host.bootstrapDocument({
    id: 3,
    name: 'tree.psd',
    layers: [
      { id: 10, name: 'lineart' },
      { id: 11, name: 'color', opacity: 80, visible: false }
    ]
  });
  const out = host.runJsxFile(ENGINE, { operation: 'info', args: { document_id: 3 } });

  assert.equal(out.ok, true, `引擎报错：${out.error}`);
  assert.equal(out.value.layers.length, 2);
  assert.equal(out.value.layers[0].name, 'lineart');
  assert.equal(out.value.layers[1].opacity, 80);
  assert.equal(out.value.layers[1].visible, false);
});

test('engine.jsx 未知操作给出明确错误而不是崩溃', async () => {
  const host = await createJsxHost({ workDir: path.join(root, 'tests/.work') });
  host.bootstrapDocument({ id: 1 });
  const out = host.runJsxFile(ENGINE, { operation: 'not_a_real_op', args: { document_id: 1 } });
  assert.equal(out.ok, false);
  assert.match(out.error, /Unknown operation/);
});

test('engine.jsx 在无文档时 status 不抛异常', async () => {
  const host = await createJsxHost({ workDir: path.join(root, 'tests/.work') });
  host.loadMock();
  const out = host.runJsxFile(ENGINE, { operation: 'status', args: {} });
  assert.equal(out.ok, true, `引擎报错：${out.error}`);
  assert.equal(out.value.active_document_id, null);
  assert.equal(out.value.documents.length, 0);
});

test('ps_core.jsx 能载入且不污染全局', async () => {
  const host = await createJsxHost({ workDir: path.join(root, 'tests/.work') });
  host.loadMock();
  host.bootstrapDocument({ id: 1, name: 'core.psd' });
  // ps_core 用 #target photoshop 开头，必须能剥离
  const src = fs.readFileSync(CORE, 'utf8');
  const value = host.evalJsx(`${src}\n;(typeof PS === 'object' && typeof PS.openDocument === 'function') ? 'PS_OK' : 'PS_BAD'`);
  assert.equal(value, 'PS_OK');
});
