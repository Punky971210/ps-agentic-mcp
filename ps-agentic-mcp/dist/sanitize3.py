#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""干净包脱敏：清除「外部资源指认」与「内部决策痕迹」。

设计：
  - 每条规则用正则，带期望计数；计数不符即报错退出（绝不静默漏改）。
  - 只动文案 / 注释 / 提示语，不动任何可执行逻辑。
  - 保留原文件行尾符（runner.mjs / ext.jsx 是 CRLF）。
  - 「批次」等产品术语（上色批次）显式不参与替换。
"""
import io
import re
import sys

ROOT = 'dist/clean-src/'
CRLF = chr(13) + chr(10)
LF = chr(10)

rules = []
fails = []


def R(f, why, pattern, repl, expect):
    rules.append((f, why, pattern, repl, expect))


# ---------------- A 类：外部资源指认 ----------------
NODE_PATH = r'NODE="C:/Users/[^/"]+/.workbuddy/binaries/node/versions/[^"]*"'
R('README.md', '机器专属 node 路径', NODE_PATH, 'NODE="node"                     # 也可填 node 的绝对路径', 1)
R('skill/SKILL.md', '机器专属 node 路径', NODE_PATH, 'NODE="node"', 1)
R('skill/SKILL.md', '项目绝对路径', r'\$NODE D:/Project/ps-agent/src/cli/psx\.mjs', '$NODE src/cli/psx.mjs', 4)
R('bin/ps-agent-mcp.cmd', '机器专属 node 回退', r'\nif not defined NODE_BIN set "NODE_BIN=C:\\Users[^\n]*', '', 1)
R('bin/ps-agent-mcp.cmd', '回退注释',
  r'rem Prefer node from PATH; fall back to the managed runtime so DSH can launch\nrem this even when its child process environment is minimal\.',
  'rem Resolve node from PATH; no machine-specific fallback is baked in.', 1)
R('bin/ps-agent-mcp.cmd', '错误提示措辞', r'Install Node 20\+ or fix the fallback path\.',
  'Install Node 20+ and make sure it is on PATH.', 1)

R('skill/references/comfy.md', '机器 ComfyUI 布局',
  r'2\. `D:/ComfyUI/ComfyUI/ComfyUI`（绘世整合包的实际布局）\n3\. `D:/ComfyUI/ComfyUI`\n4\. `D:/ComfyUI`',
  '2. `./ComfyUI` / `../ComfyUI`（相对当前工作目录）\n3. `C:/ComfyUI`（Windows 常见默认位置）', 1)
R('skill/references/comfy.md', '本机实测口径', r'本机实测命中的是 `D:/ComfyUI/ComfyUI/ComfyUI`。',
  '不同整合包的目录层级不同，', 1)

R('src/core/runner.mjs', '机器布局注释',
  r' \* 绘世整合包的实际布局是 D:/ComfyUI/ComfyUI/ComfyUI，所以按候选列表逐个探测，\n \* 而不是写死一层。',
  ' * 不同整合包的目录层级不同，因此按候选列表逐个探测，而不是写死一层。', 1)
R('src/core/runner.mjs', '候选路径表',
  r"    'D:/ComfyUI/ComfyUI/ComfyUI',\n    'D:/ComfyUI/ComfyUI',\n    'D:/ComfyUI',\n    'C:/ComfyUI'",
  "    './ComfyUI',\n    '../ComfyUI',\n    'C:/ComfyUI'", 1)
R('src/core/runner.mjs', '示例路径', r"hint: '例如 PSX_COMFY_ROOT=D:/ComfyUI/ComfyUI/ComfyUI'",
  "hint: '例如 PSX_COMFY_ROOT=/path/to/ComfyUI'", 1)

# ---------------- B 类：内部决策痕迹 ----------------
R('src/core/runner.mjs', '实测→已知', r'// 实测两种坏形态：', '// 已知两种坏形态：', 1)
R('src/core/runner.mjs', '实测时长口径',
  r'// 整个实例冻结 —— 实测一次冻结 = 28s 超时 \+ 解卡 \+ 连带污染后续几十条调用。',
  '// 整个实例冻结 —— 一次冻结意味着数十秒超时，并连带后续调用失败。', 1)
R('src/core/runner.mjs', '面向用户的实测措辞', r'（实测 28s 超时 \+ 连带失败）', '（会导致超时并连带后续调用失败）', 1)

R('src/engine/ext.jsx', '注释实测', r'会弹「必须栅格化」并冻结实例（实测）。', '会弹「必须栅格化」并冻结实例。', 1)
R('src/engine/ext.jsx', '实测→行为(行注释)', r'// PS 27 实测：', '// PS 27 行为：', 2)
R('src/engine/ext.jsx', '实测→行为(块注释)', r'复制图层，可选重命名。PS 27 实测：', '复制图层，可选重命名。PS 27 行为：', 1)
R('src/engine/ext.jsx', '缺陷→已知问题', r'图层样式统一入口。修两个实测缺陷：', '图层样式统一入口。处理两个已知问题：', 1)
R('src/engine/ext.jsx', '缺陷→已知问题', r'选区填充。修实测缺陷：', '选区填充。处理已知问题：', 1)
R('src/engine/ext.jsx', '缺陷→已知问题', r'图层自由变换。修两个实测缺陷：', '图层自由变换。处理两个已知问题：', 1)
R('src/engine/ext.jsx', '真机实测', r'真机实测它会拉起模态', '它会拉起模态', 1)
R('src/engine/ext.jsx', '实测被拒', r'PS 27 上实测被拒', 'PS 27 上会被拒', 1)

R('src/host/README.md', '实测措辞', r'而且行号指向别处。实测：', '而且行号指向别处。例如：', 1)
R('src/host/README.md', '直接报废措辞', r'` 直接让整个脚本报废。', '` 会让整个脚本报废。', 1)

R('skill/references/anime.md', '本项目措辞', r'这是算法特性，不是本项目引入的缺陷。', '这是算法特性，不是本工具引入的局限。', 1)

R('skill/SKILL.md', '日期+实测标题', r'## 使用铁律（2026-10-24 真机实测得出，逐条都有代价）', '## 使用铁律（逐条都有代价）', 1)
R('skill/SKILL.md', '历史缺陷→已知限制', r'`isText` 恒为 false（历史实现缺陷，未修）。', '`isText` 恒为 false（已知限制）。', 1)
R('skill/SKILL.md', 'layer.place 过时描述',
  r'9\. \*\*`layer\.place` 当前不可用\*\*（PS 27 关闭「非最前」文档抛不可捕获错误，层会置入但调用报错并遗留临时文档）—— 需要换素材请人工置入，或等该缺陷修复。',
  '9. **`layer.place` 走剪贴板通道**：功能等价于置入图层，但超大素材（数百 MB）会占用剪贴板内存；失败时用 `doc.close` 清理可能残留的临时文档。', 1)


def load(path):
    raw = io.open(path, encoding='utf-8', newline='').read()
    had_crlf = (CRLF in raw)
    return raw.replace(CRLF, LF), had_crlf


def save(path, text, had_crlf):
    if had_crlf:
        text = text.replace(LF, CRLF)
    io.open(path, 'w', encoding='utf-8', newline='').write(text)


by_file = {}
for f, why, pat, repl, expect in rules:
    by_file.setdefault(f, []).append((why, pat, repl, expect))

for f, items in by_file.items():
    p = ROOT + f
    s, had_crlf = load(p)
    for why, pat, repl, expect in items:
        s2, n = re.subn(pat, repl, s)
        if n != expect:
            fails.append('%s [%s] 期望 %d 次，实际 %d 次' % (f, why, expect, n))
            continue
        s = s2
    save(p, s, had_crlf)

# 兜底扫描：确认没有漏网的内部痕迹（通用示例路径 D:/in|out 不算外部指认）
LEFTOVER = [
    (r'C:/Users/|C:\\Users|\.workbuddy', '外部机器路径'),
    (r'D:/Project|D:/ComfyUI|绘世整合包', '外部项目指认'),
    (r'2026-1[0-2]-[0-9]{2}', '内部日期'),
]
for f in sorted(by_file):
    s, _ = load(ROOT + f)
    for pat, why in LEFTOVER:
        for m in re.finditer(pat, s):
            fails.append('%s 仍有%s：%s' % (f, why, m.group(0)))

if fails:
    print('!!! 脱敏未通过：')
    for x in fails:
        print('   ' + x)
    sys.exit(1)

print('脱敏完成：%d 条规则全部按期望命中，兜底扫描干净。' % len(rules))
