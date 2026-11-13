# 线稿与上色引擎（anime）

这是 `dsh-photoshop-anime` 的算法层，被本项目原样复用。它的价值不在「生成」，
而在**产出分层 PSD + 真实画笔笔画**——每一步都进 PS 历史栈，可撤销、可复现。

## 四条工具

| 工具 | 必填 | 说明 |
|---|---|---|
| `lineart.run` | `reference_path` | 参考图 → 分层线稿 |
| `paint.run` | `palette` | 按几何分区批量上色到独立图层 |
| `paint.review` | — | 生成预览，不覆盖工作稿 |
| `local_edit` | `mode` | 局部 `recolor` / `shade` / `highlight` |

## 参数的含义（都是确定性的，没有随机生成）

- `threshold`（0–1）：Sobel 边缘响应阈值。调低 → 线更多更碎；调高 → 只留强边。
- `min_length`：短于这个长度（像素）的线段被丢弃，用来压掉噪点导致的碎线。
- `brush_budget`：这一批最多落多少笔。约束成本，不是画质参数。
- `seed`：只影响取点顺序，同样的 seed + 同样的参数得到同样的结果。

## 已知质量边界（前置说明，别当成 bug）

- 边缘追踪 ≠ 专业勾线。会出现**双线、断口、光影导致的杂线**。
- 上色按几何分区，相邻色块交界处可能串色。
- 上游 README 自己声明不承诺画质。这是算法特性，不是本项目引入的缺陷。

如果目标是稳定的商业线稿，先把 `threshold` 调高 + `min_length` 调大做一版，
再 `local_edit` 修局部，比一次性追求全自动更实际。

## 推荐流程

```
ps_plan({ steps: [
  { name: "doc.open", args: { path: "D:/in/ref.png", duplicate: true } },   // 不动原图
  { name: "lineart.run", args: { reference_path: "D:/in/ref.png", threshold: 0.42, min_length: 16, brush_budget: 400, seed: 42 } },
  { name: "paint.run", args: { palette: ["#f2d7c2", "#3b2b2b", "#8fbfe0"], brush_budget: 300 } },
  { name: "paint.review" },
  { name: "save.psd", args: { path: "D:/out/lineart.psd" } }
]})
```

`doc.open` 的 `duplicate: true` 很重要：不复制就会直接改原图。

## 与 ComfyUI 的分工

生成式出图交给本机 ComfyUI（SDXL），这里只做**线稿 + 上色 + 图层整理**。
两者在文件层衔接：ComfyUI 存图 → `comfy.place_latest` 置入 PS → 用不上
Firefly 那三条生成式工具（本项目已剔除）。
