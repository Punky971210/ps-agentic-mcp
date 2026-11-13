/**
 * 工具目录 —— 整个项目「有什么能力」的唯一真相。
 *
 * 来源三条：
 *   engine   : anime_engine.jsx 的 operation（分层线稿 / 画笔落笔 / 上色批次）
 *   core     : ps_core.jsx 的 PS.* 函数（101 个）+ ext.jsx 的增量（20 个）
 *   semantic : 官方 Adobe MCP 的接口语义（整图级高阶），本地重实现
 *   node     : 需要 Node 侧参与的工具（批量、ComfyUI 文件衔接）
 *
 * 字段
 *   name     全局唯一，MCP 的 ps_run(name) 与 CLI 的 psx run <name> 都用它
 *   kind     engine | core | semantic | node
 *   op       engine 的 operation 名
 *   expr     core/semantic 的表达式模板，`a` 是参数对象
 *   args     { 参数名: 类型 }，类型可写 array<object> 表达元素类型
 *   required 必填参数名
 *   demo     最小可执行参数，用于 ps_describe 示例 + 全目录自动冒烟
 *   needs    'mock' = 可在离线模拟层完整跑通 | 'ps' = 语义依赖真机
 *   cloud    是否依赖云端（全 false —— 本项目不需要 Firefly）
 */

// ============ 会话与文档 ============
const DOC = [
  {
    name: 'status', kind: 'engine', op: 'status',
    summary: '列出所有打开的文档、当前激活文档、PS 版本。第一个该调的工具',
    args: {}, demo: {}
  },
  {
    name: 'doc.info', kind: 'engine', op: 'info',
    summary: '单个文档的图层树、画布尺寸、选区状态',
    args: { document_id: 'number' }, demo: {}
  },
  {
    name: 'doc.create', kind: 'engine', op: 'create',
    summary: '新建文档（像素尺寸 + 分辨率 + 背景色/透明）',
    args: { width: 'number', height: 'number', resolution: 'number', name: 'string', background: 'string' },
    required: ['width', 'height'],
    // defaults 与 demo 是两件事：defaults 是工具的真实默认值（运行时生效），
    // demo 只是给 ps_describe 看的示例。engine 的 create 会对 background 调
    // rgb().replace，不兜底就会崩。
    defaults: { resolution: 72, background: 'ffffff', name: 'untitled' },
    demo: { width: 1200, height: 900, resolution: 72, name: 'untitled' }
  },
  {
    name: 'doc.open', kind: 'engine', op: 'open',
    summary: '打开本地图片；duplicate=true 时先复制一份再操作，不动原图',
    args: { path: 'string', duplicate: 'boolean' }, required: ['path'],
    demo: { path: 'D:/in/source.png', duplicate: true }, needs: 'ps'
  },
  {
    name: 'doc.save', kind: 'engine', op: 'save',
    summary: '保存为分层 PSD（保留图层与历史）',
    args: { document_id: 'number', path: 'string' }, required: ['path'],
    demo: { path: 'D:/out/result.psd' }, needs: 'ps'
  },
  {
    name: 'history.undo', kind: 'engine', op: 'undo',
    summary: '撤销一步（PS 原生历史栈）',
    args: { document_id: 'number' }, demo: {}
  },
  {
    name: 'history.undo_n', kind: 'node',
    summary: '连续撤销 N 步（循环调 history.undo）',
    args: { times: 'number', document_id: 'number' }, required: ['times'],
    demo: { times: 3 }
  },
  {
    name: 'doc.canvas_size', kind: 'core',
    expr: 'PS.document.canvasSize(app.activeDocument, a.width, a.height, a.anchor ? AnchorPosition[a.anchor] : undefined)',
    summary: '调整画布尺寸（不缩放图层）；anchor 取 TOPLEFT/TOP/TOPRIGHT/LEFT/CENTER/RIGHT/BOTTOMLEFT/BOTTOM/BOTTOMRIGHT/MIDDLECENTER',
    args: { width: 'number', height: 'number', anchor: 'string' },
    required: ['width', 'height'], demo: { width: 1400, height: 1000 }
  }
];

