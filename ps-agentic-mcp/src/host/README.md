# src/host — COM 驱动层

`ps-worker.ps1` 是 `.jsx` 与真机 Photoshop 之间唯一的桥。一个进程一件事：

```
stdin:  {"kind":"engine","op":"status","args":{}}       ← 一行 JSON
stdout: {"ok":true,"value":{...}}                       ← 一行 JSON
```

## 为什么不用常驻 proxy / UXP

| 方案 | 部署成本 | 失败模式 |
|---|---|---|
| **本方案（每次 spawn + COM）** | 无（PS 开着就行） | COM 未注册 → 一行 JSON 错误 |
| UXP 插件 + socket.io proxy | Dev Tools + 开发者模式 + 面板 Connect + 常驻进程 | **PS 重启后忘了点 Connect**，所有工具静默报错 |
| MCP server 常驻 | 进程 + 端口 + handshake | 端口占用、进程孤儿 |

代价是每次调用 500–900ms 的 COM 往返（整段 jsx 通过 BSTR 传给 PS）。
优化路径写在脚本末尾的 TODO 里，需要先把 `engine.jsx` 从 IIFE 改成可重复调用的
`run(requestPath)`。

## 坑（踩过的）

### 1. 这个文件必须保持纯 ASCII

PowerShell 5.1 按**系统 ANSI 代码页**（简中机器是 GBK）解码 `.ps1`。
脚本里有中文 → 解析器把字节切错 → 报 `字符串缺少终止符` 之类的乱码错误，
而且行号指向别处。实测：一句中文 `hint = '装好 PS 26+ 后重试'` 直接让整个脚本报废。

→ 中文说明放这里，脚本里只用英文。错误码（`photoshop_not_available` 等）
由 Node 侧翻译成给人看的话。

### 2. `DoJavaScript` 的第三个参数

`$ps.DoJavaScript($code, $null, 3)` —— `3` 是 **DoNotDisplayDialogs**。
不给这个参数时，脚本里任何触发原生弹窗的偏好设置都会让进程卡死等用户点击。
anime 的原实现在脚本内部还会再设一次 `app.displayDialogs = DialogModes.NO`，
两处都要有。

### 3. 返回值是字符串，不要二次包装

engine 返回的已经是 JSON 文本。PowerShell 侧若再 `ConvertFrom-Json` + 
`ConvertTo-Json` 会双重编码（`"{\"ok\":true}"`）。直接写 stdout。

core 命令的返回则**必须**经过 `__PSX.safe()` —— PS DOM 对象有循环引用，
`JSON.stringify` 在 ExtendScript 里没有，即使有也会炸。

### 4. request 文件要用 UTF-8 无 BOM

`engine.jsx` 里有 `text.replace(/^\uFEFF/, '')` 兜底，但 BOM 会让
严格 JSON 解析器的位置计算偏移。用 `UTF8Encoding($false)`。

### 5. 退出码约定

| 码 | 含义 |
|---:|---|
| 0 | 成功 |
| 1 | 请求格式错误 / 内部异常 |
| 2 | `Photoshop.Application` COM 未注册（未装 PS） |
| 3 | `DoJavaScript` 返回空（PS 处于模态或脚本未执行） |

## 装 PS 之后的验收顺序

```bash
node src/cli/psx.mjs run status  --backend com   # 1. COM 通不通
node src/cli/psx.mjs run doc.info --backend com  # 2. 文档/图层树读得到吗
node src/cli/psx.mjs run layer.list --backend com
node src/cli/psx.mjs run sel.rect --arg l=10 --arg t=10 --arg r=200 --arg b=200 --backend com
node src/cli/psx.mjs run image.crop_and_resize --arg width=1080 --arg height=1080 --backend com
```

前三条只读，后两条会改文档 —— 在一次性副本上跑。
