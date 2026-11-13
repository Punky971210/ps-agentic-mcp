# 选区与蒙版

## 选区工具

| 工具 | 参数 | 说明 |
|---|---|---|
| `sel.rect` | `l, t, r, b, feather?` | 矩形。坐标原点在左上，单位像素 |
| `sel.oval` | `l, t, r, b, feather?` | 椭圆 |
| `sel.subject` | — | PS 原生 `autoCutout`，本地 ML，**不上云** |
| `sel.all` / `sel.deselect` / `sel.inverse` | — | 全选 / 取消 / 反选 |
| `sel.feather` | `radius` | 羽化当前选区 |
| `sel.grow` | — | 扩到相邻相似像素（容差按 PS 默认） |
| `sel.expand` / `sel.contract` | `px` | 按像素外扩 / 内收 |
| `sel.smooth` | `px` | 平滑锯齿边缘 |
| `sel.border` | `px` | 转成等宽边框选区 |
| `sel.fill` | `color` | 用颜色填充当前选区 |

坐标是 `l/t/r/b` 而不是宽高，这是 Photoshop DOM 的口径。画 `1200×900` 文档的整幅选区就是
`{ l: 0, t: 0, r: 1200, b: 900 }`。

## 蒙版

| 工具 | 前提 | 效果 |
|---|---|---|
| `mask.from_selection` | 必须有活动选区 | 用选区生成图层蒙版 |
| `mask.add` | — | 空白蒙版 |
| `mask.invert` | 已有蒙版 | 反相 |
| `mask.delete` | 已有蒙版 | 删除（停用） |

四条都要 `layer_id`，内部会先按 id 找到 DOM 层再调 `PS.mask.*`——
`ps_core` 原来的签名要传 Layer 对象，这一层包装就是为了不让调用方关心对象引用。

## 典型流程

```
ps_plan({ steps: [
  { name: "sel.subject" },                                  // 选中主体
  { name: "sel.expand", args: { px: 2 } },                  // 稍微外扩，避免啃边
  { name: "sel.feather", args: { radius: 1.5 } },           // 柔化边缘
  { name: "mask.from_selection", args: { layer_id: 3 } },   // 转成蒙版
  { name: "layer.place", args: { path: "D:/in/bg.jpg" } }   // 置入新背景
]})
```

## 坑

- `sel.subject` 依赖 PS 的本地模型，版本低会直接抛错。没有这个能力时退回 `sel.rect` + 手工。
- 选区状态是**全局的**，任何一步 `deselect` 之后，后面的 `mask.from_selection` 会失败。
- `sel.fill` 填的是纯色，不做混合模式控制；要更细的填充，用 `fill.solid` 建填充层再加蒙版。
- `sel.border` 之后选区从「面」变成「框」，此时 `sel.fill` 只填边框——多数时候这不是你要的。
