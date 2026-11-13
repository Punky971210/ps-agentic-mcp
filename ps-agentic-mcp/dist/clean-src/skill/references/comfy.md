# ComfyUI 衔接与排查

## 只做文件级衔接，不做 API 提交

本机已有 ComfyUI 接管 SDXL 生图。这里**不**去调 `/prompt` 接口——那会引入工作流 JSON
版本耦合、队列状态管理、超时重试一堆东西，而收益只是省一次手动点队列。
所以只做两件事：

- `comfy.export` —— 把当前 PS 文档存成 PNG 到 ComfyUI 的 `input/`，返回文件名
- `comfy.place_latest` —— 把 `output/` 里最新的图置入当前 PS 文档

## 目录解析顺序

`comfy.status` 会按下面的顺序探测，第一个含 `output/` 或 `main.py` 的目录胜出：

1. `PSX_COMFY_ROOT` 环境变量
2. `./ComfyUI` / `../ComfyUI`（相对当前工作目录）
3. `C:/ComfyUI`（Windows 常见默认位置）
5. `C:/ComfyUI`

不同整合包的目录层级不同，换机器或换整合包结构时，
先跑 `comfy.status` 看 `root` 对不对，不对就设 `PSX_COMFY_ROOT`。

## 典型流程

```
ps_plan({ steps: [
  { name: "comfy.export", args: { filename: "ps-ref.png" } },        // 写进 input
  // 在 ComfyUI 里用 LoadImage 选 ps-ref.png，跑图
  { name: "comfy.place_latest" }                                    // 读 output 最新图
]})
```

`comfy.place_latest` 也接受 `filename` 指定具体文件，或 `pattern` 只在该正则命中的文件里挑最新。

## 排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `comfy_root_not_found` | 目录结构与预期不符 | 设 `PSX_COMFY_ROOT` 指到含 `output/` 的那层 |
| `server: not_listening` | ComfyUI 没启动 | 正常——文件衔接不需要它跑；只有你在手动跑图时才要 |
| `no_output_file` | `output/` 里没有图片 | 确认 ComfyUI 的 SaveImage 节点确实写了文件 |
| 置入后位置不对 | 新图尺寸与画布不一致 | 置入后用 `xf.layer` 缩放，或先 `image.crop_and_resize` |

`comfy.status` 的 `server` 字段只反映 8188 是否在监听，**不阻塞**文件操作。
所以 ComfyUI 没开着也能 export/place——只是你没法在中间跑图。
