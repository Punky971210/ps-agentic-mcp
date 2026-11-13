# 图层结构

## 先看清结构

`layer.list` 返回扁平化后的树，每条带 `depth` 与 `path`：

```json
{ "id": 3, "name": "Title", "typename": "ArtLayer", "depth": 0,
  "path": "Title", "visible": true, "opacity": 100, "blendMode": "NORMAL",
  "kind": 2, "isText": true, "text": "Mock Title",
  "bounds": [0, 0, 200, 60] }
```

- `isSmartObject` 为真时，`layer.place` 置入的图还能无损缩放。
- `bounds` 是 `[left, top, right, bottom]`（像素）。`bounds: false` 可以省掉它，大文档能显著减小返回体积。
- `maxDepth` 默认 8，嵌套很深的模板记得调大。

## 结构变更（都走 ActionManager，不依赖「先点选」）

| 工具 | 作用 | 注意 |
|---|---|---|
| `layer.merge_down` | 当前层与下一层合并 | 传 `layer_id` 会先选中它 |
| `layer.flatten` | 拼合全部 | **丢图层结构**，先 `save.psd` |
| `layer.duplicate` | 复制（可重命名） | 返回后需要自己 `layer.list` 拿新 id |
| `layer.delete` | 按 id 删除 | 不需要先选中 |
| `layer.group` | 多 id 编组 | `layer_ids` 用数组 |
| `layer.ungroup` | 解散组 | 传组 id |
| `layer.set_props` | 名称/不透明度/混合模式/可见性 | 改 DOM 属性，最稳 |
| `layer.move` | `forward` / `backward` / `front` / `back` | 相对当前堆叠位置 |

`layer.set_props` 的 `blend_mode` 用 PS 内部枚举名，例如 `multiply`、`screen`、`overlay`、`normal`。写错会抛错而不是静默忽略。

## 导出与置入

- `layer.export_png { dir }`：每个**顶层**图层导出一张 PNG，文件名 `NNN_图层名.png`。
  内部会逐个切可见性，**并在 finally 里恢复原状**，所以你不用担心导完图文档变样。
- `layer.place { path }`：智能对象置入，落在当前文档顶部。返回新层 id。
  从 ComfyUI 出图回填就走这条。

## 最容易踩的两个坑

1. **调整层与图层样式作用于「当前选中层」**。`adj.*` / `fx.*` 本身不接受 `layer_id`，
   所以顺序很重要：先用 `layer.duplicate` 或 `layer.move` 把目标层弄到当前位，再加效果。
   需要精确定位时，先 `layer.list` 确认 `active_layer_id`。
2. **`layer.list` 的 id 是 PS 的内部 id，跨会话不稳定**。存进脚本里当常量会失效，
   每次都重新取。