// ============ 线稿 / 上色 / 局部改色（anime 引擎） ============
const ANIME = [
  {
    name: 'lineart.run', kind: 'engine', op: 'lineart',
    summary: '参考图 → 分层线稿（Sobel 边缘 + 曲线追踪 + 真实画笔落笔），确定性可复现',
    args: {
      document_id: 'number', reference_path: 'string', threshold: 'number',
      min_length: 'number', brush_budget: 'number', seed: 'number'
    },
    required: ['reference_path'],
    demo: { reference_path: 'D:/in/ref.png', threshold: 0.35, min_length: 12, brush_budget: 400, seed: 42 },
    needs: 'ps'
  },
  {
    name: 'paint.run', kind: 'engine', op: 'paint_round',
    summary: '按几何分区批量上色到独立图层',
    args: { document_id: 'number', palette: 'array<string>', brush_budget: 'number' },
    demo: { palette: ['#f2d7c2', '#3b2b2b', '#8fbfe0'], brush_budget: 300 },
    needs: 'ps'
  },
  {
    name: 'paint.review', kind: 'engine', op: 'preview',
    summary: '生成预览图供人工确认，不覆盖工作稿',
    args: { document_id: 'number' }, demo: {}, needs: 'ps'
  },
  {
    name: 'local_edit', kind: 'engine', op: 'local_edit',
    summary: '局部改色 / 明暗（recolor | shade | highlight），带混合模式',
    args: { document_id: 'number', layer_id: 'number', mode: 'string', target_color: 'string' },
    required: ['mode'],
    demo: { mode: 'recolor', target_color: '#88aaff' }, needs: 'ps'
  },
  {
    name: 'color_batch.run', kind: 'engine', op: 'color_batch',
    summary: '按颜色批次批量上色到指定图层（style 默认 flat_fill 走 bounds 矩形区；style 非 flat_fill 走 marks[].points 自由笔触）',
    args: { document_id: 'number', layer_id: 'number', style: 'string', marks: 'array<object>' },
    required: ['layer_id', 'marks'],
    demo: { layer_id: 3, style: 'flat_fill', marks: [{ color: '#ff0000', bounds: { x: 0, y: 0, width: 120, height: 80 } }] },
    needs: 'ps'
  },
  {
    name: 'form_layers.run', kind: 'engine', op: 'form_layers',
    summary: '在画稿同父级内创建形体分层（线稿/底色需在同一父级：组或文档顶层；opacity 默认 100、color_round 默认 1），返回新图层 ids',
    args: {
      document_id: 'number', line_layer_id: 'number', color_layer_id: 'number',
      previous_layer_ids: 'array<number>', opacity: 'number', color_round: 'number'
    },
    required: ['line_layer_id', 'color_layer_id'],
    demo: { line_layer_id: 2, color_layer_id: 3, opacity: 80, color_round: 1 },
    needs: 'ps'
  },
  {
    name: 'form_batch.run', kind: 'engine', op: 'form_batch',
    summary: '线稿约束形体笔触：按 role（base/shadow/light/detail）分层填充与画笔描边，layer_ids 需覆盖全部 mark.role，无选区要求',
    args: { document_id: 'number', marks: 'array<object>', layer_ids: 'object' },
    required: ['marks', 'layer_ids'],
    demo: { marks: [{ role: 'base', contours: [], strokes: [] }], layer_ids: { base: 1, shadow: 2, light: 3, detail: 4 } },
    needs: 'ps'
  },
  {
    name: 'anime.run', kind: 'engine', op: 'anime',
    summary: '二次元重绘：按 plan（bounds 缺省为全画布；fills/strokes/ink_contours 缺省为空）平涂 + 线稿重绘到新组（需 RGB 文档）',
    args: { document_id: 'number', plan: 'object', layer_name: 'string' },
    required: ['plan'],
    demo: { layer_name: 'DSH', plan: { bounds: { x: 0, y: 0, width: 100, height: 100 }, fills: [], strokes: [], ink_contours: [], contour_count: 0, rendering: 'flat' } },
    needs: 'ps'
  }
];

// ============ 图层结构 ============
const LAYER = [
  {
    name: 'layer.list', kind: 'core',
    expr: 'PSX.listLayers(null, a)',
    summary: '完整图层树：嵌套组、bounds、不透明度、混合模式、文字内容、智能对象标记',
    args: { maxDepth: 'number', bounds: 'boolean' }, demo: { maxDepth: 4 }
  },
  {
    name: 'layer.merge_down', kind: 'core',
    expr: 'PSX.mergeDown(a)',
    summary: '向下合并（当前层与下一层）。不传 layer_id 则合并当前选中层',
    args: { document_id: 'number', layer_id: 'number' }, demo: {}
  },
  {
    name: 'layer.flatten', kind: 'core',
    expr: 'PSX.flatten(a)',
    summary: '拼合全部图层。会丢图层结构，调用前建议先 save.psd',
    args: { document_id: 'number' }, demo: {}
  },
  {
    name: 'layer.duplicate', kind: 'core',
    expr: 'PSX.duplicateLayer(a)',
    summary: '按 id 复制图层，可顺带重命名',
    args: { document_id: 'number', layer_id: 'number', name: 'string' },
    required: ['layer_id'], demo: { layer_id: 1, name: 'copy' }
  },
  {
    name: 'layer.delete', kind: 'core',
    expr: 'PSX.deleteLayer(a)',
    summary: '按 id 删除图层，不需要先选中',
    args: { document_id: 'number', layer_id: 'number' },
    required: ['layer_id'], demo: { layer_id: 1 }
  },
  {
    name: 'layer.group', kind: 'core',
    expr: 'PSX.groupLayers(a)',
    summary: '把多个图层编成一组',
    args: { document_id: 'number', layer_ids: 'array<number>', name: 'string' },
    required: ['layer_ids'], demo: { layer_ids: [1, 2], name: 'shapes' }
  },
  {
    name: 'layer.ungroup', kind: 'core',
    expr: 'PSX.ungroup(a)',
    summary: '解散组，把成员提到上一层',
    args: { document_id: 'number', layer_id: 'number' }, demo: {}
  },
  {
    name: 'layer.set_props', kind: 'core',
    expr: 'PSX.setLayerProps(a)',
    summary: '改图层属性：名称 / 不透明度 / 混合模式 / 可见性',
    args: { document_id: 'number', layer_id: 'number', name: 'string', opacity: 'number', blend_mode: 'string', visible: 'boolean' },
    required: ['layer_id'],
    demo: { layer_id: 1, opacity: 80, blend_mode: 'multiply' }
  },
  {
    name: 'layer.move', kind: 'core',
    expr: 'PSX.moveLayer(a)',
    summary: '调整堆叠顺序：forward / backward / front / back',
    args: { document_id: 'number', layer_id: 'number', position: 'string' },
    required: ['layer_id', 'position'], demo: { layer_id: 1, position: 'front' }
  },
  {
    name: 'layer.export_png', kind: 'core',
    expr: 'PSX.exportLayers(a.dir, a)',
    summary: '每个顶层图层导出为独立 PNG（自动恢复可见性）',
    args: { dir: 'string', skipBackground: 'boolean' }, required: ['dir'],
    demo: { dir: 'D:/out/layers' }, needs: 'ps'
  },
  {
    name: 'layer.place', kind: 'core',
    expr: 'PSX.placeImage(a.path, a)',
    summary: '把外部图片置入当前文档（作为智能对象层）',
    args: { path: 'string', name: 'string', x: 'number', y: 'number' },
    required: ['path'], demo: { path: 'D:/out/gen.png' }, needs: 'ps'
  },
  {
    name: 'layer.smart_object', kind: 'core',
    expr: 'PS.smartObject.convert()',
    summary: '把当前图层转成智能对象（后续可无损缩放）',
    args: {}, demo: {}
  },
  {
    name: 'layer.remove_background', kind: 'core',
    expr: 'PSX.removeBackground(a)',
    summary: '移除背景（adb remove_background）：选中主体 → 反选 → 清空选区内容',
    args: { document_id: 'number', layer_id: 'number' },
    required: ['layer_id'], demo: { layer_id: 1 }, needs: 'ps'
  },
  {
    name: 'layer.align', kind: 'core',
    expr: 'PSX.alignContent(a)',
    summary: '对齐当前图层（adb align_content）：mode 取 LEFT/CENTER_HORIZONTAL/RIGHT/TOP/CENTER_VERTICAL/BOTTOM',
    args: { document_id: 'number', layer_id: 'number', mode: 'string' },
    required: ['layer_id', 'mode'], demo: { layer_id: 1, mode: 'CENTER_HORIZONTAL' }, needs: 'ps'
  },
  {
    name: 'layer.preview', kind: 'core',
    expr: 'PSX.layerPreview(a)',
    summary: '导出指定图层 PNG 预览到 dir（adb get_layer_image，返回文件路径而非 base64）',
    args: { document_id: 'number', layer_id: 'number', dir: 'string' },
    required: ['layer_id', 'dir'], demo: { layer_id: 1, dir: 'D:/out/preview' }, needs: 'ps'
  }
];

