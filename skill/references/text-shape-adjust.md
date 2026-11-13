# 文字、形状、调整层、图层样式

## 文字

| 工具 | 必填 | 可选 |
|---|---|---|
| `text.add` | `contents` | `size` `font` `color` `position` `name` |
| `text.update` | `layer_id` | `contents` `size` `font` `tracking` |
| `text.style` | `layer_id` | `leading` `tracking` `scale_h` `scale_v` `baseline_shift` |

`position` 是 `[x, y]`，文字层的锚点默认在左基线附近，所以 y 要给得比视觉顶部大一些。

`font` 用 PostScript 名，例如 `ArialMT`、`PingFangSC-Regular`、`SourceHanSansCN-Bold`。
名字写错 PS 会静默回退到默认字体——**不会报错**，所以出图后要自己看一眼。
不确定时先用 `app.fonts` 里存在的名字（`ps_run({name:"status"})` 不返回字体列表，
需要时先在 PS 里查，或直接用 `ArialMT` 这种一定存在的）。

`text.update` / `text.style` 对非文字层会抛「目标图层不是文字层」。
先用 `layer.list` 看 `isText`，别拿 id 猜。

## 形状

| 工具 | 说明 |
|---|---|
| `shape.rect` | 矩形色块 |
| `shape.rounded_rect` | 圆角矩形 |
| `shape.ellipse` | 椭圆 |
| `shape.line` | 直线 |
| `shape.polygon` | 多边形 |

参数统一是 `l, t, r, b, color?, name?`，`color` 用 `[r, g, b]` 数组（0–255）。

实现细节：`ps_core` 的 `PS.shape.*` 只能建「默认尺寸」的形状，没法指定位置。
这一层先用 `addShape` 建出来，再按目标矩形算百分比 `resize` + `translate` 到位。
所以如果你给了 `l/t/r/b`，最终位置是准的；只给部分坐标时停在默认大小。

## 调整层（15 种）

`adj.brightness` `adj.curves` `adj.levels` `adj.hsl` `adj.vibrance`
`adj.black_white` `adj.color_balance` `adj.exposure` `adj.invert` `adj.gradient_map`
`adj.threshold` `adj.posterize` `adj.photo_filter` `adj.selective_color` `adj.channel_mixer`

参数见 `ps_describe`，几个容易写错的：

- `adj.curves` 的 `points` 是 `[[输入, 输出], ...]`，取值 0–255，不是 0–1。
- `adj.levels` 的 `midtone` 是**伽马值**（1.0 不变，>1 变亮），不是百分比。
- `adj.color_balance` 三个数组各是 `[阴影, 中间调, 高光]` 中的一个（`[-100, 100]`）。
- `adj.selective_color` 的 `corrections` 是对象，键是色系名（`reds` / `yellows` / `neutrals` …），值是 `[c, m, y, k]` 增量。
- `adj.channel_mixer` 三个数组是各通道对 R/G/B 的贡献百分比。

**全部都是「新建调整层」，不是直接改像素。** 好处是随时可以双击回调；坏处是图层数会涨。
批量叠多层时用 `image.apply_adjustments` 一次提交更省往返。

## 图层样式

`fx.dropShadow` `fx.stroke` `fx.inner_shadow` `fx.outer_glow` `fx.bevel`
`fx.color_overlay` `fx.gradient_overlay` `fx.clear`

- `fx.stroke` 的 `position`：`inside` / `center` / `outside`。
- `fx.gradient_overlay` 的 `preset` 是 PS 渐变预设名（中文版是中文名，如 `日落`）。
  名字不存在时会抛错，跨语言版本要注意。
- 这些样式**作用于当前选中层**，不接受 `layer_id`。见 `layer.md` 的坑。

## 保存与导出

`save.psd` / `save.jpg`（`quality` 1–12）/ `save.png` / `save.copy`

`image.crop_and_resize` 是「按目标比例居中裁剪 + 缩放」一步到位，
比先 `doc.crop` 再 resize 少一次往返，也不会算错居中偏移。
