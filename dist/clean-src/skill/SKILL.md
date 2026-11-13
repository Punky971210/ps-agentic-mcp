---
name: photoshop-local
description: |
  用 ps-agent 驱动本机桌面版 Photoshop：图层结构、选区蒙版、文字形状、调整层、
  图层样式、滤镜、变换、导出，以及 anime 引擎的分层线稿与真实画笔落笔。
  通过 MCP 的 ps_search / ps_describe / ps_run / ps_plan 四个元工具调用，全本地不上云。
  当用户说「PS 里」「Photoshop」「图层」「改图」「线稿」「上色」「导出图层」「套版」时使用。
  不负责：生成式填充、文生图（本机 ComfyUI 接管）。
---

# 本地 Photoshop 操作

91 条能力藏在 4 个元工具后面。**不要凭记忆猜工具名** —— 先检索，再执行。

## 三步流程

1. `ps_search` —— 找能力。不带 query 返回 20 个能力域概览；带中文意图（"合并图层"、"导出 png"）返回候选。
2. `ps_describe` —— 看参数。`demo` 字段可以直接照抄，坐标/颜色/路径格式都在里面。
3. `ps_run` —— 执行。多步任务用 `ps_plan` 一次提交，逐步回报，能定位哪步崩了。

```
ps_search({query: "合并图层"})           -> layer.merge_down
ps_describe({name: "layer.merge_down"})  -> args 与 demo
ps_run({name: "layer.merge_down", args: {layer_id: 12}})
```

## 开工前必须做的一件事

调 `status` 看当前有没有打开的文档、id 是多少、选区是否激活。

- 没有文档 → `doc.create` 或 `doc.open`
- 有文档 → 用 `layer.list` 拿图层 id 与结构，别假设 id=1 是你要的层

## 硬规则

- **破坏性操作先存盘**：`layer.flatten`、`layer.merge_down` 会改结构，前面先 `save.psd`。
- **默认后端是真实 PS**（com）。报 `photoshop_not_available` 说明本机没装 PS 或 COM 没注册，**不要**改用 mock 假装成功。
- **mock 只用于验证调用链**（`backend: "mock"`），它的结果不是真的改了图。
- **document_id 可不传**：单文档时执行层会自动补。多文档必须传。
- **颜色**用 `'#rrggbb'` 或 `[r, g, b]`，按 `ps_describe` 的 demo 来；**路径**用正斜杠 `D:/out/a.psd`。

## 使用铁律（逐条都有代价）

1. **只用 `doc.save` 存工作稿，不要用 `save.*` 四件套** —— 后者在目标路径不可用时弹「存储副本」并冻结整个 PS 实例（解卡要几十秒，还会连带后面全部失败）。
2. **路径全 ASCII**，且保存前确认目录存在 —— 中文路径会被解码成不存在的目录（已修输入编码，但仍建议 ASCII 落地）。
3. **判文字层只看 `kind.typename === 'LayerKind.TEXT'`** —— `isText` 恒为 false（已知限制）。
4. **`fx.*` 前先把目标层设为活动层**，并显式传 `layer_id` —— 否则会改错层（已修：现在按 `layer_id` 定位，传错会报错而不是静默改活动层）。
5. **矩形类调用必须满足 `r > l && b > t`** —— 反序会触发 PS 原生弹窗冻结实例；零面积会「假成功」（已加运行期校验，直接返回 `bad_geometry`）。
6. **选区修饰类（`sel.grow/expand/contract/smooth/border/intersect_rect`、`mask.add`）必须先建选区** —— 无选区时 PS 弹告警框并冻结（已加预检，返回 `no_selection`）。
7. **批跑/压测前挂 `dialog.handle`**：任一步失败先 `dialog.handle --arg policy=auto` 再重试一次，别让一次弹窗把后续全部污染成假阴性。
8. **`.ps1` 文件必须纯 ASCII（含注释）** —— PowerShell 5.1 按 GBK 解码，一行中文注释就足以让解析错乱（本项目亲历：`$T_CANCEL` 变成空串导致点错按钮）。
9. **`layer.place` 走剪贴板通道**：功能等价于置入图层，但超大素材（数百 MB）会占用剪贴板内存；失败时用 `doc.close` 清理可能残留的临时文档。

## 常用配方

**建画布 → 画形状 → 加文字 → 存盘**
```
ps_plan({ steps: [
  { name: "doc.create", args: { width: 1200, height: 900, name: "poster", background: "ffffff" } },
  { name: "shape.rect", args: { l: 60, t: 60, r: 1140, b: 300, color: [30, 60, 120] } },
  { name: "text.add",  args: { contents: "SALE", size: 96, color: "#ffffff", position: [100, 180] } },
  { name: "save.psd",  args: { path: "D:/out/poster.psd" } }
]})
```

**统一尺寸 + 自动色调 + 导出**
```
ps_plan({ steps: [
  { name: "image.crop_and_resize", args: { width: 1080, height: 1080 } },
  { name: "image.auto_tone" },
  { name: "save.jpg", args: { path: "D:/out/cover.jpg", quality: 10 } }
]})
```

**选区 → 蒙版 → 换背景**
```
ps_plan({ steps: [
  { name: "sel.subject" },
  { name: "mask.from_selection", args: { layer_id: 3 } },
  { name: "layer.place", args: { path: "D:/in/bg.jpg" } }
]})
```

**批量导出每个图层为 PNG**：`layer.export_png {dir: "D:/out/layers"}`，会自动恢复可见性。

**线稿 / 上色**（anime 引擎，产出分层 PSD + 真实画笔笔画）
`lineart.run` 需要 `reference_path`；`paint.run` 需要 `palette`；`paint.review` 出预览。这三条落的是可撤销的历史步骤，不是一次性像素。

**接 ComfyUI**
`comfy.status` 看端口与目录 → `comfy.export` 存参考图进 input → 在 ComfyUI 跑图 → `comfy.place_latest` 把最新出图置入 PS。不做 API 提交，只走文件。

## 错误对照

| error | 含义 | 怎么办 |
|---|---|---|
| `photoshop_not_available` | 本机无 PS 的 COM 注册 | 装桌面版 PS 26+，或用 `backend: "mock"` 验链路 |
| `missing_args` | 缺必填参数 | 返回里带 `required` 与 `demo`，照 demo 补 |
| `unknown_tool` | 名字不对 | 用返回的 `suggestions`，或重新 `ps_search` |
| `empty_result` | PS 执行了但没返回 | 多半被原生对话框阻塞，看 PS 窗口 |
| `目标图层不是文字层` | text.* 指错了层 | 先 `layer.list` 看 `isText` |
| `找不到 layer_id=N` | id 不存在（可能刚被删） | 重新 `layer.list` |

## 没有 MCP 时的退路

同一套能力有 CLI 入口，输出 JSON，适合手工调试或离线跑：

```bash
NODE="node"
$NODE src/cli/psx.mjs search 合并图层
$NODE src/cli/psx.mjs describe layer.group
$NODE src/cli/psx.mjs run layer.group --arg 'layer_ids=[1,2]'
$NODE src/cli/psx.mjs run status --backend mock   # 离线验链路
```

## 深入

- 图层结构、编组、合并、导出：[references/layer.md](references/layer.md)
- 选区与蒙版：[references/selection.md](references/selection.md)
- 文字、形状、调整层参数：[references/text-shape-adjust.md](references/text-shape-adjust.md)
- 线稿与上色引擎：[references/anime.md](references/anime.md)
- ComfyUI 衔接与排查：[references/comfy.md](references/comfy.md)