// ============ 选区 ============
const SELECTION = [
  {
    name: 'sel.rect', kind: 'core',
    expr: 'PS.selection.selectRect(a.l, a.t, a.r, a.b, a.feather || 0)',
    summary: '矩形选区',
    args: { l: 'number', t: 'number', r: 'number', b: 'number', feather: 'number' },
    required: ['l', 't', 'r', 'b'], demo: { l: 10, t: 20, r: 300, b: 400 }
  },
  {
    name: 'sel.oval', kind: 'core',
    expr: 'PS.selection.selectOval(a.l, a.t, a.r, a.b, a.feather || 0)',
    summary: '椭圆选区',
    args: { l: 'number', t: 'number', r: 'number', b: 'number', feather: 'number' },
    required: ['l', 't', 'r', 'b'], demo: { l: 10, t: 20, r: 300, b: 400 }
  },
  {
    name: 'sel.subject', kind: 'core',
    expr: 'PS.selection.selectSubject()',
    summary: '选择主体（PS 原生 autoCutout，本地 ML，无云端）',
    args: {}, demo: {}, needs: 'ps'
  },
  {
    name: 'sel.all', kind: 'core',
    expr: 'PS.selection.selectAll()',
    summary: '全选',
    args: {}, demo: {}
  },
  {
    name: 'sel.deselect', kind: 'core',
    expr: 'PS.selection.deselect()',
    summary: '取消选区',
    args: {}, demo: {}
  },
  {
    name: 'sel.inverse', kind: 'core',
    expr: 'PS.selection.inverse()',
    summary: '反选',
    args: {}, demo: {}
  },
  {
    name: 'sel.feather', kind: 'core',
    expr: 'PS.selection.feather(a.radius)',
    summary: '羽化当前选区',
    args: { radius: 'number' }, required: ['radius'], demo: { radius: 4 }
  },
  {
    name: 'sel.grow', kind: 'core',
    expr: 'PS.selection.grow()',
    summary: '扩展选区到相邻相似像素（容差按 PS 默认）',
    args: {}, demo: {}
  },
  {
    name: 'sel.expand', kind: 'core',
    expr: 'PS.selection.expand(a.px)',
    summary: '按像素量向外扩展选区',
    args: { px: 'number' }, required: ['px'], demo: { px: 4 }
  },
  {
    name: 'sel.contract', kind: 'core',
    expr: 'PS.selection.contract(a.px)',
    summary: '按像素量向内收缩选区',
    args: { px: 'number' }, required: ['px'], demo: { px: 4 }
  },
  {
    name: 'sel.smooth', kind: 'core',
    expr: 'PS.selection.smooth(a.px)',
    summary: '平滑选区边缘',
    args: { px: 'number' }, required: ['px'], demo: { px: 3 }
  },
  {
    name: 'sel.border', kind: 'core',
    expr: 'PS.selection.border(a.px)',
    summary: '把选区转成等宽边框选区',
    args: { px: 'number' }, required: ['px'], demo: { px: 2 }
  },
  {
    name: 'sel.fill', kind: 'core',
    expr: "PSX.fillSelection(a)",
    summary: '用颜色填充当前选区',
    args: { color: 'string' }, required: ['color'], demo: { color: '#ff8844' }
  },
  {
    name: 'sel.similar', kind: 'core',
    expr: 'PS.selection.similar()',
    summary: '按容差把相邻相似像素并入当前选区（PS 默认容差 12）',
    args: {}, demo: {}
  },
  {
    name: 'doc.close', kind: 'core',
    expr: 'PSX.docClose(a)',
    summary: '关闭文档（默认不保存，save=true 时保存）',
    args: { document_id: 'number', save: 'boolean' },
    demo: { document_id: 1 }
  },
  {
    name: 'sel.bounds', kind: 'core',
    expr: 'PS.selection.bounds()',
    summary: '当前选区的边界矩形 [l, t, r, b]（像素）',
    args: {}, demo: {}
  },
  {
    name: 'sel.store', kind: 'core',
    expr: 'PS.selection.store(a.name)',
    summary: '把当前选区存入新 Alpha 通道（返回通道，可随后续 sel.load 恢复）',
    args: { name: 'string' }, demo: { name: 'alpha1' }
  },
  {
    name: 'sel.load', kind: 'core',
    expr: 'PS.selection.load((function(){var cs=app.activeDocument.channels||[],i;for(i=0;i<cs.length;i++){if(String(cs[i].name)===a.channel)return cs[i];}throw new Error("通道不存在: "+a.channel);})(), SelectionType[a.combine] || SelectionType.REPLACE, a.invert)',
    summary: '从 Alpha 通道载入选区；combine 取值 REPLACE/EXTEND/INTERSECT/DIMINISH',
    args: { channel: 'string', combine: 'string', invert: 'boolean' },
    required: ['channel'], demo: { channel: 'alpha1', combine: 'REPLACE' }
  },
  {
    name: 'sel.intersect_rect', kind: 'core',
    expr: 'PS.selection.intersectRect(a.l, a.t, a.r, a.b)',
    summary: '当前选区与矩形带求交集（无需通道）',
    args: { l: 'number', t: 'number', r: 'number', b: 'number' },
    required: ['l', 't', 'r', 'b'], demo: { l: 20, t: 20, r: 200, b: 150 }
  },
  {
    name: 'sel.color_range', kind: 'core',
    expr: 'PS.selection.colorRange(a.fuzziness)',
    summary: '按颜色范围建立选区（fuzziness 容差，默认 40）',
    args: { fuzziness: 'number' }, demo: { fuzziness: 40 }
  },
  {
    name: 'sel.sky', kind: 'core',
    expr: 'PSX.selSky(a)',
    summary: '选择天空（adb select_sky）：先选图层，再 AM selectSky + sampleAllLayers=false',
    args: { document_id: 'number', layer_id: 'number' },
    required: ['layer_id'], demo: { layer_id: 1 }, needs: 'ps'
  },
  {
    name: 'sel.polygon', kind: 'core',
    expr: 'PSX.selPolygon(a)',
    summary: '多边形选区（adb select_polygon）：PathItems.add 构造闭合路径后 makeSelection，points 为 [{x,y},...]',
    args: { document_id: 'number', layer_id: 'number', points: 'array<object>', feather: 'number', antiAlias: 'boolean' },
    required: ['layer_id', 'points'],
    demo: { layer_id: 1, points: [{ x: 10, y: 10 }, { x: 110, y: 10 }, { x: 110, y: 110 }] }, needs: 'ps'
  },
  {
    name: 'sel.delete', kind: 'core',
    expr: 'PSX.selDelete(a)',
    summary: '删除选区内容（adb delete_selection）：无选区时报错',
    args: { document_id: 'number', layer_id: 'number' },
    demo: {}, needs: 'ps'
  },
  {
    name: 'sel.copy', kind: 'core',
    expr: 'PSX.copySelection(a)',
    summary: '复制选区内容到剪贴板（adb copy）',
    args: { document_id: 'number', layer_id: 'number' },
    demo: { layer_id: 1 }, needs: 'ps'
  },
  {
    name: 'sel.copy_merged', kind: 'core',
    expr: 'PSX.copyMergedSelection(a)',
    summary: '合并复制选区内容到剪贴板（adb copy_merged，AM copyMerged）',
    args: { document_id: 'number' },
    demo: {}, needs: 'ps'
  },
  {
    name: 'sel.cut', kind: 'core',
    expr: 'PSX.cutSelection(a)',
    summary: '剪切选区内容到剪贴板（adb cut）',
    args: { document_id: 'number', layer_id: 'number' },
    demo: { layer_id: 1 }, needs: 'ps'
  },
  {
    name: 'sel.paste', kind: 'core',
    expr: 'PSX.pasteClipboard(a)',
    summary: '粘贴剪贴板内容（adb paste）；paste_in_place=true 走 AM paste inPlace',
    args: { document_id: 'number', layer_id: 'number', paste_in_place: 'boolean' },
    demo: { layer_id: 1 }, needs: 'ps'
  }
];

