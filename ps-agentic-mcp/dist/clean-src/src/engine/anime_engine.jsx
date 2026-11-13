/* Photoshop ExtendScript / ECMAScript 3. Loaded only by our local COM worker. */
(function () {
    function quote(s) {
        return '"' + String(s).replace(/[\\"\x00-\x1f\u2028\u2029]/g, function (c) {
            var map = { '"': '\\"', '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t' };
            if (map[c]) return map[c];
            return '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4);
        }) + '"';
    }
    function stringify(v) {
        if (v === null || typeof v === 'undefined') return 'null';
        if (typeof v === 'string') return quote(v);
        if (typeof v === 'number' || typeof v === 'boolean') return String(v);
        var out = [], k;
        if (v instanceof Array) {
            for (k = 0; k < v.length; k++) out.push(stringify(v[k]));
            return '[' + out.join(',') + ']';
        }
        for (k in v) if (v.hasOwnProperty(k)) out.push(quote(k) + ':' + stringify(v[k]));
        return '{' + out.join(',') + '}';
    }
    // Strict JSON parser: no eval of request text, even on older Photoshop versions without JSON.
    function parse(source) {
        var pos = 0;
        function ws() { while (/\s/.test(source.charAt(pos)) && pos < source.length) pos++; }
        function fail() { throw new Error('Invalid JSON at ' + pos); }
        function str() {
            var out = '', c, esc, code;
            if (source.charAt(pos++) !== '"') fail();
            while (pos < source.length) {
                c = source.charAt(pos++);
                if (c === '"') return out;
                if (c === '\\') {
                    esc = source.charAt(pos++);
                    if (esc === 'u') {
                        code = source.substr(pos, 4);
                        if (!/^[0-9a-f]{4}$/i.test(code)) fail();
                        out += String.fromCharCode(parseInt(code, 16)); pos += 4;
                    } else {
                        var escapes = { '"': '"', '\\': '\\', '/': '/', 'b': '\b', 'f': '\f', 'n': '\n', 'r': '\r', 't': '\t' };
                        if (!escapes.hasOwnProperty(esc)) fail();
                        out += escapes[esc];
                    }
                } else { if (c.charCodeAt(0) < 32) fail(); out += c; }
            }
            fail();
        }
        function value() {
            ws(); var c = source.charAt(pos), out, key, token;
            if (c === '"') return str();
            if (c === '{') {
                pos++; out = {}; ws(); if (source.charAt(pos) === '}') { pos++; return out; }
                while (true) {
                    ws(); key = str(); ws(); if (source.charAt(pos++) !== ':') fail();
                    if (key === '__proto__' || key === 'constructor' || key === 'prototype') fail();
                    out[key] = value(); ws(); c = source.charAt(pos++); if (c === '}') return out; if (c !== ',') fail();
                }
            }
            if (c === '[') {
                pos++; out = []; ws(); if (source.charAt(pos) === ']') { pos++; return out; }
                while (true) { out.push(value()); ws(); c = source.charAt(pos++); if (c === ']') return out; if (c !== ',') fail(); }
            }
            token = /^(true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(source.slice(pos));
            if (!token) fail(); pos += token[0].length;
            if (token[0] === 'true') return true; if (token[0] === 'false') return false; if (token[0] === 'null') return null;
            out = Number(token[0]); if (!isFinite(out)) fail(); return out;
        }
        var result = value(); ws(); if (pos !== source.length) fail(); return result;
    }
    function readText(filePath) {
        var file = new File(filePath); file.encoding = 'UTF8';
        if (!file.open('r')) throw new Error('Cannot read request file');
        try { return file.read().replace(/^\uFEFF/, ''); } finally { file.close(); }
    }
    var request, args, oldUnits, oldDialogs, oldForeground, oldTool, haveState = false, haveDialogs = false, unitsChanged = false, completed = 0;
    var C = charIDToTypeID, S = stringIDToTypeID;
    function checkCancel() {
        if (new File(request.cancel_file).exists || new Date().getTime() > request.deadline) {
            throw new Error('操作已取消或超时；已绘制 ' + completed + ' 笔。部分结果保留，可撤销本批。');
        }
    }
    function getDocument(documentId, activate) {
        for (var i = 0; i < app.documents.length; i++) if (app.documents[i].id === documentId) {
            if (activate !== false) app.activeDocument = app.documents[i]; return app.documents[i];
        }
        throw new Error('找不到 document_id=' + documentId + '，请先调用 ps_status');
    }
    function layerInfo(layer, depth) {
        return { id: layer.id, name: layer.name, type: layer.typename, visible: layer.visible,
            opacity: layer.opacity, locked: layer.allLocked, depth: depth };
    }
    function collectLayers(container, result, depth) {
        for (var i = 0; i < container.layers.length && result.length < 512; i++) {
            var layer = container.layers[i]; result.push(layerInfo(layer, depth));
            if (layer.typename === 'LayerSet') collectLayers(layer, result, depth + 1);
        }
    }
    function documentInfo(doc, layers) {
        var info = { document_id: doc.id, name: doc.name, width: doc.width.as('px'), height: doc.height.as('px'),
            mode: String(doc.mode), active_layer_id: doc.activeLayer.id, saved: doc.saved, selection: selectionInfo(doc) };
        if (layers) { info.layers = []; collectLayers(doc, info.layers, 0); }
        return info;
    }
    function selectionInfo(doc) {
        function px(v) { return typeof v.as === 'function' ? v.as('px') : Number(v); }
        try {
            var b = doc.selection.bounds;
            return { active: true, bounds: { x: px(b[0]), y: px(b[1]), width: px(b[2]) - px(b[0]), height: px(b[3]) - px(b[1]) } };
        } catch (ignored) { return { active: false }; }
    }
    function findLayer(container, layerId) {
        for (var i = 0; i < container.layers.length; i++) {
            var layer = container.layers[i]; if (layer.id === layerId) return layer;
            if (layer.typename === 'LayerSet') { var nested = findLayer(layer, layerId); if (nested) return nested; }
        }
        return null;
    }
    function selectLayer(doc, layerId) {
        var layer = findLayer(doc, layerId); if (!layer) throw new Error('找不到 layer_id=' + layerId);
        doc.activeLayer = layer; return layer;
    }
    function rgb(color) { var result = new SolidColor(); result.rgb.hexValue = color.replace('#', ''); return result; }
    function rectPoints(bounds) {
        return [[bounds.x, bounds.y], [bounds.x + bounds.width, bounds.y],
            [bounds.x + bounds.width, bounds.y + bounds.height], [bounds.x, bounds.y + bounds.height]];
    }
    function validateBounds(doc, b) {
        if (b.x < 0 || b.y < 0 || b.width <= 0 || b.height <= 0 || b.x + b.width > doc.width.as('px') + 0.01 || b.y + b.height > doc.height.as('px') + 0.01) throw new Error('bounds 超出目标画布范围');
    }
    function history(doc, title, work) {
        var result, failure;
        $.global.DSH_historyBody = function () { try { result = work(); } catch (e) { failure = e; } };
        try { doc.suspendHistory(title, 'DSH_historyBody()'); }
        finally { delete $.global.DSH_historyBody; }
        if (failure) throw failure;
        return result;
    }
    function selectBrushPreset(preset) {
        app.currentTool = 'paintbrushTool';
        if (!preset) return;
        var d = new ActionDescriptor(), ref = new ActionReference();
        ref.putName(C('Brsh'), preset); d.putReference(C('null'), ref);
        executeAction(C('slct'), d, DialogModes.NO);
    }
    var brushCache = '';
    function flattenCurve(source, closed) {
        var result = [{ x: source[0].x, y: source[0].y }], count = closed ? source.length : source.length - 1;
        function distance(a, b) { var x = a[0] - b[0], y = a[1] - b[1]; return Math.sqrt(x * x + y * y); }
        for (var i = 0; i < count; i++) {
            var a = source[i], b = source[(i + 1) % source.length];
            if (!a.right && !b.left) { if (i < source.length - 1) result.push({ x: b.x, y: b.y }); continue; }
            var p0 = [a.x, a.y], p1 = a.right || p0, p3 = [b.x, b.y], p2 = b.left || p3;
            var steps = Math.max(2, Math.min(256, Math.ceil((distance(p0, p1) + distance(p1, p2) + distance(p2, p3)) / 6)));
            for (var j = 1; j <= steps; j++) {
                if (closed && i === count - 1 && j === steps) continue;
                var t = j / steps, u = 1 - t;
                result.push({ x: u*u*u*p0[0] + 3*u*u*t*p1[0] + 3*u*t*t*p2[0] + t*t*t*p3[0],
                    y: u*u*u*p0[1] + 3*u*u*t*p1[1] + 3*u*t*t*p2[1] + t*t*t*p3[1] });
            }
            if (result.length > 8192) throw new Error('曲线采样点过多，请拆分笔画');
        }
        return result;
    }
    function configureBrush(stroke) {
        var key = [stroke.size, stroke.hardness, stroke.opacity, stroke.flow].join('/');
        if (brushCache === key) return;
        app.currentTool = 'paintbrushTool';
        var d = new ActionDescriptor(), ref = new ActionReference(), b = new ActionDescriptor();
        ref.putEnumerated(C('Brsh'), C('Ordn'), C('Trgt')); d.putReference(C('null'), ref);
        b.putUnitDouble(C('Dmtr'), C('#Pxl'), stroke.size);
        b.putUnitDouble(C('Hrdn'), C('#Prc'), stroke.hardness);
        b.putUnitDouble(C('Spcn'), C('#Prc'), 10);
        d.putObject(C('T   '), C('Brsh'), b); executeAction(C('setd'), d, DialogModes.NO);
        var options = new ActionDescriptor(), target = new ActionReference(), values = new ActionDescriptor();
        target.putClass(S('paintbrushTool')); options.putReference(S('null'), target);
        values.putUnitDouble(S('opacity'), S('percentUnit'), stroke.opacity);
        values.putUnitDouble(S('flow'), S('percentUnit'), stroke.flow);
        values.putEnumerated(S('mode'), S('blendMode'), S('normal'));
        options.putObject(S('to'), S('null'), values); executeAction(S('set'), options, DialogModes.NO);
        brushCache = key;
    }
    function paint(doc, stroke) {
        checkCancel(); configureBrush(stroke); app.foregroundColor = rgb(stroke.color);
        var points = [], source = flattenCurve(stroke.points, stroke.closed), i;
        // A tiny two-point path produces a dot reliably with strokePath.
        if (source.length === 1) source = [source[0], { x: source[0].x + 0.01, y: source[0].y }];
        for (i = 0; i < source.length; i++) {
            var p = source[i], point = new PathPointInfo();
            // Sample cubic curves into a native path for consistent COM/ExtendScript behavior.
            point.kind = PointKind.CORNERPOINT;
            point.anchor = [p.x, p.y]; point.leftDirection = p.left || [p.x, p.y]; point.rightDirection = p.right || [p.x, p.y];
            points.push(point);
        }
        var sub = new SubPathInfo(); sub.closed = stroke.closed; sub.operation = ShapeOperation.SHAPEADD; sub.entireSubPath = points;
        var workPath = doc.pathItems.add('__DSH_' + new Date().getTime(), [sub]);
        try { workPath.strokePath(ToolType.BRUSH, stroke.simulate_pressure); completed++; }
        finally { workPath.remove(); }
    }
    function writable(doc, layer) {
        if (layer.typename !== 'ArtLayer' || layer.kind !== LayerKind.NORMAL) throw new Error('请使用普通像素图层；不会自动栅格化文字、形状或智能对象');
        if (layer.allLocked || layer.pixelsLocked || layer.isBackgroundLayer) throw new Error('目标图层已锁定或是背景层，请新建图层');
        if (layer.transparentPixelsLocked) throw new Error('目标图层锁定了透明像素，请解锁或新建图层');
        if (!layer.visible) throw new Error('目标图层不可见，请先显示或新建图层');
        if (String(doc.mode) !== String(DocumentMode.RGB)) throw new Error('画笔工具要求 RGB 文档；请创建 RGB 文档或手动转换副本');
    }
    function newPaintLayer(doc, name) { var layer = doc.artLayers.add(); layer.name = name; doc.activeLayer = layer; return layer; }
    function withRegion(doc, bounds, work) {
        validateBounds(doc, bounds);
        var saved = null, selected = false, oldChannels = doc.activeChannels;
        try { doc.selection.bounds; selected = true; } catch (ignored) {}
        if (selected) {
            saved = doc.channels.add(); saved.name = '__DSH_selection'; doc.selection.store(saved);
            doc.activeChannels = oldChannels;
        }
        try {
            doc.activeChannels = doc.componentChannels;
            doc.selection.select(rectPoints(bounds), selected ? SelectionType.INTERSECT : SelectionType.REPLACE, 0, true);
            return work();
        } finally {
            if (saved) { try { doc.selection.load(saved, SelectionType.REPLACE); } finally { saved.remove(); } }
            else doc.selection.deselect();
            doc.activeChannels = oldChannels;
        }
    }
    function draw(doc) {
        return history(doc, 'DSH 画笔 ' + args.strokes.length + ' 笔', function () {
            var layer = args.layer_id ? selectLayer(doc, args.layer_id) : newPaintLayer(doc, args.layer_name);
            writable(doc, layer); doc.activeChannels = doc.componentChannels; selectBrushPreset(args.preset);
            for (var i = 0; i < args.strokes.length; i++) paint(doc, args.strokes[i]);
            return { document_id: doc.id, layer_id: layer.id, layer_name: layer.name, strokes_drawn: completed, undo_steps: 1 };
        });
    }
    function lineart(doc) {
        return history(doc, 'DSH 整图线稿批次', function () {
            var layer = args.layer_id ? selectLayer(doc, args.layer_id) : newPaintLayer(doc, args.layer_name);
            writable(doc, layer); doc.activeChannels = doc.componentChannels;
            var first = args.strokes[0]; configureBrush(first); app.foregroundColor = rgb(first.color);
            var i = 0;
            while (i < args.strokes.length) {
                checkCancel(); var subs = [], total = 0;
                while (i < args.strokes.length && subs.length < 64 && total + args.strokes[i].points.length <= 5000) {
                    var source = args.strokes[i].points, points = [];
                    for (var j = 0; j < source.length; j++) {
                        var p = new PathPointInfo(); p.kind = PointKind.CORNERPOINT;
                        p.anchor = [source[j].x, source[j].y]; p.leftDirection = p.anchor; p.rightDirection = p.anchor; points.push(p);
                    }
                    var sub = new SubPathInfo(); sub.closed = false; sub.operation = ShapeOperation.SHAPEADD; sub.entireSubPath = points;
                    subs.push(sub); total += points.length; i++;
                }
                var workPath = doc.pathItems.add('__DSH_lineart_' + i, subs);
                try { workPath.strokePath(ToolType.BRUSH, false); completed += subs.length; }
                finally { workPath.remove(); }
            }
            return {document_id:doc.id,layer_id:layer.id,layer_name:layer.name,strokes_drawn:completed,undo_steps:1};
        });
    }
    function repaint(doc) {
        return history(doc, 'DSH 参考图画笔重绘', function () {
            return withRegion(doc, args.plan.bounds, function () {
                var group = doc.layerSets.add(); group.name = args.layer_name; var ids = [];
                selectBrushPreset(args.preset);
                // New layers are created inside this group; original layers stay untouched.
                for (var i = 0; i < args.plan.passes.length; i++) {
                    var pass = args.plan.passes[i], layer = group.artLayers.add(); layer.name = pass.name; doc.activeLayer = layer;
                    writable(doc, layer); ids.push(layer.id);
                    if (i === 0) doc.selection.fill(rgb(args.plan.background), ColorBlendMode.NORMAL, 100, false);
                    for (var j = 0; j < pass.strokes.length; j++) paint(doc, pass.strokes[j]);
                }
                return { document_id: doc.id, group_id: group.id, layer_ids: ids, strokes_drawn: completed,
                    undo_steps: 1, bounds: args.plan.bounds, style: args.plan.style, seed: args.plan.seed };
            });
        });
    }
    function paintRound(doc) {
        return history(doc, 'DSH 创建优化轮次', function () {
            var group = doc.layerSets.add(); group.name = args.name;
            var color = group.artLayers.add();
            color.name = '01 参考配色'; color.opacity = args.color_opacity;
            var ink = group.artLayers.add(); ink.name = '02 线稿'; ink.opacity = args.line_opacity;
            for (var i = 0; i < args.previous_group_ids.length; i++) selectLayer(doc, args.previous_group_ids[i]).visible = false;
            doc.activeLayer = ink;
            return {group_id:group.id,color_layer_id:color.id,line_layer_id:ink.id};
        });
    }
    function colorBatch(doc) {
        return history(doc, 'DSH 上色批次', function () {
            if (!args.style) args.style = 'flat_fill';
            var layer = selectLayer(doc, args.layer_id); writable(doc, layer); doc.activeChannels = doc.componentChannels;
            var i = 0, count = 0;
            while (i < args.marks.length) {
                checkCancel(); var color = args.marks[i].color, subs = [], contours = [], start = i;
                while (i < args.marks.length && args.marks[i].color === color && i - start < 64) {
                    var mark = args.marks[i];
                    if (args.style === 'flat_fill') {
                        if (!mark.bounds) throw new Error('style=flat_fill 时每个 mark 需要 bounds:{x,y,width,height}');
                        var b = mark.bounds;
                        contours.push({hole:false,points:[{x:b.x,y:b.y},{x:b.x+b.width,y:b.y},{x:b.x+b.width,y:b.y+b.height},{x:b.x,y:b.y+b.height}]});
                    } else {
                        if (!mark.points || !mark.points.length) throw new Error('style 非 flat_fill 时每个 mark 需要 points:[{x,y},...]');
                        var pts = [];
                        for (var k = 0; k < mark.points.length; k++) {
                            var point = new PathPointInfo(); point.kind = PointKind.CORNERPOINT; point.anchor = [mark.points[k].x,mark.points[k].y];
                            point.leftDirection = point.anchor; point.rightDirection = point.anchor; pts.push(point);
                        }
                        var sub = new SubPathInfo(); sub.closed = false; sub.operation = ShapeOperation.SHAPEADD; sub.entireSubPath = pts; subs.push(sub);
                    }
                    i++;
                }
                var workPath = args.style === 'flat_fill' ? polygonPath(doc,contours) : doc.pathItems.add('__DSH_color_' + i,subs);
                try {
                    if(args.style === 'flat_fill') workPath.fillPath(rgb(color),ColorBlendMode.NORMAL,100,false,0,false,true);
                    else { configureBrush(args.marks[start]); app.foregroundColor = rgb(color); workPath.strokePath(ToolType.BRUSH,false); }
                    count += i-start;
                } finally {workPath.remove();}
            }
            return {document_id:doc.id,layer_id:layer.id,marks_drawn:count,undo_steps:1};
        });
    }
    function formLayers(doc) {
        return history(doc, 'DSH 分层形体上色', function () {
            if (args.opacity === undefined) args.opacity = 100;
            if (!args.color_round) args.color_round = 1;
            var ink = selectLayer(doc,args.line_layer_id), base = selectLayer(doc,args.color_layer_id), parent = ink.parent;
            if (base.parent !== parent) throw new Error('线稿与底色必须在同一父级内');
            if(args.previous_layer_ids && args.previous_layer_ids.length){
                for(var old=0;old<args.previous_layer_ids.length;old++)selectLayer(doc,args.previous_layer_ids[old]).visible=false;
                base=parent.artLayers.add();base.opacity=args.opacity;
            }
            var prefix='上色'+(args.color_round||1)+' · ';
            base.name = prefix+'01 区域底色'; base.opacity=args.opacity; base.move(ink,ElementPlacement.PLACEAFTER);
            var ids = {base:base.id}, roles = ['shadow','light','detail'], names = ['02 形体暗部','03 形体亮部','04 顺形细节'];
            for(var i=0;i<roles.length;i++) {
                var layer=parent.artLayers.add(); layer.name=prefix+names[i]; layer.opacity=args.opacity; layer.move(ink,ElementPlacement.PLACEAFTER);ids[roles[i]]=layer.id;
            }
            doc.activeLayer=ink;return {layer_ids:ids};
        });
    }
    function formBatch(doc) {
        if(selectionInfo(doc).active)throw new Error('形体上色批次要求无外部选区');
        return history(doc,'DSH 线稿约束形体笔触',function(){
            var marks=0,strokes=0,fills=0;
            doc.activeChannels=doc.componentChannels;
            try {
                for(var i=0;i<args.marks.length;i++) {
                    checkCancel();var mark=args.marks[i];
                    if (mark.role === undefined || args.layer_ids[mark.role] === undefined) throw new Error('mark 需要 role 且 layer_ids 需包含对应键（base/shadow/light/detail）');
                    var layer=selectLayer(doc,args.layer_ids[mark.role]);writable(doc,layer);
                    var clip=polygonPath(doc,mark.contours);
                    try{
                        if(mark.fill_color){clip.fillPath(rgb(mark.fill_color),ColorBlendMode.NORMAL,100,false,0,true,true);fills++;}
                        if(mark.strokes.length)clip.makeSelection(0,true,SelectionType.REPLACE);
                    }finally{clip.remove();}
                    // Independent subpaths with identical paint settings share one
                    // native brush invocation; they are never joined end-to-end.
                    var batches={},keys=[];
                    for(var k=0;k<mark.strokes.length;k++){
                        var s=mark.strokes[k],key=[s.color,s.size,s.opacity,s.flow,s.hardness].join('/');
                        if(!batches[key]){batches[key]=[];keys.push(key);}batches[key].push(s);
                    }
                    for(var g=0;g<keys.length;g++){
                        checkCancel();var batch=batches[keys[g]],subs=[];configureBrush(batch[0]);app.foregroundColor=rgb(batch[0].color);
                        for(var k=0;k<batch.length;k++){
                            var points=[],source=flattenCurve(batch[k].points,false);
                            for(var p=0;p<source.length;p++){var q=new PathPointInfo();q.kind=PointKind.CORNERPOINT;q.anchor=[source[p].x,source[p].y];q.leftDirection=q.anchor;q.rightDirection=q.anchor;points.push(q);}
                            var sub=new SubPathInfo();sub.closed=false;sub.operation=ShapeOperation.SHAPEADD;sub.entireSubPath=points;subs.push(sub);
                        }
                        var strokePath=doc.pathItems.add('__DSH_form_brush_'+g,subs);
                        try{strokePath.strokePath(ToolType.BRUSH,false);strokes+=batch.length;completed+=batch.length;}finally{strokePath.remove();}
                    }
                    doc.selection.deselect();marks++;
                }
                return {document_id:doc.id,marks_drawn:marks,strokes_drawn:strokes,regions_filled:fills,undo_steps:1};
            } finally {doc.selection.deselect();}
        });
    }
    function polygonPath(doc, contours) {
        var subs = [];
        for (var i = 0; i < contours.length; i++) {
            var points = [], contour = contours[i];
            for (var j = 0; j < contour.points.length; j++) {
                var source = contour.points[j], p = new PathPointInfo(); p.kind = PointKind.CORNERPOINT;
                p.anchor = [source.x, source.y]; p.leftDirection = [source.x, source.y]; p.rightDirection = [source.x, source.y]; points.push(p);
            }
            var sub = new SubPathInfo(); sub.closed = true; sub.operation = contour.hole ? ShapeOperation.SHAPESUBTRACT : ShapeOperation.SHAPEADD;
            sub.entireSubPath = points; subs.push(sub);
        }
        try { return doc.pathItems.add('__DSH_cel_' + new Date().getTime(), subs); }
        catch (error) { throw new Error('创建平涂路径失败（' + subs.length + ' 个轮廓）：' + error.message); }
    }
    function anime(doc) {
        if (String(doc.mode) !== String(DocumentMode.RGB)) throw new Error('二次元重绘要求 RGB 文档');
        if (!args.plan) args.plan = {};
        if (!args.plan.bounds) args.plan.bounds = { x: 0, y: 0, width: doc.width.as('px'), height: doc.height.as('px') };
        if (!args.plan.fills) args.plan.fills = [];
        if (!args.plan.strokes) args.plan.strokes = [];
        if (!args.plan.ink_contours) args.plan.ink_contours = [];
        if (!args.plan.contour_count) args.plan.contour_count = 0;
        if (!args.plan.rendering) args.plan.rendering = 'flat';
        return history(doc, 'DSH 二次元平涂与线稿重绘', function () {
            return withRegion(doc, args.plan.bounds, function () {
                var group = doc.layerSets.add(); group.name = args.layer_name;
                var light = group.artLayers.add(); light.name = '01 亮色平涂';
                var dark = group.artLayers.add(); dark.name = '02 暗色与轮廓色块';
                var ink = group.artLayers.add(); ink.name = '03 线稿画笔';
                var filled = 0;
                for (var i = 0; i < args.plan.fills.length; i++) {
                    checkCancel(); var fill = args.plan.fills[i]; doc.activeLayer = fill.dark ? dark : light;
                    var path = polygonPath(doc, fill.contours);
                    try { path.fillPath(rgb(fill.color), ColorBlendMode.NORMAL, 100, false, 0, true, true); filled++; }
                    finally { path.remove(); }
                }
                if (args.plan.strokes.length && args.plan.ink_contours.length) {
                    var saved = doc.channels.add(); saved.name = '__DSH_ink_clip'; doc.selection.store(saved);
                    var inkPath = null;
                    try {
                        doc.activeChannels = doc.componentChannels; doc.activeLayer = ink;
                        inkPath = polygonPath(doc, args.plan.ink_contours);
                        inkPath.makeSelection(0, true, SelectionType.INTERSECT);
                        selectBrushPreset(null);
                        for (var n = 0; n < args.plan.strokes.length; n++) paint(doc, args.plan.strokes[n]);
                    } finally {
                        if (inkPath) inkPath.remove();
                        try { doc.selection.load(saved, SelectionType.REPLACE); } finally { saved.remove(); }
                        doc.activeChannels = doc.componentChannels;
                    }
                }
                doc.activeLayer = ink;
                return { document_id: doc.id, group_id: group.id, layer_ids: [light.id, dark.id, ink.id],
                    path_fills: filled, contours: args.plan.contour_count, strokes_drawn: completed, bounds: args.plan.bounds, undo_steps: 1,
                    rendering: args.plan.rendering };
            });
        });
    }
    function localEdit(doc) {
        var selection = selectionInfo(doc);
        if (!selection.active) throw new Error('没有选区；请先选择需要修改的部位');
        if (String(doc.mode) !== String(DocumentMode.RGB)) throw new Error('局部修改要求 RGB 文档');
        return history(doc, 'DSH 局部 ' + args.operation, function () {
            var layer = newPaintLayer(doc, args.layer_name); doc.activeChannels = doc.componentChannels;
            writable(doc, layer);
            if (args.operation === 'recolor') layer.blendMode = BlendMode.COLORBLEND;
            else if (args.operation === 'shade') layer.blendMode = BlendMode.MULTIPLY;
            else if (args.operation === 'highlight') layer.blendMode = BlendMode.SCREEN;
            else layer.blendMode = BlendMode.NORMAL;
            layer.opacity = args.opacity;
            doc.selection.fill(rgb(args.color), ColorBlendMode.NORMAL, 100, false);
            return { document_id: doc.id, layer_id: layer.id, layer_name: layer.name, operation: args.operation,
                blend_mode: String(layer.blendMode), selection: selection, undo_steps: 1, source_layers_preserved: true };
        });
    }
    function setSelection(doc) {
        return history(doc, 'DSH 局部选区', function () {
            if (args.clear) { doc.selection.deselect(); return { document_id: doc.id, cleared: true, selection: selectionInfo(doc) }; }
            doc.activeChannels = doc.componentChannels;
            var shape = args.shape || 'rectangle', points = [], i, previous = null, chosen = null, combine = args.combine || 'replace';
            var priorSelection = selectionInfo(doc);
            if ((combine === 'subtract' || combine === 'intersect') && !priorSelection.active) throw new Error('选区相减/相交需要已有选区');
            if (combine !== 'replace' && priorSelection.active) {
                previous = doc.channels.add(); previous.name = '__DSH_previous_selection'; doc.selection.store(previous); doc.activeChannels = doc.componentChannels;
            }
            try {
            if (shape === 'color') {
                if (args.seed.x >= doc.width.as('px') || args.seed.y >= doc.height.as('px')) throw new Error('seed 超出画布范围');
                var d = new ActionDescriptor(), ref = new ActionReference(), position = new ActionDescriptor();
                ref.putProperty(C('Chnl'), C('fsel')); d.putReference(C('null'), ref);
                position.putUnitDouble(C('Hrzn'), C('#Pxl'), args.seed.x); position.putUnitDouble(C('Vrtc'), C('#Pxl'), args.seed.y);
                d.putObject(C('T   '), C('Pnt '), position); d.putInteger(C('Tlrn'), args.tolerance);
                d.putBoolean(C('Mrgd'), true); d.putBoolean(C('Cntg'), args.contiguous); d.putBoolean(C('AntA'), args.anti_alias);
                executeAction(C('setd'), d, DialogModes.NO);
            } else {
                if (shape === 'polygon') {
                    for (i = 0; i < args.points.length; i++) {
                        var p = args.points[i]; if (p.x > doc.width.as('px') || p.y > doc.height.as('px')) throw new Error('多边形顶点超出画布范围');
                        points.push([p.x, p.y]);
                    }
                } else {
                    validateBounds(doc, args.bounds);
                    if (shape === 'ellipse') {
                        var b = args.bounds;
                        for (i = 0; i < 96; i++) { var t = i * Math.PI * 2 / 96; points.push([b.x + b.width / 2 * (1 + Math.cos(t)), b.y + b.height / 2 * (1 + Math.sin(t))]); }
                    } else points = rectPoints(args.bounds);
                }
                doc.selection.select(points, SelectionType.REPLACE, 0, args.anti_alias !== false);
            }
            if (previous) {
                if (combine === 'subtract') {
                    chosen = doc.channels.add(); chosen.name = '__DSH_chosen_selection'; doc.selection.store(chosen);
                    doc.selection.load(previous, SelectionType.REPLACE); doc.selection.load(chosen, SelectionType.DIMINISH);
                } else doc.selection.load(previous, combine === 'add' ? SelectionType.EXTEND : SelectionType.INTERSECT);
                doc.activeChannels = doc.componentChannels;
            }
            if (args.grow > 0) doc.selection.expand(args.grow);
            else if (args.grow < 0) doc.selection.contract(-args.grow);
            if (args.feather > 0) doc.selection.feather(args.feather);
            var selection = selectionInfo(doc);
            if (!selection.active) throw new Error('选区为空，请调整区域、容差或收缩量');
            return { document_id: doc.id, cleared: false, shape: shape, combine: combine, selection: selection };
            } catch (error) {
                if (previous) doc.selection.load(previous, SelectionType.REPLACE);
                throw error;
            } finally {
                if (chosen) chosen.remove(); if (previous) previous.remove(); doc.activeChannels = doc.componentChannels;
            }
        });
    }
    function saveDocument(doc, preview) {
        var output = new File(args.path), temporary = null;
        if (output.exists && !args.overwrite) throw new Error('文件已存在，未覆盖：' + output.fsName);
        if (!output.parent.exists) throw new Error('保存目录不存在：' + output.parent.fsName);
        var ext = args.path.toLowerCase().split('.').pop(), target = doc, options;
        try {
            if (preview || ext === 'jpg' || ext === 'jpeg') {
                temporary = doc.duplicate('__DSH_export_' + new Date().getTime(), false); target = temporary;
                if (String(target.mode) !== String(DocumentMode.RGB)) target.changeMode(ChangeMode.RGB);
                target.bitsPerChannel = BitsPerChannelType.EIGHT;
                if (preview) {
                    if (args.bounds) {
                        var b = args.bounds;
                        if (b.x + b.width > target.width.as('px') || b.y + b.height > target.height.as('px')) throw new Error('预览区域超出画布');
                        target.crop([UnitValue(b.x, 'px'), UnitValue(b.y, 'px'), UnitValue(b.x + b.width, 'px'), UnitValue(b.y + b.height, 'px')]);
                    }
                    var scale = Math.min(1, args.max_side / Math.max(target.width.as('px'), target.height.as('px')));
                    if (scale < 1) target.resizeImage(UnitValue(Math.max(1, Math.round(target.width.as('px') * scale)), 'px'),
                        UnitValue(Math.max(1, Math.round(target.height.as('px') * scale)), 'px'), null, ResampleMethod.BICUBIC);
                }
                if (ext === 'jpg' || ext === 'jpeg') target.flatten();
            }
            if (ext === 'psd') { options = new PhotoshopSaveOptions(); options.layers = true; options.embedColorProfile = true; }
            else if (ext === 'png') { options = new PNGSaveOptions(); options.interlaced = false; }
            else { options = new JPEGSaveOptions(); options.quality = args.quality || 10; options.embedColorProfile = true; }
            target.saveAs(output, options, true, Extension.LOWERCASE);
            return { document_id: doc.id, path: output.fsName, width: target.width.as('px'), height: target.height.as('px'),
                bytes: output.length, format: ext, saved_as_copy: true, source_bounds: preview && args.bounds ? args.bounds : { x: 0, y: 0, width: doc.width.as('px'), height: doc.height.as('px') } };
        } finally {
            if (temporary) temporary.close(SaveOptions.DONOTSAVECHANGES);
            app.activeDocument = doc;
        }
    }
    function artworkGroup(doc, id) {
        var group = findLayer(doc, id);
        if (!group || group.typename !== 'LayerSet') throw new Error('原创作品图层组不存在：' + id);
        return group;
    }
    function artworkBegin(doc) {
        return history(doc, 'DSH 原创候选', function () {
            var previous = [], i;
            for (i = 0; i < args.previous_group_ids.length; i++) previous.push(artworkGroup(doc, args.previous_group_ids[i]));
            var group = doc.layerSets.add(); group.name = args.name; group.visible = true;
            for (i = 0; i < previous.length; i++) previous[i].visible = false;
            return {document_id:doc.id, group_id:group.id};
        });
    }
    function artworkObject(doc) {
        if (selectionInfo(doc).active) throw new Error('原创绘图不能覆盖用户现有选区');
        return history(doc, 'DSH 对象 ' + args.object.id, function () {
            var group = artworkGroup(doc, args.group_id), layer, o = args.object, clip = null;
            if (args.clone_layer_id) {
                var source = findLayer(doc, args.clone_layer_id);
                if (!source || source.typename !== 'ArtLayer' || !source.parent || source.parent.id !== args.source_group_id) throw new Error('复用对象图层不匹配，停止绘制');
                layer = source.duplicate(group, ElementPlacement.INSIDE);
                return {document_id:doc.id, layer_id:layer.id, reused:true, strokes_drawn:0};
            }
            layer = group.artLayers.add(); layer.name = o.id + ' · ' + o.name; doc.activeLayer = layer;
            writable(doc, layer); var oldChannels = doc.activeChannels;
            try {
                doc.activeChannels = doc.componentChannels;
                if (o.contours.length) {
                    clip = polygonPath(doc, o.contours);
                    if (o.fill_color) clip.fillPath(rgb(o.fill_color), ColorBlendMode.NORMAL, 100, false, 0, true, true);
                    if (o.strokes.length) clip.makeSelection(0, true, SelectionType.REPLACE);
                } else if (o.fill_color) throw new Error('填色缺少已接受线稿边界');
                for (var i = 0; i < o.strokes.length; i++) paint(doc, o.strokes[i]);
                return {document_id:doc.id, layer_id:layer.id, reused:false, strokes_drawn:completed};
            } finally {
                try { if (clip) clip.remove(); }
                finally { try { doc.selection.deselect(); } finally { doc.activeChannels = oldChannels; } }
            }
        });
    }
    function artworkShow(doc) {
        var groups = [], selected = false;
        for (var i = 0; i < args.group_ids.length; i++) { groups.push(artworkGroup(doc,args.group_ids[i])); if (args.group_ids[i] === args.selected_group_id) selected = true; }
        if (!selected) throw new Error('恢复目标不属于已记录候选');
        return history(doc, 'DSH 恢复原创候选', function () {
            for (var i = 0; i < groups.length; i++) groups[i].visible = groups[i].id === args.selected_group_id;
            return {document_id:doc.id, group_id:args.selected_group_id};
        });
    }
    function dispatch() {
        checkCancel(); var doc, layer, i;
        if (request.operation === 'status') {
            var documents = []; for (i = 0; i < app.documents.length; i++) documents.push(documentInfo(app.documents[i], false));
            return { photoshop_version: app.version, documents: documents,
                active_document_id: app.documents.length ? app.activeDocument.id : null };
        }
        if (request.operation === 'create') {
            doc = app.documents.add(UnitValue(args.width, 'px'), UnitValue(args.height, 'px'), args.resolution,
                args.name, NewDocumentMode.RGB, DocumentFill.TRANSPARENT, 1, BitsPerChannelType.EIGHT);
            doc.activeLayer.name = args.background === 'transparent' ? '透明底层' : '背景';
            if (args.background !== 'transparent') {
                doc.selection.selectAll(); doc.selection.fill(rgb(args.background), ColorBlendMode.NORMAL, 100, false); doc.selection.deselect();
            }
            return documentInfo(doc, true);
        }
        if (request.operation === 'open') {
            var file = new File(args.path); if (!file.exists) throw new Error('图片不存在：' + args.path);
            doc = app.open(file); var sourceId = doc.id;
            if (args.duplicate) doc = doc.duplicate('DSH ' + doc.name, false);
            var info = documentInfo(doc, true); info.source_document_id = sourceId; return info;
        }
        doc = getDocument(args.document_id, request.operation !== 'info');
        if (request.operation === 'info') return documentInfo(doc, true);
        if (request.operation === 'artwork_begin') return artworkBegin(doc);
        if (request.operation === 'artwork_object') return artworkObject(doc);
        if (request.operation === 'artwork_show') return artworkShow(doc);
        if (request.operation === 'draw') return draw(doc);
        if (request.operation === 'repaint') return repaint(doc);
        if (request.operation === 'anime') return anime(doc);
        if (request.operation === 'local_edit') return localEdit(doc);
        if (request.operation === 'lineart') return lineart(doc);
        if (request.operation === 'paint_round') return paintRound(doc);
        if (request.operation === 'color_batch') return colorBatch(doc);
        if (request.operation === 'form_layers') return formLayers(doc);
        if (request.operation === 'form_batch') return formBatch(doc);
        if (request.operation === 'paint_round_select') {
            return history(doc, 'DSH 选择优化轮次', function () {
                for(var r = 0; r < args.group_ids.length; r++) selectLayer(doc,args.group_ids[r]).visible = args.group_ids[r] === args.selected_group_id;
                return {document_id:doc.id,selected_group_id:args.selected_group_id};
            });
        }
        if (request.operation === 'preview') return saveDocument(doc, true);
        if (request.operation === 'save') return saveDocument(doc, false);
        if (request.operation === 'layer') {
            return history(doc, 'DSH 图层操作', function () {
                layer = args.action === 'create' ? newPaintLayer(doc, args.name) : selectLayer(doc, args.layer_id);
                if (args.name) layer.name = args.name;
                if (typeof args.visible !== 'undefined') layer.visible = args.visible;
                if (typeof args.opacity !== 'undefined') layer.opacity = args.opacity;
                return { document_id: doc.id, layer: layerInfo(layer, 0) };
            });
        }
        if (request.operation === 'selection') return setSelection(doc);
        if (request.operation === 'undo') {
            if (doc.historyStates.length < 2) throw new Error('没有可撤销的历史步骤');
            var undo = new ActionDescriptor(), previous = new ActionReference();
            previous.putEnumerated(C('HstS'), C('Ordn'), C('Prvs'));
            undo.putReference(C('null'), previous); executeAction(C('slct'), undo, DialogModes.NO);
            return documentInfo(doc, true);
        }
        throw new Error('Unknown operation: ' + request.operation);
    }
    var result;
    try {
        request = parse(readText(DSH_REQUEST_FILE)); args = request.args;
        checkCancel();
        if (request.operation !== 'status' && request.operation !== 'info') {
            // Preference setters can invoke native dialogs. Suppress those
            // BEFORE touching units, including when restoring them below.
            oldDialogs = app.displayDialogs; haveDialogs = true;
            app.displayDialogs = DialogModes.NO;
            oldUnits = app.preferences.rulerUnits;
            oldForeground = app.foregroundColor; oldTool = app.currentTool; haveState = true;
            if (oldUnits !== Units.PIXELS) { unitsChanged = true; app.preferences.rulerUnits = Units.PIXELS; }
        }
        result = { ok: true, value: dispatch() };
    } catch (error) {
        result = { ok: false, error: String(error.message || error) + (error.line ? ' (JSX line ' + error.line + ')' : '') };
    } finally {
        if (haveState) {
            if (unitsChanged) { try { app.preferences.rulerUnits = oldUnits; } catch (ignored1) {} }
            try { app.foregroundColor = oldForeground; } catch (ignored3) {}
            try { app.currentTool = oldTool; } catch (ignored4) {}
        }
        if (haveDialogs) { try { app.displayDialogs = oldDialogs; } catch (ignored2) {} }
    }
    return stringify(result);
}());
