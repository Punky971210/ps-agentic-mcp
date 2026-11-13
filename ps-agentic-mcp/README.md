# ps-agent

本地 Photoshop 自动化，给 Agent 用。**不上云、不依赖 UXP 面板、不装 PS 也能开发和回归。**

```
MCP (4 个元工具)  ─┐
                   ├─→ runner ─┬─ backend=com  → PowerShell + COM → 桌面版 PS 26+
CLI (psx)         ─┘           └─ backend=mock → Node vm 里跑同一份 .jsx（离线）
```

两个入口、两个后端，吃的是**同一份** `catalog.mjs` 与**同一套** `.jsx`。
所以离线写好的调用在装机后不需要改，CLI 能跑通的 MCP 也一定能跑通。

## 工具面：91 条能力，4 个元工具

MCP 不把 91 条全量注册（那要 9–12k tokens 常驻），而是三段式：

| 元工具 | 作用 |
|---|---|
| `ps_search` | 检索。无参给 20 个能力域概览；带中文意图（"合并图层"）给候选 |
| `ps_describe` | 单条工具的 JSON Schema + **可直接照抄的 demo** |
| `ps_run` | 执行一条 |
| `ps_plan` | 一次提交多步，串跑并逐步回报，能定位哪步崩 |

常驻成本约 **1.5k tokens**（4 个 schema 合计 <6KB），全量注册会到 40KB+。

能力域：`doc` `layer` `sel` `mask` `adj`(15) `fx`(8) `text` `shape` `fill` `filter`
`xf` `save` `image` `lineart` `paint` `local_edit` `batch` `comfy` `history` `status`

## 快速上手

```bash
NODE=node   # 任意 PATH 中的 Node 20+，也可写你的 node 绝对路径

$NODE src/cli/psx.mjs groups                    # 20 个能力域概览
$NODE src/cli/psx.mjs search 合并图层            # 检索 → layer.merge_down
$NODE src/cli/psx.mjs describe layer.group      # schema + demo
$NODE src/cli/psx.mjs run status                # 默认走真实 PS
$NODE src/cli/psx.mjs run status --backend mock # 离线验调用链

$NODE src/cli/psx.mjs run shape.rect --arg l=40 --arg t=40 --arg r=240 --arg b=160 --arg 'color=[255,120,60]'
$NODE src/cli/psx.mjs batch --file examples/ops.json
```

## 目录

```
src/engine/          在 PS 里执行的代码（必须 ES3）
  ps_core.jsx        101 个 PS.* 函数（76 分组 + 25 文档级/内部）：选区19 调整层15 样式10 文字6 形状6 蒙版5 …
  anime_engine.jsx   663 行：分层线稿、曲线追踪、真实画笔落笔、上色批次
  ext.jsx            本项目增量：图层树/合并/编组/删除/排序/导出/置入 + 官方语义等价物
  serialize.jsx      ES3 安全序列化（PS DOM 有循环引用，JSON 化必炸）
  adb_uxp_src/       adb-mcp 的 UXP 命令层，仅作移植参考
src/core/runner.mjs  执行层：后端选择、检索、schema 生成、plan 编排
src/mcp/server.mjs   MCP server（零依赖手写 JSON-RPC over stdio）
src/cli/             psx 命令行 + 工具目录（唯一真相）
src/mock/            离线模拟层：vm + Photoshop DOM 假实现
src/host/            ps-worker.ps1（纯 ASCII，COM 驱动）
skill/               SKILL.md + 5 篇 references（懒加载）
tests/               44 个测试
vendor/              上游同步纪律
```

## 设计上说不的三件事

- **不做 UXP 面板。** UXP 的跨平台优势在这里没价值，却要多四个常驻依赖和一个常见故障
  （PS 重启后忘点 Connect）。COM + ExtendScript 零部署。
- **不接 Firefly。** `generate_image` / `generative_fill` / `harmonize_layer` 三条已剔除，
  生图交给本机 ComfyUI，PS 侧只做文件级衔接。
- **不把 mock 当默认。** 默认连真实 PS，连不上就明确报错。宁可让调用方知道没装上，
  也不让模拟结果被当成真的改了图。

## 踩过的坑（改代码前先看）

1. **`File(path)` 与 `UnitValue(12,'px')` 可以不带 `new`** —— ExtendScript 两者都支持直接调用。
   mock 里漏了这层兼容会静默返回 `undefined`，表现为「赋值成功但读出来是空的」。
2. **vm realm 的 Array 与主 realm 原型不同** —— `deepEqual` 判不等，跨 realm 断言先
   `JSON.parse(JSON.stringify(x))`。
3. **PS DOM 不能 `JSON.stringify`** —— `activeLayer.parent.layers[0]` 是闭环。要 `__PSX.safe()`；
   自家普通对象若带 `typename` 字段会被误判成 DOM，用 `__plain: 1` 豁免。
4. **PowerShell 5.1 按系统 ANSI(GBK) 解码 `.ps1`** —— 脚本里有中文直接解析失败。
   `ps-worker.ps1` 因此保持纯 ASCII。
5. **`DoJavaScript(code, null, 3)`** 的 `3` = DoNotDisplayDialogs，不给会被原生弹窗卡死。
6. **`#target photoshop` 不是合法 JS** —— 加载前必须剥行。
7. **`demo` 不能当运行时默认值** —— 否则「缺必填参数」会被悄悄补成示例值，
   调用方以为按自己的意图改了图。真实默认值放 `defaults`，二者严格分开。
8. **`ps_core` 的 `parseInt(x)` 有 20 处没给基数** —— ExtendScript 是 ES3 语义，前导 0 按八进制。
9. **engine 的 `create` 会对 `background` 调 `rgb().replace`** —— 不传就崩，靠 `defaults` 兜住。

## 明确没做

- `placeImage` / `exportLayers` / `updateText` / 线稿三条只有 mock 验证，未过真机
- 官方 `image_apply_preset` / `image_list_presets`（PS 预设体系需另建 .xmp 清单）
- 曲线/色阶的交互式编辑、液化、Camera Raw（这些走 PS 原生 UI 更合适）