// ============ 蒙版 ============
const MASK = [
  {
    name: 'mask.from_selection', kind: 'core',
    expr: 'PSX.maskOp(a)',
    summary: '用当前选区生成图层蒙版',
    args: { document_id: 'number', layer_id: 'number' },
    required: ['layer_id'], demo: { layer_id: 1 }
  },
  {
    name: 'mask.add', kind: 'core',
    expr: 'PSX.maskOp({ layer_id: a.layer_id, op: "add", document_id: a.document_id })',
    summary: '给图层加空白蒙版',
    args: { document_id: 'number', layer_id: 'number' },
    required: ['layer_id'], demo: { layer_id: 1 }
  },
  {
    name: 'mask.invert', kind: 'core',
    expr: 'PSX.maskOp({ layer_id: a.layer_id, op: "invert", document_id: a.document_id })',
    summary: '反相蒙版',
    args: { document_id: 'number', layer_id: 'number' },
    required: ['layer_id'], demo: { layer_id: 1 }
  },
  {
    name: 'mask.delete', kind: 'core',
    expr: 'PSX.maskOp({ layer_id: a.layer_id, op: "hide", document_id: a.document_id })',
    summary: '删除（停用）蒙版',
    args: { document_id: 'number', layer_id: 'number' },
    required: ['layer_id'], demo: { layer_id: 1 }
  },
  {
    name: 'mask.hide', kind: 'core',
    expr: 'PS.mask.hide(PSX.findLayer(app.activeDocument, a.layer_id))',
    summary: '隐藏图层（全黑蒙版：选区全选 + 反相蒙版像素）',
    args: { document_id: 'number', layer_id: 'number' },
    required: ['layer_id'], demo: { layer_id: 3 }
  }
];

