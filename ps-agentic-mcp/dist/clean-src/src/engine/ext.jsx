/*
 * ext.jsx —— ps-agent 自己的扩展层。
 *
 * 原则：不修改上游三份源码（ps_core / anime_engine / adb_uxp_src），
 * 所有增量都放这里，这样 `git pull` 上游后重新同步不会丢东西。
 *
 * 内容分两类：
 *   A. ps_core 缺的能力（与 adb-mcp 的差集）：批量导出图层、置入智能对象、
 *      改文字、完整图层树
 *   B. 官方 Adobe MCP 的语义（整图级高阶操作）：autoTone、lensBlur、
 *      cropAndResize、applyAdjustments
 *
 * 必须 ES3 兼容，且不依赖 ps_core 之外的任何东西（只用到 app/ActionManager）。
 */
var PSX = (function () {
    var c2t = charIDToTypeID;
    var s2t = stringIDToTypeID;

    function requireDoc(doc) {
        var d = doc || app.activeDocument;
        if (!d) throw new Error('没有打开的文档');
        return d;
    }

    function px(v) { return typeof v.as === 'function' ? v.as('px') : Number(v); }

    // ---------------- A. 补 adb 差集 ----------------

    /**
     * 完整图层树（含嵌套组、bounds、类型）。
     * adb 有类似能力，ps_core 只有零散的层属性访问。
     */
    function listLayers(doc, options) {
        var d = requireDoc(doc);
        var opts = options || {};
        var maxDepth = opts.maxDepth || 8;
        var out = [];

        function walk(container, depth, path) {
            if (depth > maxDepth) return;
            var layers = container.layers, i;
            for (i = 0; i < layers.length && out.length < 2000; i++) {
                var l = layers[i];
                var item = {
                    __plain: 1,   // 告诉序列化层：这是普通对象，别按 DOM 白名单裁字段
                    id: l.id,
                    name: String(l.name),
                    typename: String(l.typename),
                    depth: depth,
                    path: path ? path + '/' + l.name : String(l.name),
                    visible: l.visible,
                    opacity: l.opacity,
                    blendMode: String(l.blendMode)
                };
                if (typeof l.kind !== 'undefined') item.kind = l.kind;
                if (l.typename === 'ArtLayer' && typeof l.kind !== 'undefined') {
                    item.isText = (l.kind === 'textObject');
                    item.isSmartObject = (l.kind === 'smartObject');
                    if (item.isText && l.textItem) item.text = String(l.textItem.contents);
                }
                if (opts.bounds !== false) {
                    try { item.bounds = [px(l.bounds[0]), px(l.bounds[1]), px(l.bounds[2]), px(l.bounds[3])]; } catch (ignored) {}
                }
                out.push(item);
                if (l.typename === 'LayerSet') walk(l, depth + 1, item.path);
            }
        }
        walk(d, 0, '');
        return { document_id: d.id, count: out.length, layers: out };
    }

    /**
     * 批量把每个顶层图层导出为独立 PNG。
     * 返回写出的文件列表。用隐藏/显示切换，不破坏文档结构。
     */
    function exportLayers(dirPath, options) {
        var d = requireDoc(options && options.doc);
        var opts = options || {};
        var folder = Folder(dirPath);
        if (!folder.exists) folder.create();
        var original = [], i;

        // 记录初始可见性，最后恢复
        for (i = 0; i < d.layers.length; i++) original.push(d.layers[i].visible);

        var written = [];
        try {
            for (i = 0; i < d.layers.length; i++) {
                var layer = d.layers[i];
                if (opts.skipBackground && layer.isBackgroundLayer) continue;
                var j;
                for (j = 0; j < d.layers.length; j++) d.layers[j].visible = (j === i);
                var safeName = String(layer.name).replace(new RegExp('[\\\\/:*?"<>|]', 'g'), '_');
                var target = folder.fsName + '/' + ('000' + i).slice(-3) + '_' + safeName + '.png';
                var file = new File(target);
                var png = new PNGSaveOptions();
                d.saveAs(file, png, true, Extension.LOWERCASE);
                written.push(target);
            }
        } finally {
            for (i = 0; i < d.layers.length && i < original.length; i++) d.layers[i].visible = original[i];
        }
        return { document_id: d.id, exported: written.length, files: written };
    }

    /**
     * 置入外部图片为智能对象（adb 的 place_image 等价）。
     * 用 app.open + 复制到目标文档，保留可再编辑的智能对象。
     */
    function placeImage(path, options) {
        var d = requireDoc(options && options.doc);
        var opts = options || {};
        var file = new File(path);
        if (!file.exists) throw new Error('文件不存在：' + path);

        var source = app.open(file);
        var sourceName = source.name;
        try {
            // duplicate 到目标文档，返回新图层
            var layer = source.activeLayer.duplicate(d, ElementPlacement.PLACEATBEGINNING);
            if (opts.name) layer.name = opts.name;
            if (opts.x !== undefined || opts.y !== undefined) {
                layer.translate(UnitValue(opts.x || 0, 'px'), UnitValue(opts.y || 0, 'px'));
            }
            return { document_id: d.id, layer_id: layer.id, layer_name: String(layer.name), source: sourceName };
        } finally {
            try {
                source.close(SaveOptions.DONOTSAVECHANGES);
            } catch (ignored) {
                // PS 27：关闭「非最前」文档会抛**不可捕获**的运行时错误，
                // 本次尝试过的三种规避（切活动文档 / ActionManager 'Cls ' / 按 id 重解析再关）
                // 全部无效，因此这里只能吞掉异常，让调用方至少拿到置入结果。
            }
        }
    }

    /**
     * 改已有文字层的文案/字号/字体（adb 的 update_text 等价）。
     * ps_core 只支持新建文字。
     */
    function updateText(cfg) {
        var d = requireDoc(cfg && cfg.doc);
        var layer = null, i;
        for (i = 0; i < d.artLayers.length; i++) {
            if (cfg.layer_id !== undefined && d.artLayers[i].id === cfg.layer_id) { layer = d.artLayers[i]; break; }
        }
        if (!layer) throw new Error('找不到 layer_id=' + cfg.layer_id);
        if (layer.kind !== LayerKind.TEXT) throw new Error('目标图层不是文字层');

        if (cfg.contents !== undefined) layer.textItem.contents = String(cfg.contents);
        if (cfg.size !== undefined) layer.textItem.size = UnitValue(cfg.size, 'pt');
        if (cfg.font !== undefined) layer.textItem.font = String(cfg.font);
        if (cfg.tracking !== undefined) layer.textItem.tracking = Number(cfg.tracking);
        return { layer_id: layer.id, contents: String(layer.textItem.contents) };
    }

    // ---------------- B. 官方 MCP 语义 ----------------

    /**
     * 自动色调（等价官方 image_apply_auto_tone）。
     * 走 PS 原生 autoLevels / autoContrast 事件，不依赖 Camera Raw。
     */
    function autoTone(options) {
        var opts = options || {};
        var desc = new ActionDescriptor();
        var mode = opts.mode === 'contrast' ? 'autoContrastEvent' : 'autoLevelsEvent';
        executeAction(s2t(mode), desc, DialogModes.NO);
        return { applied: mode };
    }

    /**
     * 镜头模糊（等价官方 image_apply_lens_blur）。
     * radius 为像素模糊半径；source 对应景深源。
     */
    function lensBlur(cfg) {
        var d = requireDoc(cfg && cfg.doc);
        var c = cfg || {};
        var radius = Number(c.radius) || 6;
        // 层类型守卫：模糊类操作打在文字/形状/智能对象上会弹「必须栅格化」并冻结实例。
        var tl = (c.layer_id !== undefined && c.layer_id !== null)
            ? findLayer(d, Number(c.layer_id))
            : d.activeLayer;
        if (!tl) throw new Error('没有可作用的图层');
        d.activeLayer = tl;
        var tKind = (tl.kind && tl.kind.typename) ? String(tl.kind.typename) : '';
        if (tKind && tKind !== 'LayerKind.NORMAL') {
            throw new Error('镜头模糊只能作用在像素层，当前层类型是 ' + tKind +
                '。请先栅格化 / 转换为智能对象后再试，或改用 layer.smart_object。');
        }
        // PS 27 行为：executeAction('lensBlur') 报 8800「命令<未知的>当前不可用」，
        // 该动作在当前版本不可达。先试动作，不行则退回 DOM 的高斯模糊并如实标注。
        try {
            var desc = new ActionDescriptor();
            desc.putUnitDouble(s2t('radius'), s2t('pixelsUnit'), radius);
            if (c.focal !== undefined) desc.putInteger(s2t('focalDistance'), Number(c.focal));
            if (c.bladeCurvature !== undefined) desc.putInteger(s2t('bladeCurvature'), Number(c.bladeCurvature));
            executeAction(s2t('lensBlur'), desc, DialogModes.NO);
            return { document_id: d.id, radius: radius, via: 'lensBlur-action' };
        } catch (ignoredAction) {
            var ly = d.activeLayer;
            if (!ly) throw new Error('没有可作用的图层');
            ly.applyGaussianBlur(radius);
            return {
                document_id: d.id,
                radius: radius,
                via: 'gaussian-fallback',
                warning: 'PS 27 不支持镜头模糊动作（8800），已用等半径高斯模糊近似：模糊结果相似但没有景深/焦点控制。'
            };
        }
    }

    /**
     * 裁剪到目标比例并缩放到指定像素（等价官方 image_crop_and_resize）。
     * 先按目标宽高比居中裁剪，再 resizeImage，一步到位。
     */
    function cropAndResize(cfg) {
        var d = requireDoc(cfg && cfg.doc);
        var c = cfg || {};
        var targetW = Number(c.width), targetH = Number(c.height);
        if (!targetW || !targetH) throw new Error('需要 width 与 height');

        var curW = px(d.width), curH = px(d.height);
        var targetRatio = targetW / targetH;
        var curRatio = curW / curH;
        var cropW = curW, cropH = curH;

        if (curRatio > targetRatio) cropW = Math.round(curH * targetRatio);
        else cropH = Math.round(curW / targetRatio);

        if (cropW !== curW || cropH !== curH) {
            var left = Math.round((curW - cropW) / 2), top = Math.round((curH - cropH) / 2);
            var bounds = [[left, top], [left + cropW, top], [left + cropW, top + cropH], [left, top + cropH]];
            d.crop(bounds);
        }
        d.resizeImage(UnitValue(targetW, 'px'), UnitValue(targetH, 'px'), null, ResampleMethod.BICUBIC);
        return { document_id: d.id, width: targetW, height: targetH, cropped: [cropW, cropH] };
    }

    /**
     * 一批调整合并成一次调用（等价官方 image_apply_adjustments）。
     * 官方是「一次请求里跑多个调整」，本实现按顺序叠调整层，
     * 好处是每个调整仍是可单独回调的图层。
     */
    function applyAdjustments(list, options) {
        var opts = options || {};
        var items = list || [];
        var applied = [], i;
        for (i = 0; i < items.length; i++) {
            var it = items[i];
            var kind = it.kind || it.type;
            var cfg = it.params || it;
            if (kind === 'brightness') applied.push(PS.adjustment.brightnessContrast(cfg));
            else if (kind === 'levels') applied.push(PS.adjustment.levels(cfg));
            else if (kind === 'curves') applied.push(PS.adjustment.curves(cfg));
            else if (kind === 'hueSaturation' || kind === 'hsl') applied.push(PS.adjustment.hueSaturation(cfg));
            else if (kind === 'vibrance') applied.push(PS.adjustment.vibrance(cfg));
            else if (kind === 'colorBalance') applied.push(PS.adjustment.colorBalance(cfg));
            else if (kind === 'blackWhite') applied.push(PS.adjustment.blackWhite(cfg));
            else throw new Error('不支持的调整类型：' + kind);
        }
        return { applied: applied.length, types: items.length };
    }

    // ---------------- C. 图层结构操作（ps_core 完全没有） ----------------
    //
    // ps_core 只有「建层 / 上色 / 文字 / 形状」，没有任何「移动、合并、编组、删除、
    // 排序」——而这恰好是真实编辑里最高频的一类。DOM 没有对应方法（merge 只在
    // Document 上，且只能合并选中层），所以这一组必须走 ActionManager。

    function findLayer(doc, id) {
        var found = null;
        function walk(container) {
            if (found) return;
            var layers = container.layers, i;
            for (i = 0; i < layers.length; i++) {
                if (found) return;
                if (layers[i].id === id) { found = layers[i]; return; }
                if (layers[i].typename === 'LayerSet') walk(layers[i]);
            }
        }
        walk(doc);
        if (!found) throw new Error('找不到 layer_id=' + id);
        return found;
    }

    function selectLayer(id) {
        var ref = new ActionReference();
        ref.putIdentifier(c2t('Lyr '), Number(id));
        var desc = new ActionDescriptor();
        desc.putReference(c2t('null'), ref);
        var inner = new ActionDescriptor();
        inner.putBoolean(c2t('MkVs'), false);
        desc.putObject(c2t('T   '), c2t('Lyr '), inner);
        executeAction(c2t('slct'), desc, DialogModes.NO);
    }

    /** 合并当前层与下一层（PS 的「向下合并」）。 */
    function mergeDown(cfg) {
        var d = requireDoc(cfg && cfg.doc);
        if (cfg && cfg.layer_id !== undefined) selectLayer(cfg.layer_id);
        var desc = new ActionDescriptor();
        var ref = new ActionReference();
        ref.putEnumerated(c2t('Lyr '), c2t('Ordn'), c2t('Trgt'));
        desc.putReference(c2t('null'), ref);
        executeAction(c2t('MrgL'), desc, DialogModes.NO);
        return { document_id: d.id, layers: d.layers.length };
    }

    /** 拼合全部图层（会丢图层结构，调用前建议先存盘）。 */
    function flatten(cfg) {
        var d = requireDoc(cfg && cfg.doc);
        executeAction(c2t('FltI'), new ActionDescriptor(), DialogModes.NO);
        return { document_id: d.id, layers: d.layers.length };
    }

    /** 复制图层，可选重命名。PS 27 行为：Dplc 不接受 putIdentifier 指定层，
     *  必须「先选中 → 对 targetEnum 操作」。 */
    function duplicateLayer(cfg) {
        var d = requireDoc(cfg && cfg.doc);
        var c = cfg || {};
        selectLayer(Number(c.layer_id));
        var desc = new ActionDescriptor();
        var ref = new ActionReference();
        ref.putEnumerated(c2t('Lyr '), c2t('Ordn'), c2t('Trgt'));
        desc.putReference(c2t('null'), ref);
        executeAction(c2t('Dplc'), desc, DialogModes.NO);
        var created = d.activeLayer;
        if (c.name !== undefined && created) created.name = String(c.name);
        return { document_id: d.id, layer_id: created ? created.id : null, layers: d.layers.length };
    }

    /** 删除图层（按 id）。PS 27 的 DltL 动作不可用，改走 DOM 的 layer.remove()。 */
    function deleteLayer(cfg) {
        var d = requireDoc(cfg && cfg.doc);
        var c = cfg || {};
        var ly = findLayer(d, Number(c.layer_id));
        var name = String(ly.name);
        ly.remove();
        return { document_id: d.id, layers: d.layers.length, removed: name };
    }

    /** 把多个图层编成一组。PS 27 的 GrpL 动作会报「创建剪贴蒙版当前不可用」，
     *  改用 DOM：建图层组再把层逐个移进去。 */
    function groupLayers(cfg) {
        var d = requireDoc(cfg && cfg.doc);
        var c = cfg || {};
        var ids = c.layer_ids || [];
        if (!ids.length) throw new Error('需要 layer_ids');
        var group = d.layerSets.add();
        if (c.name !== undefined) group.name = String(c.name);
        var i, ly;
        for (i = 0; i < ids.length; i++) {
            ly = findLayer(d, Number(ids[i]));
            if (ly) ly.move(group, ElementPlacement.INSIDE);
        }
        return { document_id: d.id, layer_id: group.id, layers: d.layers.length, grouped: ids.length };
    }

    /** 解散组（把组内图层提到上一层）。 */
    function ungroup(cfg) {
        var d = requireDoc(cfg && cfg.doc);
        if (cfg && cfg.layer_id !== undefined) selectLayer(cfg.layer_id);
        executeAction(c2t('Ungr'), new ActionDescriptor(), DialogModes.NO);
        return { document_id: d.id, layers: d.layers.length };
    }

    /** 改图层属性：改名 / 不透明度 / 混合模式 / 可见性。走 DOM，比描述符稳。 */
    function setLayerProps(cfg) {
        var d = requireDoc(cfg && cfg.doc);
        var c = cfg || {};
        var layer = findLayer(d, Number(c.layer_id));
        var changed = [];
        if (c.name !== undefined) { layer.name = String(c.name); changed.push('name'); }
        if (c.opacity !== undefined) { layer.opacity = Number(c.opacity); changed.push('opacity'); }
        if (c.blend_mode !== undefined) { layer.blendMode = String(c.blend_mode); changed.push('blendMode'); }
        if (c.visible !== undefined) { layer.visible = !!c.visible; changed.push('visible'); }
        if (!changed.length) throw new Error('没有给出要改的属性（name/opacity/blend_mode/visible）');
        return { document_id: d.id, layer_id: layer.id, changed: changed };
    }

    /** 调整图层堆叠顺序。place: forward | backward | front | back */
    function moveLayer(cfg) {
        var d = requireDoc(cfg && cfg.doc);
        var c = cfg || {};
        var place = 'Frwr';
        if (c.position === 'backward') place = 'Bckw';
        else if (c.position === 'front') place = 'Frnt';
        else if (c.position === 'back') place = 'Back';

        var desc = new ActionDescriptor();
        var ref = new ActionReference();
        ref.putIdentifier(c2t('Lyr '), Number(c.layer_id));
        desc.putReference(c2t('null'), ref);
        var to = new ActionReference();
        to.putEnumerated(c2t('Lyr '), c2t('Ordn'), c2t(place));
        desc.putReference(c2t('T   '), to);
        executeAction(c2t('move'), desc, DialogModes.NO);
        return { document_id: d.id, layer_id: Number(c.layer_id), position: c.position || 'forward' };
    }

    // ---------------- D. 需要 DOM 对象的包装 ----------------
    //
    // ps_core 里 PS.mask.* / PS.text.set* 的第一个参数是 Layer 对象，
    // 而工具层只有 layer_id。这一组负责把 id 换成对象再转调，避免让
    // agent 关心 DOM 引用。

    /** 蒙版操作：from_selection | add | hide | invert */
    function maskOp(cfg) {
        var d = requireDoc(cfg && cfg.doc);
        var c = cfg || {};
        var layer = findLayer(d, Number(c.layer_id));
        var op = c.op || 'from_selection';
        if (op === 'from_selection') PS.mask.fromSelection(layer);
        else if (op === 'add') PS.mask.add(layer);
        else if (op === 'hide') PS.mask.hide(layer);
        else if (op === 'invert') PS.mask.invert(layer);
        else throw new Error('不支持的蒙版操作：' + op);
        return { document_id: d.id, layer_id: layer.id, op: op };
    }

    /** 文字样式：行距 / 字距 / 水平垂直缩放 / 基线偏移。全部可选。 */
    function textStyle(cfg) {
        var d = requireDoc(cfg && cfg.doc);
        var c = cfg || {};
        var layer = findLayer(d, Number(c.layer_id));
        if (layer.kind !== LayerKind.TEXT) throw new Error('目标图层不是文字层');
        var changed = [];
        if (c.leading !== undefined) { PS.text.setLeading(layer, Number(c.leading)); changed.push('leading'); }
        if (c.tracking !== undefined) { PS.text.setTracking(layer, Number(c.tracking)); changed.push('tracking'); }
        if (c.scale_h !== undefined || c.scale_v !== undefined) {
            PS.text.setScale(layer, Number(c.scale_h !== undefined ? c.scale_h : 100), Number(c.scale_v !== undefined ? c.scale_v : 100));
            changed.push('scale');
        }
        if (c.baseline_shift !== undefined) { PS.text.setBaselineShift(layer, Number(c.baseline_shift)); changed.push('baselineShift'); }
        if (!changed.length) throw new Error('没有给出要改的样式（leading/tracking/scale_h/scale_v/baseline_shift）');
        return { document_id: d.id, layer_id: layer.id, changed: changed };
    }

    /**
     * 建形状并按目标矩形定位。
     * ps_core 的 PS.shape.* 只能建「默认尺寸」的形状，不能指定位置；
     * 这里补上 resize + translate，让 l/t/r/b 真正生效。
     */
    function addShape(cfg) {
        var d = requireDoc(cfg && cfg.doc);
        var c = cfg || {};
        var kind = c.kind || 'rectangle';
        var color = c.color || [255, 0, 0];
        var shapeCfg = { color: color, name: c.name || kind };

        var targetW = (c.r !== undefined && c.l !== undefined) ? (Number(c.r) - Number(c.l)) : null;
        var targetH = (c.b !== undefined && c.t !== undefined) ? (Number(c.b) - Number(c.t)) : null;

        // PS 27 行为：直接 _makeShape 建出的纯色内容层**没有几何**（定界矩形为空），
        // 之后 resize 必弹「不能完成命令，因为最初的定界矩形是空的」并冻结实例。
        // 可靠做法：先建立矩形选区，再建纯色内容层 —— PS 会用选区几何作为形状几何。
        var hadSel = false;
        try { hadSel = hasActiveSelection(d); } catch (ignoredHad) { hadSel = false; }
        if (targetW && targetH) {
            PS.selection.selectRect(Number(c.l), Number(c.t), Number(c.r), Number(c.b), 0);
        }

        var layer;
        if (kind === 'ellipse') layer = PS.shape.ellipse(shapeCfg);
        else if (kind === 'line') layer = PS.shape.line(shapeCfg);
        else if (kind === 'polygon') layer = PS.shape.polygon(shapeCfg);
        else if (kind === 'rounded_rect') layer = PS.shape.roundedRect(shapeCfg);
        else layer = PS.shape.rectangle(shapeCfg);

        if (targetW && targetH && !hadSel) {
            try { d.selection.deselect(); } catch (ignoredDesel) {}
        }

        // 兜底：若形状仍无几何，用 resize+translate 校正（几何为空时不再尝试，避免拉模态）。
        if (targetW && targetH) {
            var b = layer.bounds;
            var curW = px(b[2]) - px(b[0]);
            var curH = px(b[3]) - px(b[1]);
            if (curW > 0 && curH > 0 && (Math.abs(curW - targetW) > 1 || Math.abs(curH - targetH) > 1)) {
                layer.resize(UnitValue(targetW / curW * 100, 'percent'), UnitValue(targetH / curH * 100, 'percent'), AnchorPosition.MIDDLECENTER);
                var nb = layer.bounds;
                var dx = Number(c.l) - px(nb[0]);
                var dy = Number(c.t) - px(nb[1]);
                if (dx || dy) layer.translate(UnitValue(dx, 'px'), UnitValue(dy, 'px'));
            } else if (curW > 0 && curH > 0) {
                var mb = layer.bounds;
                var mdx = Number(c.l) - px(mb[0]);
                var mdy = Number(c.t) - px(mb[1]);
                if (mdx || mdy) layer.translate(UnitValue(mdx, 'px'), UnitValue(mdy, 'px'));
            }
        }
        var fb = layer.bounds;
        return {
            document_id: d.id,
            layer_id: layer.id,
            kind: kind,
            name: String(layer.name),
            bounds: [px(fb[0]), px(fb[1]), px(fb[2]), px(fb[3])]
        };
    }

    // ---------------- E. adb 差集（二）：选区 / 剪贴板 / 对齐 / 字体 / 预览 ----------------
    //
    // 这批增量对应 adb_uxp_src 里 ps-agent 尚未覆盖的命令：
    //   select_sky / remove_background / select_polygon / delete_selection /
    //   copy / copy_merged / cut / paste / align_content / 字体枚举 / get_layer_image
    // 剪贴板与选区操作依赖真实 PS 的选区状态，统一标 needs:"ps"（font.list 除外）。

    /** 当前层是否已有活动选区（selection.bounds 非空，PS 无选区时访问会抛异常）。*/
    function hasActiveSelection(doc) {
        var d = doc || app.activeDocument;
        if (!d || !d.selection) return false;
        try {
            return !!(d.selection.bounds);
        } catch (ignored) {
            return false;
        }
    }

    /** 选择天空（adb select_sky）：先选中图层，再执行 AM selectSky。*/
    function selSky(cfg) {
        var d = requireDoc(cfg && cfg.doc);
        var c = cfg || {};
        if (c.layer_id === undefined) throw new Error('需要 layer_id');
        selectLayer(c.layer_id);
        var desc = new ActionDescriptor();
        desc.putBoolean(s2t('sampleAllLayers'), false);
        executeAction(s2t('selectSky'), desc, DialogModes.NO);
        return { document_id: d.id, layer_id: Number(c.layer_id) };
    }

    /** 移除背景（adb remove_background）：选中主体 → 反选 → 清空选区内容。*/
    function removeBackground(cfg) {
        var d = requireDoc(cfg && cfg.doc);
        var c = cfg || {};
        if (c.layer_id === undefined) throw new Error('需要 layer_id');
        var ly = findLayer(d, Number(c.layer_id));
        var kindName = (ly.kind && ly.kind.typename) ? String(ly.kind.typename) : '';
        if (kindName && kindName !== 'LayerKind.NORMAL') {
            throw new Error('去背景只支持像素层，当前层类型是 ' + kindName +
                '。请先栅格化或复制为普通像素层后再试。');
        }
        d.activeLayer = ly;
        var selOk = false;
        try { selOk = PS.selection.selectSubject(); } catch (ignoredSel) { selOk = false; }
        if (!selOk) {
            throw new Error('PS 未能自动识别主体（本机 PS 的选择主体 / autoCutout 不可用）。' +
                '请改用 sel.rect / sel.polygon / sel.color_range 手工建选区，再用 mask.from_selection 或 sel.delete。');
        }
        PS.selection.inverse();
        d.selection.clear();
        return { document_id: d.id, layer_id: Number(c.layer_id), removed: true };
    }

    /**
     * 多边形选区（adb select_polygon）。ExtendScript 的 Selection 没有 selectPolygon，
     * 直接调用 Selection.select(顶点数组) 建立多边形选区：避免 Document.pathItems.add
     * 在真机触发 PS 原生"存储路径"模态框阻塞脚本；返回前用 selection.bounds 验证
     * 选区已建立并回传实际边界。
     */
    function selPolygon(cfg) {
        var d = requireDoc(cfg && cfg.doc);
        var c = cfg || {};
        if (c.layer_id === undefined) throw new Error('需要 layer_id');
        if (!c.points || !c.points.length) throw new Error('需要 points:[{x,y},...]');
        selectLayer(c.layer_id);
        var pts = [], i;
        for (i = 0; i < c.points.length; i++) {
            var x = Number(c.points[i].x), y = Number(c.points[i].y);
            if (x > d.width.as('px') || y > d.height.as('px')) throw new Error('多边形顶点超出画布范围');
            pts.push([x, y]);
        }
        var feather = c.feather !== undefined ? Number(c.feather) : 0;
        var antiAlias = c.antiAlias !== undefined ? !!c.antiAlias : true;
        // PS 27 真机：DOM Selection.select(region) 静默失效（不抛错但选区为空），
        // 改走 工作路径(PathItems.add) + makeSelection 建立多边形选区（PathItems.add 不弹存储路径框）。
        // 踩坑记录：PathPointInfo.kind 须用数字 0（PointKind.CORNER 报无效枚举值）；
        // SubPathInfo.operation 须用 ShapeOperation.SHAPEADD（数字报应为枚举值）；
        // makeSelection 签名 (feather, antiAlias, operation)，勿把 SelectionType 放首位。
        var pathItem = null;
        try {
            for (var pi = d.pathItems.length - 1; pi >= 0; pi--) {
                if (d.pathItems[pi].name === '__selPoly') { try { d.pathItems[pi].remove(); } catch (e) {} }
            }
            var subPath = [];
            for (i = 0; i < pts.length; i++) {
                var pp = new PathPointInfo();
                pp.anchor = [pts[i][0], pts[i][1]];
                pp.leftDirection = pp.anchor;
                pp.rightDirection = pp.anchor;
                pp.kind = 0; // PointKind.CORNER 在 PS 27 报无效枚举值，用数字 0 替代
                subPath.push(pp);
            }
            var spInfo = new SubPathInfo();
            spInfo.closed = true;
            spInfo.entireSubPath = subPath;
            spInfo.operation = ShapeOperation.SHAPEADD;
            pathItem = d.pathItems.add('__selPoly', [spInfo]);
            pathItem.makeSelection(feather, antiAlias, SelectionType.REPLACE);
        } finally {
            if (pathItem) { try { pathItem.remove(); } catch (e) {} }
        }
        var b = app.activeDocument.selection.bounds;
        return { document_id: d.id, layer_id: Number(c.layer_id), points: c.points.length,
            bounds: { x: px(b[0]), y: px(b[1]), width: px(b[2]) - px(b[0]), height: px(b[3]) - px(b[1]) } };
    }

    /** 删除选区内容（adb delete_selection）：无选区时报错。*/
    function selDelete(cfg) {
        var d = requireDoc(cfg && cfg.doc);
        var c = cfg || {};
        if (c.layer_id !== undefined) selectLayer(c.layer_id);
        if (!hasActiveSelection(d)) throw new Error('没有活动的选区');
        d.selection.clear();
        return { document_id: d.id, layer_id: c.layer_id !== undefined ? Number(c.layer_id) : null };
    }

    /** 复制选区内容到剪贴板（adb copy，copyEvent + pixels）。*/
    function copySelection(cfg) {
        var d = requireDoc(cfg && cfg.doc);
        var c = cfg || {};
        if (c.layer_id !== undefined) selectLayer(c.layer_id);
        if (!hasActiveSelection(d)) throw new Error('没有活动的选区');
        d.selection.copy();
        return { document_id: d.id, layer_id: c.layer_id !== undefined ? Number(c.layer_id) : null };
    }

    /** 合并复制选区内容（adb copy_merged，AM copyMerged）。*/
    function copyMergedSelection(cfg) {
        var d = requireDoc(cfg && cfg.doc);
        if (!hasActiveSelection(d)) throw new Error('没有活动的选区');
        executeAction(s2t('copyMerged'), new ActionDescriptor(), DialogModes.NO);
        return { document_id: d.id };
    }

    /** 剪切选区内容到剪贴板（adb cut）。*/
    function cutSelection(cfg) {
        var d = requireDoc(cfg && cfg.doc);
        var c = cfg || {};
        if (c.layer_id !== undefined) selectLayer(c.layer_id);
        if (!hasActiveSelection(d)) throw new Error('没有活动的选区');
        d.selection.cut();
        return { document_id: d.id, layer_id: c.layer_id !== undefined ? Number(c.layer_id) : null };
    }

    /** 粘贴剪贴板内容（adb paste）；paste_in_place 为 true 时走 AM paste 的 inPlace。*/
    function pasteClipboard(cfg) {
        var d = requireDoc(cfg && cfg.doc);
        var c = cfg || {};
        if (c.layer_id !== undefined) selectLayer(c.layer_id);
        var inPlace = !!(c.paste_in_place);
        if (inPlace) {
            var desc = new ActionDescriptor();
            desc.putEnumerated(s2t('antiAlias'), s2t('antiAliasType'), s2t('antiAliasNone'));
            desc.putClass(s2t('as'), s2t('pixel'));
            desc.putBoolean(s2t('inPlace'), true);
            executeAction(s2t('paste'), desc, DialogModes.NO);
        } else {
            d.paste();
        }
        return { document_id: d.id, pasted: true, in_place: inPlace };
    }

    /** 对齐当前图层（adb align_content）：mode 为 LEFT/CENTER_HORIZONTAL/RIGHT/TOP/CENTER_VERTICAL/BOTTOM。*/
    function alignContent(cfg) {
        var d = requireDoc(cfg && cfg.doc);
        var c = cfg || {};
        if (c.layer_id === undefined) throw new Error('需要 layer_id');
        var mode = String(c.mode === undefined ? '' : c.mode);
        // PS 27 的 'align' 动作报「命令对齐当前不可用」（即使只对一个层）。
        // 改为按画布尺寸直接算位移再 translate —— 语义等价且不依赖动作描述符。
        var ly = findLayer(d, Number(c.layer_id));
        d.activeLayer = ly;
        var b = ly.bounds;
        var left = px(b[0]), top = px(b[1]), right = px(b[2]), bottom = px(b[3]);
        var W = Number(d.width.as ? d.width.as('px') : d.width);
        var H = Number(d.height.as ? d.height.as('px') : d.height);
        var dx = 0, dy = 0;
        if (mode === 'LEFT') dx = -left;
        else if (mode === 'CENTER_HORIZONTAL') dx = (W - (right + left)) / 2;
        else if (mode === 'RIGHT') dx = W - right;
        else if (mode === 'TOP') dy = -top;
        else if (mode === 'CENTER_VERTICAL') dy = (H - (bottom + top)) / 2;
        else if (mode === 'BOTTOM') dy = H - bottom;
        else throw new Error('未知的对齐模式：' + mode);
        if (dx || dy) ly.translate(UnitValue(dx, 'px'), UnitValue(dy, 'px'));
        return { document_id: d.id, layer_id: Number(c.layer_id), mode: mode, dx: dx, dy: dy };
    }

    /** 字体枚举（adb 字体列表）：返回 app.fonts 的 postScriptName 数组。*/
    function fontList() {
        var fonts = app.fonts || [];
        var out = [], i;
        for (i = 0; i < fonts.length; i++) {
            var f = fonts[i];
            out.push(String(f && f.postScriptName ? f.postScriptName : (f && f.name !== undefined ? f.name : String(f))));
        }
        return { count: out.length, fonts: out };
    }

    /**
     * 导出指定图层 PNG 预览（adb get_layer_image，ps-agent 惯例返回文件路径而非 base64）。
     * 复制该图层到临时文档 → 存 PNG → 关闭临时文档。
     */
    function layerPreview(cfg) {
        var d = requireDoc(cfg && cfg.doc);
        var c = cfg || {};
        if (c.layer_id === undefined) throw new Error('需要 layer_id');
        if (!c.dir) throw new Error('需要 dir（输出目录）');
        var layer = findLayer(d, Number(c.layer_id));
        var ms = String(d.mode), cm = NewDocumentMode.RGB;
        if (ms.indexOf('CMYK') >= 0) cm = NewDocumentMode.CMYK;
        else if (ms.indexOf('GRAY') >= 0) cm = NewDocumentMode.GRAYSCALE;
        else if (ms.indexOf('BITMAP') >= 0) cm = NewDocumentMode.BITMAP;
        else if (ms.indexOf('LAB') >= 0) cm = NewDocumentMode.LAB;
        else if (ms.indexOf('DUOTONE') >= 0) cm = NewDocumentMode.DUOTONE;
        else if (ms.indexOf('INDEXED') >= 0) cm = NewDocumentMode.INDEXEDCOLOR;
        else if (ms.indexOf('MULTI') >= 0) cm = NewDocumentMode.MULTICHANNEL;
        var tmpDoc = app.documents.add(d.width, d.height, d.resolution, 'preview_tmp', cm, DocumentFill.WHITE);
        app.activeDocument = d;
        var dup = layer.duplicate(tmpDoc, ElementPlacement.PLACEATBEGINNING);
        app.activeDocument = tmpDoc;
        dup.visible = true;
        var bottom = tmpDoc.layers[tmpDoc.layers.length - 1];
        if (bottom && bottom.isBackgroundLayer) bottom.visible = false;
        var folder = Folder(c.dir);
        if (!folder.exists) folder.create();
        var safeName = String(layer.name).replace(new RegExp('[\\\\/:*?"<>|]', 'g'), '_');
        var target = folder.fsName + '/' + safeName + '_' + Number(c.layer_id) + '.png';
        var file = new File(target);
        var png = new PNGSaveOptions();
        tmpDoc.saveAs(file, png, true, Extension.LOWERCASE);
        tmpDoc.close(SaveOptions.DONOTSAVECHANGES);
        app.activeDocument = d;
        return { document_id: d.id, layer_id: Number(c.layer_id), file: target };
    }

    /** 关闭文档（不保存），供清理临时文档使用。*/
    function docClose(cfg) {
        var d = requireDoc(cfg && cfg.doc);
        var save = cfg && cfg.save ? SaveOptions.SAVECHANGES : SaveOptions.DONOTSAVECHANGES;
        d.close(save);
        return { closed: true };
    }

    /** 把 '#rrggbb' / '#rgb' / [r,g,b] / 'r,g,b' 统一成 [r,g,b]。ES3，勿用新语法。 */
    function normalizeColor(v) {
        if (v === undefined || v === null) return undefined;
        if (typeof v === 'object' && typeof v.length === 'number') {
            return [Number(v[0]), Number(v[1]), Number(v[2])];
        }
        if (typeof v === 'string') {
            var s = v.replace(/\s/g, '');
            if (s.charAt(0) === '#') {
                var h = s.substring(1);
                if (h.length === 3) {
                    h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
                }
                return [
                    parseInt(h.substring(0, 2), 16),
                    parseInt(h.substring(2, 4), 16),
                    parseInt(h.substring(4, 6), 16)
                ];
            }
            var parts = s.split(',');
            if (parts.length >= 3) {
                return [parseInt(parts[0], 10), parseInt(parts[1], 10), parseInt(parts[2], 10)];
            }
        }
        return undefined;
    }

    /**
     * 图层样式统一入口。处理两个已知问题：
     *  1) layer_id 被忽略（原来直接调 PS.layerStyle.xxx，它只作用于 activeLayer）⇒ 先按 id 定位并设为活动层；
     *  2) color 传 '#rrggbb' 时被当成数组取 [0][1][2] 得到 '#'/'f'/'f' ⇒ 报 1243 ⇒ 统一规范化成 [r,g,b]。
     */
    function styleFx(kind, cfg) {
        var a = cfg || {};
        var d = requireDoc(a.doc);
        var layer = (a.layer_id !== undefined && a.layer_id !== null)
            ? findLayer(d, a.layer_id)
            : d.activeLayer;
        if (!layer) throw new Error('没有可作用的图层');
        d.activeLayer = layer;

        if (kind === 'clearAll') {
            PS.layerStyle.clearAll();
            return d.activeLayer;
        }
        var fn = PS.layerStyle[kind];
        if (!fn) throw new Error('未知图层样式 kind=' + kind);

        fn({
            color: normalizeColor(a.color),
            opacity: a.opacity,
            size: a.size,
            spread: a.spread,
            choke: a.choke,
            distance: a.distance,
            angle: a.angle,
            position: a.position,
            depth: a.depth,
            direction: a.direction,
            useGlobalLight: a.useGlobalLight,
            blend_mode: a.blend_mode
        });
        return d.activeLayer;
    }

    /**
     * 选区填充。处理已知问题：catalog 传 '#rrggbb' 字符串，而 PS.selection.fill 要
     * SolidColor 对象 —— 直接传字符串报「错误 1220 非法参数」。
     */
    function fillSelection(cfg) {
        var a = cfg || {};
        var d = requireDoc(a.doc);
        var rgb = normalizeColor(a.color);
        if (!rgb) throw new Error('sel.fill 需要合法颜色："#rrggbb" / [r,g,b] / "r,g,b"');
        var c = new SolidColor();
        c.rgb.red = rgb[0];
        c.rgb.green = rgb[1];
        c.rgb.blue = rgb[2];
        // 不用 selection.fill(...)：它会拉起模态并返回「错误 8007 用户取消了操作」。
        // 改走 ActionManager 填充（DialogModes.NO，无模态）。
        app.foregroundColor = c;
        var fd = new ActionDescriptor();
        fd.putEnumerated(c2t('Usng'), c2t('FlCn'), c2t('FrgC'));
        executeAction(c2t('Fl  '), fd, DialogModes.NO);
        return { document_id: d.id, filled: true, color: [rgb[0], rgb[1], rgb[2]] };
    }

    /**
     * 图层自由变换。处理两个已知问题：
     *  1) 原来直接调 PS.transform.layer（作用于 activeLayer），layer_id 不生效；
     *  2) 活动层为背景层/锁定层时报「命令"变换"当前不可用」（错误 8800），
     *     属于 PS 原生拒绝 —— 这里先判定并给出可读错误，不让调用悬在弹窗上。
     */
    function transformLayer(cfg) {
        var a = cfg || {};
        var d = requireDoc(a.doc);
        var layer = (a.layer_id !== undefined && a.layer_id !== null)
            ? findLayer(d, a.layer_id)
            : d.activeLayer;
        if (!layer) throw new Error('没有可变换的图层');
        if (layer.isBackgroundLayer || layer.allLocked) {
            throw new Error('目标层是背景层或已锁定，PS 不允许变换。请先复制为普通层（layer.duplicate）或解锁后再试。');
        }
        d.activeLayer = layer;
        // 不用 ActionManager 的 'Trnf'：PS 27 上会被拒（8800 命令"变换"当前不可用），
        // 与图层是否锁定无关。改用 DOM 的 resize / rotate，行为等价且不依赖动作描述符。
        if (a.widthPct !== undefined || a.heightPct !== undefined) {
            var wp = a.widthPct !== undefined ? a.widthPct : 100;
            var hp = a.heightPct !== undefined ? a.heightPct : 100;
            layer.resize(Number(wp), Number(hp));
        }
        if (a.angle !== undefined) {
            layer.rotate(Number(a.angle));
        }
        return { document_id: d.id, layer_id: layer.id, name: layer.name };
    }

    return {
        listLayers: listLayers,
        exportLayers: exportLayers,
        placeImage: placeImage,
        updateText: updateText,
        autoTone: autoTone,
        lensBlur: lensBlur,
        cropAndResize: cropAndResize,
        applyAdjustments: applyAdjustments,
        findLayer: findLayer,
        mergeDown: mergeDown,
        flatten: flatten,
        duplicateLayer: duplicateLayer,
        deleteLayer: deleteLayer,
        groupLayers: groupLayers,
        ungroup: ungroup,
        setLayerProps: setLayerProps,
        moveLayer: moveLayer,
        maskOp: maskOp,
        textStyle: textStyle,
        addShape: addShape,
        selSky: selSky,
        removeBackground: removeBackground,
        selPolygon: selPolygon,
        selDelete: selDelete,
        copySelection: copySelection,
        copyMergedSelection: copyMergedSelection,
        cutSelection: cutSelection,
        pasteClipboard: pasteClipboard,
        alignContent: alignContent,
        fontList: fontList,
        layerPreview: layerPreview,
        docClose: docClose,
        styleFx: styleFx,
        fillSelection: fillSelection,
        transformLayer: transformLayer
    };
}());