// ============ 调整层 ============
const ADJUST = [
  {
    name: 'adj.brightness', kind: 'core', expr: 'PS.adjustment.brightnessContrast(a)',
    summary: '亮度/对比度调整层',
    args: { brightness: 'number', contrast: 'number', name: 'string' }, demo: { brightness: 12, contrast: -8 }
  },
  {
    name: 'adj.curves', kind: 'core', expr: 'PS.adjustment.curves(a)',
    summary: '曲线调整层（points 为 [[输入,输出],...]，取值 0-255）',
    args: { channel: 'string', points: 'array<array<number>>', name: 'string' },
    demo: { channel: 'composite', points: [[0, 0], [128, 140], [255, 255]] }, needs: 'ps'
  },
  {
    name: 'adj.levels', kind: 'core', expr: 'PS.adjustment.levels(a)',
    summary: '色阶调整层',
    args: { shadow: 'number', midtone: 'number', white: 'number', name: 'string' }, demo: { shadow: 8, midtone: 1.1, white: 245 }
  },
  {
    name: 'adj.hsl', kind: 'core', expr: 'PS.adjustment.hueSaturation(a)',
    summary: '色相/饱和度调整层，支持 colorize',
    args: { hue: 'number', saturation: 'number', lightness: 'number', colorize: 'boolean', name: 'string' },
    demo: { hue: 8, saturation: 15 }
  },
  {
    name: 'adj.vibrance', kind: 'core', expr: 'PS.adjustment.vibrance(a)',
    summary: '自然饱和度调整层',
    args: { vibrance: 'number', saturation: 'number', name: 'string' }, demo: { vibrance: 20 }
  },
  {
    name: 'adj.black_white', kind: 'core', expr: 'PS.adjustment.blackWhite(a)',
    summary: '黑白调整层（可控制各色通道明度）',
    args: { name: 'string' }, demo: { name: 'BW' }
  },
  {
    name: 'adj.color_balance', kind: 'core', expr: 'PS.adjustment.colorBalance(a)',
    summary: '色彩平衡调整层，分阴影/中间调/高光',
    args: { shadows: 'array<number>', midtones: 'array<number>', highlights: 'array<number>', preserve: 'boolean', name: 'string' },
    demo: { midtones: [0, 6, -4], preserve: true }
  },
  {
    name: 'adj.exposure', kind: 'core', expr: 'PS.adjustment.exposure(a)',
    summary: '曝光度调整层',
    args: { exposure: 'number', offset: 'number', gamma: 'number', name: 'string' }, demo: { exposure: 0.3 }
  },
  {
    name: 'adj.invert', kind: 'core', expr: 'PS.adjustment.invert(a)',
    summary: '反相调整层',
    args: { name: 'string' }, demo: {}
  },
  {
    name: 'adj.gradient_map', kind: 'core', expr: 'PS.adjustment.gradientMap(a)',
    summary: '渐变映射调整层',
    args: { name: 'string' }, demo: {}
  },
  {
    name: 'adj.threshold', kind: 'core', expr: 'PS.adjustment.threshold(a)',
    summary: '阈值调整层',
    args: { level: 'number', name: 'string' }, required: ['level'], demo: { level: 128 }
  },
  {
    name: 'adj.posterize', kind: 'core', expr: 'PS.adjustment.posterize(a)',
    summary: '色调分离调整层',
    args: { levels: 'number', name: 'string' }, required: ['levels'], demo: { levels: 6 }
  },
  {
    name: 'adj.photo_filter', kind: 'core', expr: 'PS.adjustment.photoFilter(a)',
    summary: '照片滤镜调整层（暖/冷色调）',
    args: { red: 'number', green: 'number', blue: 'number', density: 'number', preserve: 'boolean', name: 'string' },
    demo: { red: 236, green: 180, blue: 120, density: 25 }
  },
  {
    name: 'adj.selective_color', kind: 'core', expr: 'PS.adjustment.selectiveColor(a)',
    summary: '可选颜色调整层（按色系微调 CMYK）',
    args: { corrections: 'object', absolute: 'boolean', name: 'string' },
    demo: { corrections: { reds: [0, 0, 0, 10] } }, needs: 'ps'
  },
  {
    name: 'adj.channel_mixer', kind: 'core', expr: 'PS.adjustment.channelMixer(a)',
    summary: '通道混合器调整层',
    args: { red: 'array<number>', green: 'array<number>', blue: 'array<number>', monochrome: 'boolean', name: 'string' },
    demo: { red: [100, 0, 0], green: [0, 100, 0], blue: [0, 0, 100] }, needs: 'ps'
  }
];

// ============ 图层样式 ============
const STYLE = [
  {
    name: 'fx.dropShadow', kind: 'core', expr: "PSX.styleFx('dropShadow', a)",
    summary: '投影图层样式',
    args: { opacity: 'number', distance: 'number', size: 'number', angle: 'number', color: 'string' },
    demo: { opacity: 60, distance: 8, size: 16, angle: 120 }
  },
  {
    name: 'fx.stroke', kind: 'core', expr: "PSX.styleFx('stroke', a)",
    summary: '描边图层样式',
    args: { size: 'number', color: 'string', position: 'string' }, demo: { size: 3, color: '#ffffff', position: 'outside' }
  },
  {
    name: 'fx.inner_shadow', kind: 'core', expr: "PSX.styleFx('innerShadow', a)",
    summary: '内阴影图层样式',
    args: { opacity: 'number', distance: 'number', size: 'number', angle: 'number', color: 'string', choke: 'number' },
    demo: { opacity: 50, distance: 5, size: 8, angle: 120 }
  },
  {
    name: 'fx.outer_glow', kind: 'core', expr: "PSX.styleFx('outerGlow', a)",
    summary: '外发光图层样式',
    args: { opacity: 'number', size: 'number', spread: 'number', color: 'string' },
    demo: { opacity: 60, size: 12, spread: 4, color: '#ffd166' }
  },
  {
    name: 'fx.bevel', kind: 'core', expr: "PSX.styleFx('bevel', a)",
    summary: '斜面和浮雕图层样式',
    args: { color: 'string' }, demo: { color: '#ffffff' }
  },
  {
    name: 'fx.color_overlay', kind: 'core', expr: "PSX.styleFx('colorOverlay', a)",
    summary: '颜色叠加图层样式',
    args: { color: 'string', opacity: 'number' }, demo: { color: '#3366ff', opacity: 80 }
  },
  {
    name: 'fx.gradient_overlay', kind: 'core', expr: "PSX.styleFx('gradientOverlay', a)",
    summary: '渐变叠加图层样式',
    args: { preset: 'string', opacity: 'number' }, demo: { preset: '日落', opacity: 70 }, needs: 'ps'
  },
  {
    name: 'fx.clear', kind: 'core', expr: "PSX.styleFx('clearAll', a)",
    summary: '清空当前图层的所有图层样式',
    args: {}, demo: {}
  },
  {
    name: 'fx.inner_glow', kind: 'core', expr: "PSX.styleFx('innerGlow', a)",
    summary: '内发光图层样式',
    args: { color: 'array<number>', opacity: 'number', choke: 'number', size: 'number' },
    demo: { color: [255, 80, 80], opacity: 60, choke: 5, size: 18 }
  },
  {
    name: 'fx.pattern_overlay', kind: 'core', expr: "PSX.styleFx('patternOverlay', a)",
    summary: '图案叠加图层样式（沿用当前图案预设）',
    args: { opacity: 'number' }, demo: { opacity: 60 }
  }
];

// ============ 文字 ============
const TEXT = [
  {
    name: 'text.add', kind: 'core', expr: 'PS.text.add(a)',
    summary: '新建文字层（内容 / 字体 / 字号 / 颜色 / 位置）',
    args: { contents: 'string', font: 'string', size: 'number', color: 'string', position: 'array<number>', name: 'string' },
    required: ['contents'], demo: { contents: 'Hello', size: 48, color: '#111111', position: [80, 120] }
  },
  {
    name: 'text.update', kind: 'core', expr: 'PSX.updateText(a)',
    summary: '改已有文字层的文案 / 字号 / 字体 / 字距',
    args: { layer_id: 'number', contents: 'string', size: 'number', font: 'string', tracking: 'number' },
    required: ['layer_id'], demo: { layer_id: 2, contents: 'Replaced' }
  },
  {
    name: 'text.style', kind: 'core', expr: 'PSX.textStyle(a)',
    summary: '文字层高级样式：行距 / 字距 / 水平垂直缩放 / 基线偏移',
    args: { layer_id: 'number', leading: 'number', tracking: 'number', scale_h: 'number', scale_v: 'number', baseline_shift: 'number' },
    required: ['layer_id'], demo: { layer_id: 2, leading: 56, tracking: 20 }
  },
  {
    name: 'text.warp', kind: 'core',
    expr: 'PS.text.warp({ layer: PSX.findLayer(app.activeDocument, a.layer_id), style: a.style, bend: a.bend, horzDist: a.horzDist, vertDist: a.vertDist })',
    summary: '文字变形：style 取 arc/flag/wave 等，bend 弯曲 / horzDist 水平扭曲 / vertDist 垂直扭曲',
    args: { layer_id: 'number', style: 'string', bend: 'number', horzDist: 'number', vertDist: 'number' },
    required: ['layer_id'], demo: { layer_id: 2, style: 'wave', bend: 15 }
  },
  {
    name: 'text.set_tracking', kind: 'core',
    expr: 'PS.text.setTracking(PSX.findLayer(app.activeDocument, a.layer_id), a.tracking)',
    summary: '设置文字层字距（tracking）',
    args: { layer_id: 'number', tracking: 'number' },
    required: ['layer_id', 'tracking'], demo: { layer_id: 2, tracking: 40 }
  },
  {
    name: 'text.set_leading', kind: 'core',
    expr: 'PS.text.setLeading(PSX.findLayer(app.activeDocument, a.layer_id), a.leading)',
    summary: '设置文字层行距（leading）',
    args: { layer_id: 'number', leading: 'number' },
    required: ['layer_id', 'leading'], demo: { layer_id: 2, leading: 60 }
  },
  {
    name: 'text.set_scale', kind: 'core',
    expr: 'PS.text.setScale(PSX.findLayer(app.activeDocument, a.layer_id), a.scale_h, a.scale_v)',
    summary: '设置文字层水平 / 垂直缩放（百分数）',
    args: { layer_id: 'number', scale_h: 'number', scale_v: 'number' },
    required: ['layer_id'], demo: { layer_id: 2, scale_h: 110, scale_v: 110 }
  },
  {
    name: 'text.set_baseline_shift', kind: 'core',
    expr: 'PS.text.setBaselineShift(PSX.findLayer(app.activeDocument, a.layer_id), a.baseline_shift)',
    summary: '设置文字层基线偏移',
    args: { layer_id: 'number', baseline_shift: 'number' },
    required: ['layer_id', 'baseline_shift'], demo: { layer_id: 2, baseline_shift: 4 }
  },
  {
    name: 'font.list', kind: 'core',
    expr: 'PSX.fontList()',
    summary: '枚举 Photoshop 已装字体（adb 字体列表），返回 postScriptName 数组，可离线',
    args: {},
    demo: {}
  }
];

// ============ 形状 ============
const SHAPE = [
  {
    name: 'shape.rect', kind: 'core', expr: 'PSX.addShape({ kind: "rectangle", l: a.l, t: a.t, r: a.r, b: a.b, color: a.color, name: a.name, document_id: a.document_id })',
    summary: '画矩形色块（按 l/t/r/b 定位并缩放）',
    args: { l: 'number', t: 'number', r: 'number', b: 'number', color: 'array<number>', name: 'string' },
    required: ['l', 't', 'r', 'b'], demo: { l: 40, t: 40, r: 240, b: 160, color: [255, 120, 60] }
  },
  {
    name: 'shape.rounded_rect', kind: 'core', expr: 'PSX.addShape({ kind: "rounded_rect", l: a.l, t: a.t, r: a.r, b: a.b, color: a.color, name: a.name, document_id: a.document_id })',
    summary: '画圆角矩形色块',
    args: { l: 'number', t: 'number', r: 'number', b: 'number', color: 'array<number>', name: 'string' },
    required: ['l', 't', 'r', 'b'], demo: { l: 40, t: 40, r: 240, b: 160, color: [60, 120, 255] }
  },
  {
    name: 'shape.ellipse', kind: 'core', expr: 'PSX.addShape({ kind: "ellipse", l: a.l, t: a.t, r: a.r, b: a.b, color: a.color, name: a.name, document_id: a.document_id })',
    summary: '画椭圆色块',
    args: { l: 'number', t: 'number', r: 'number', b: 'number', color: 'array<number>', name: 'string' },
    required: ['l', 't', 'r', 'b'], demo: { l: 60, t: 60, r: 260, b: 260, color: [80, 200, 140] }
  },
  {
    name: 'shape.line', kind: 'core', expr: 'PSX.addShape({ kind: "line", l: a.l, t: a.t, r: a.r, b: a.b, color: a.color, name: a.name, document_id: a.document_id })',
    summary: '画直线',
    args: { l: 'number', t: 'number', r: 'number', b: 'number', color: 'array<number>', name: 'string' },
    required: ['l', 't', 'r', 'b'], demo: { l: 20, t: 20, r: 400, b: 400, color: [20, 20, 20] }
  },
  {
    name: 'shape.polygon', kind: 'core', expr: 'PSX.addShape({ kind: "polygon", l: a.l, t: a.t, r: a.r, b: a.b, color: a.color, name: a.name, document_id: a.document_id })',
    summary: '画多边形色块',
    args: { l: 'number', t: 'number', r: 'number', b: 'number', color: 'array<number>', name: 'string' },
    required: ['l', 't', 'r', 'b'], demo: { l: 40, t: 40, r: 240, b: 240, color: [200, 80, 120] }
  },
  {
    name: 'shape.triangle', kind: 'core', expr: 'PSX.addShape({ kind: "triangle", l: a.l, t: a.t, r: a.r, b: a.b, color: a.color, name: a.name, document_id: a.document_id })',
    summary: '画三角形色块（按 l/t/r/b 定界；与其它 shape 同一套矩形几何语义）',
    args: { l: 'number', t: 'number', r: 'number', b: 'number', color: 'array<number>', name: 'string' },
    demo: { l: 40, t: 40, r: 200, b: 180, color: [120, 200, 80], name: 'tri' }
  }
];

// ============ 填充 / 滤镜 / 变换 ============
const EFFECT = [
  {
    name: 'fill.solid', kind: 'core', expr: 'PS.fill.solidColor(a)',
    summary: '新建纯色填充层',
    args: { red: 'number', green: 'number', blue: 'number', name: 'string' }, demo: { red: 250, green: 240, blue: 230, name: 'bg' }
  },
  {
    name: 'fill.gradient', kind: 'core', expr: 'PS.fill.gradient(a)',
    summary: '新建渐变填充层（按预设名）',
    args: { preset: 'string', style: 'string', angle: 'number', scale: 'number', reverse: 'boolean', name: 'string' },
    required: ['preset'], demo: { preset: '日落', style: 'linear', angle: 90 }, needs: 'ps'
  },
  {
    name: 'filter.gaussian', kind: 'core', expr: 'PS.filter.gaussianBlur(a.radius)',
    summary: '高斯模糊（当前图层）',
    args: { radius: 'number' }, required: ['radius'], demo: { radius: 3 }
  },
  {
    name: 'filter.motion', kind: 'core', expr: 'PS.filter.motionBlur(a.angle, a.distance)',
    summary: '动感模糊（当前图层）',
    args: { angle: 'number', distance: 'number' }, required: ['angle', 'distance'], demo: { angle: 45, distance: 20 }
  },
  {
    name: 'xf.rotateCanvas', kind: 'core', expr: 'PS.transform.rotateCanvas(a.angle)',
    summary: '旋转画布（正数为顺时针）',
    args: { angle: 'number' }, required: ['angle'], demo: { angle: 90 }
  },
  {
    name: 'xf.flip', kind: 'core', expr: 'PS.transform.flipCanvas(a.dir)',
    summary: '翻转画布：horizontal / vertical',
    args: { dir: 'string' }, required: ['dir'], demo: { dir: 'horizontal' }
  },
  {
    name: 'xf.layer', kind: 'core', expr: "PSX.transformLayer(a)",
    summary: '按百分比缩放 + 旋转指定图层（不传 layer_id 作用于活动层；背景层/锁定层返回可读错误）',
    args: { layer_id: 'number', widthPct: 'number', heightPct: 'number', angle: 'number' }, demo: { widthPct: 120, heightPct: 120, angle: 0 }
  }
];

// ============ 保存 ============
const SAVE = [
  { name: 'save.psd', kind: 'core', expr: 'PS.save.psd(app.activeDocument, a.path)', summary: '另存为 PSD', args: { path: 'string' }, required: ['path'], demo: { path: 'D:/out/a.psd' } },
  { name: 'save.jpg', kind: 'core', expr: 'PS.save.jpg(app.activeDocument, a.path, a.quality)', summary: '另存为 JPG', args: { path: 'string', quality: 'number' }, required: ['path'], demo: { path: 'D:/out/a.jpg', quality: 10 } },
  { name: 'save.png', kind: 'core', expr: 'PS.save.png(app.activeDocument, a.path)', summary: '另存为 PNG', args: { path: 'string' }, required: ['path'], demo: { path: 'D:/out/a.png' } },
  { name: 'save.copy', kind: 'core', expr: 'PS.save.copy(app.activeDocument, a.path)', summary: '另存一份副本（不影响当前文档路径）', args: { path: 'string' }, required: ['path'], demo: { path: 'D:/out/a-copy.psd' } }
];

// ============ 官方 MCP 语义（本地重实现） ============
const SEMANTIC = [
  {
    name: 'image.crop_and_resize', kind: 'semantic', source: '官方 image_crop_and_resize',
    expr: 'PSX.cropAndResize(a)',
    summary: '按目标比例居中裁剪 + 缩放到指定像素，一步到位',
    args: { width: 'number', height: 'number', mode: 'string' }, required: ['width', 'height'],
    demo: { width: 1080, height: 1080 }, needs: 'ps'
  },
  {
    name: 'image.auto_tone', kind: 'semantic', source: '官方 image_apply_auto_tone',
    expr: 'PSX.autoTone(a)',
    summary: '自动色调（PS 原生 autoLevelsEvent / autoContrastEvent，无云端）',
    args: { mode: 'string' }, demo: {}
  },
  {
    name: 'image.auto_straighten', kind: 'semantic', source: '官方 image_auto_straighten',
    expr: 'PS.transform.rotateCanvas(a.angle)',
    summary: '按给定角度拉直画面（角度需外部检测或人工给）',
    args: { angle: 'number' }, required: ['angle'], demo: { angle: -2.5 }
  },
  {
    name: 'image.apply_adjustments', kind: 'semantic', source: '官方 image_apply_adjustments',
    expr: 'PSX.applyAdjustments(a.adjustments)',
    summary: '一次调用叠多个调整层（官方批量语义的本地等价）',
    args: { adjustments: 'array<object>' }, required: ['adjustments'],
    demo: { adjustments: [{ kind: 'brightness', brightness: 10 }, { kind: 'vibrance', vibrance: 15 }] }, needs: 'ps'
  },
  {
    name: 'image.lens_blur', kind: 'semantic', source: '官方 image_apply_lens_blur',
    expr: 'PSX.lensBlur(a)',
    summary: '镜头模糊（PS 27 动作不可用时自动降级为等半径高斯模糊，返回里 via 字段标注）',
    args: { layer_id: 'number', radius: 'number', focal: 'number' }, demo: { radius: 6, focal: 50 }
  }
];

// ============ 批量 / 作业编排 ============
const BATCH = [
  {
    name: 'batch.run', kind: 'node',
    summary: '一次调用串跑多步并逐步回报；保持文档状态，支持 stop_on_error。批量导出、批量套版用它',
    args: { steps: 'array<object>', stop_on_error: 'boolean', document_id: 'number' },
    required: ['steps'],
    demo: {
      steps: [
        { name: 'sel.all' },
        { name: 'filter.gaussian', args: { radius: 1 } },
        { name: 'save.psd', args: { path: 'D:/out/batch.psd' } }
      ]
    }
  }
];

// ============ ComfyUI 文件级衔接（不走 API） ============
const COMFY = [
  {
    name: 'comfy.status', kind: 'node',
    summary: '检查 ComfyUI 是否在跑（127.0.0.1:8188）、input/output 目录是否可达',
    args: {}, demo: {}
  },
  {
    name: 'comfy.export', kind: 'node',
    summary: '把当前文档存成 PNG 到 ComfyUI 的 input 目录，返回可直接给 LoadImage 节点的文件名',
    args: { filename: 'string', document_id: 'number' },
    demo: { filename: 'ps-ref.png' }, needs: 'ps'
  },
  {
    name: 'comfy.place_latest', kind: 'node',
    summary: '把 ComfyUI output 目录里最新（或指定）的图片置入当前文档',
    args: { filename: 'string', pattern: 'string', x: 'number', y: 'number' },
    demo: {}, needs: 'ps'
  }
];

// ============ 原生弹窗处理（宿主侧，不在 PS 内执行） ============
// 原生模态框弹出时，DoJavaScript 所在的那条 JSX 线程就是被冻住的线程，PS 侧无法自救；
// 只有独立宿主进程能 EnumWindows 看到并点掉它。故这两条是 kind:'node'。
const DIALOG = [
  {
    name: 'dialog.scan', kind: 'node',
    summary: '列出当前 Photoshop 的原生弹窗（class / 标题 / 按钮文案）。无副作用，用于判断 COM 是否被弹窗冻住',
    args: {}, demo: {}
  },
  {
    name: 'dialog.handle', kind: 'node',
    summary: '处理当前 Photoshop 原生弹窗：auto=存盘类按确定、栅格化确认与未知按取消；ok=一律确定；cancel=一律取消',
    args: { policy: 'string' },
    defaults: { policy: 'auto' },
    demo: { policy: 'auto' }
  }
];

export const TOOLS = [
  ...DOC, ...ANIME, ...LAYER, ...SELECTION, ...MASK,
  ...ADJUST, ...STYLE, ...TEXT, ...SHAPE, ...EFFECT,
  ...SAVE, ...SEMANTIC, ...BATCH, ...COMFY, ...DIALOG
];

export const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** 分组名取自 name 前缀；为分组补一句人话说明，方便 ps_search 无参时给概览。 */
export const GROUP_LABELS = {
  status: '会话状态',
  doc: '文档：新建 / 打开 / 保存 / 信息 / 画布尺寸',
  history: '历史：撤销',
  lineart: '线稿：参考图 → 分层线稿',
  paint: '上色：批量上色 / 预览',
  local_edit: '局部改色',
  color_batch: '上色批次：按颜色批量上色到图层',
  form_layers: '形体分层：形体上色的分层结构',
  form_batch: '形体批次：线稿约束的形体笔触',
  anime: '二次元重绘：平涂 + 线稿重绘',
  layer: '图层：树 / 合并 / 复制 / 删除 / 编组 / 属性 / 顺序 / 导出 / 置入',
  sel: '选区：矩形 / 椭圆 / 相似 / 存储加载 / 相交 / 颜色范围 / 扩展收缩 / 填充',
  mask: '蒙版：选区转蒙版 / 反相 / 删除 / 隐藏',
  adj: '调整层：亮度 曲线 色阶 色相 自然饱和度 等 15 种',
  fx: '图层样式：投影 描边 内阴影 内外发光 斜面 叠加',
  text: '文字：新建 / 改文案 / 高级样式 / 变形 / 行距 字距 缩放 基线',
  shape: '形状：矩形 圆角 椭圆 直线 多边形 三角形',
  fill: '填充层：纯色 / 渐变',
  filter: '滤镜：高斯模糊 / 动感模糊',
  xf: '变换：旋转 / 翻转 / 缩放图层',
  save: '保存：PSD / JPG / PNG / 副本',
  image: '整图级高阶（对齐官方 MCP 语义）',
  batch: '批量编排',
  comfy: 'ComfyUI 文件衔接',
  dialog: '原生弹窗：扫描 / 处理（宿主侧）'
};

export function groupOf(name) {
  return String(name).split('.')[0];
}

export function listTools() {
  return TOOLS.map((t) => ({
    name: t.name,
    group: groupOf(t.name),
    kind: t.kind,
    summary: t.summary,
    offline: t.needs !== 'ps',
    cloud: !!t.cloud,
    required: t.required || [],
    args: t.args,
    demo: t.demo || {}
  }));
}

export function groups(tools = TOOLS) {
  const out = new Map();
  for (const t of tools) {
    const g = groupOf(t.name);
    if (!out.has(g)) out.set(g, []);
    out.get(g).push(t);
  }
  return out;
}
