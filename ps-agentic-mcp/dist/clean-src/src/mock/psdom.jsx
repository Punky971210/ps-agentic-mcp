/*
 * Photoshop DOM 模拟层 —— 在 Node 的 vm 上下文内运行（ES5，不用 class/箭头）。
 *
 * 设计原则：
 *  1) 对象全部在本 realm 内创建，保证 `x instanceof Array` 这类判断与真实
 *     ExtendScript 一致（跨 realm 注入的数组会判断失败，从而污染 stringify）。
 *  2) 不试图渲染像素。所有 executeAction / DOM 副作用都记入 __PSMOCK.log，
 *     测试断言的正是「发出了什么指令」，这才是我们要维护的东西。
 *  3) 凡真实 PS 会抛异常的地方（无选区取 bounds、图层类型不匹配、bounds 越界），
 *     mock 也抛 —— 分支覆盖才有意义。
 */
(function () {
    var host = globalThis.__hostBridge; // 由宿主注入：{readFile, writeFile, exists, mkdirp, hash}

    function fail(msg) { throw new Error(msg); }

    // ---------- 枚举 ----------
    var DialogModes = { ALL: 1, ERROR: 2, NO: 3 };
    var Units = {
        PIXELS: 1, INCHES: 2, CM: 3, MM: 4, POINTS: 5, PICAS: 6, PERCENT: 7
    };
    var LayerKind = {
        NORMAL: 1, TEXT: 2, SOLIDFILL: 3, GRADIENTFILL: 4, PATTERNFILL: 5,
        SMART: 6, SHAPELAYER: 7, GROUP: 8, ADJUSTMENT: 9, VECTOR: 10
    };
    var BlendMode = {
        NORMAL: 'normal', MULTIPLY: 'multiply', SCREEN: 'screen', OVERLAY: 'overlay',
        SOFTLIGHT: 'soft light', HARDLIGHT: 'hard light', COLORDODGE: 'color dodge',
        COLORBURN: 'color burn', DARKEN: 'darken', LIGHTEN: 'lighten',
        DIFFERENCE: 'difference', EXCLUSION: 'exclusion', HUE: 'hue',
        SATURATION: 'saturation', COLOR: 'color', LUMINOSITY: 'luminosity',
        LINEARBURN: 'linear burn', LINEARBURN_: 'linear burn', LINEARLIGHT: 'linear light',
        VIVIDLIGHT: 'vivid light', PINLIGHT: 'pin light', HARDMIX: 'hard mix',
        SUBTRACT: 'subtract', DIVIDE: 'divide'
    };
    var PointKind = { CORNERPOINT: 1, SMOOTHPOINT: 2 };
    var ShapeOperation = { SHAPEADD: 1, SHAPEINTERSECT: 2, SHAPESUBTRACT: 3, SHAPEXOR: 4 };
    var ToolType = { BRUSH: 1, PENCIL: 2, ERASER: 3 };
    var ElementPlacement = { PLACEATBEGINNING: 1, PLACEATEND: 2, PLACEBEFORE: 3, PLACEAFTER: 4, INSIDE: 5 };
    var SaveDocumentType = { PHOTOSHOP: 1, JPEG: 2, PNG: 3, TIFF: 4 };
    var NewDocumentMode = { RGB: 'RGBColor', GRAYSCALE: 'Grayscale', CMYK: 'CMYKColor', LAB: 'LabColor', BITMAP: 'Bitmap' };
    // DocumentMode 与 NewDocumentMode 是两个不同枚举：前者用于读 doc.mode，
    // 后者用于 documents.add 的入参。engine 有 4 处 String(doc.mode) !== String(DocumentMode.RGB)。
    var DocumentMode = { RGB: 'RGBColor', GRAYSCALE: 'Grayscale', CMYK: 'CMYKColor', LAB: 'LabColor', BITMAP: 'Bitmap', INDEXEDCOLOR: 'IndexedColor', DUOTONE: 'Duotone', MULTICHANNEL: 'Multichannel' };
    var DocumentFill = { WHITE: 1, BACKGROUNDCOLOR: 2, TRANSPARENT: 3, COLOR: 4 };
    var BitsPerChannelType = { ONE: 1, EIGHT: 8, SIXTEEN: 16, THIRTYTWO: 32 };
    var ColorBlendMode = { NORMAL: 'normal', MULTIPLY: 'multiply', SCREEN: 'screen', OVERLAY: 'overlay' };
    var AnchorPosition = {
        TOPLEFT: 1, TOPCENTER: 2, TOPRIGHT: 3, MIDDLELEFT: 4, MIDDLECENTER: 5,
        MIDDLERIGHT: 6, BOTTOMLEFT: 7, BOTTOMCENTER: 8, BOTTOMRIGHT: 9
    };
    var SelectionType = { REPLACE: 1, EXTEND: 2, DIMINISH: 3, INTERSECT: 4 };
    var RasterizeType = { ENTIRELAYER: 1, TEXTCONTENTS: 2, SHAPE: 3, LAYERSTYLE: 4 };
    var Direction = { HORIZONTAL: 1, VERTICAL: 2 };
    var Justification = { LEFT: 1, CENTER: 2, RIGHT: 3, JUSTIFYLASTLEFT: 4 };
    var ResampleMethod = { NEARESTNEIGHBOR: 1, BILINEAR: 2, BICUBIC: 3, BICUBICSMOOTHER: 4, BICUBICSHARPER: 5 };
    var SaveOptions = { DONOTSAVECHANGES: 1, SAVECHANGES: 2, PROMPTTOSAVECHANGES: 3 };

    // ---------- UnitValue ----------
    function UnitValue(value, unit) {
        // ExtendScript 允许 UnitValue(x, 'px') 不带 new（ps_core / ext 都这么写）
        if (!(this instanceof UnitValue)) return new UnitValue(value, unit);
        this.value = value;
        this.type = unit || 'px';
    }
    UnitValue.prototype.as = function (unit) {
        var factors = { px: 1, in: 1 / 72, cm: 2.54 / 72, mm: 25.4 / 72, pt: 1, pc: 1 / 12 };
        var basePx = this.type === 'px' ? this.value : this.value * 72 / (factors[this.type] ? 1 / factors[this.type] : 1);
        if (this.type === 'px') basePx = this.value;
        var f = factors[unit] || 1;
        return basePx * f;
    };
    UnitValue.prototype.toString = function () { return this.value + ' ' + this.type; };

    // ---------- 颜色 ----------
    function SolidColor() {
        if (!(this instanceof SolidColor)) return new SolidColor();
        var self = this;
        this._hex = '000000';
        this.rgb = {
            get hexValue() { return self._hex; },
            set hexValue(v) { self._hex = String(v).replace(/^#/, ''); }
        };
        this.cmyk = { cyan: 0, magenta: 0, yellow: 0, black: 100 };
        this.hsb = { hue: 0, saturation: 0, brightness: 0 };
    }

    // ---------- File / Folder ----------
    function File(path) {
        // ExtendScript 的 File() 既是构造器也可直接调用（ps_core 就是直接调的）
        if (!(this instanceof File)) return new File(path);
        this.fsName = String(path).replace(/\\/g, '/');
        this.name = this.fsName.split('/').pop();
        this.encoding = 'UTF-8';
        this._content = null;
        this._pos = 0;
    }
    Object.defineProperty(File.prototype, 'exists', {
        get: function () { return host.exists(this.fsName); }
    });
    // engine 保存前会查 output.parent.exists；ExtendScript 的 File 有 parent
    Object.defineProperty(File.prototype, 'parent', {
        get: function () {
            var parts = this.fsName.split('/');
            parts.pop();
            return new Folder(parts.join('/'));
        }
    });
    File.prototype.open = function (mode) {
        if (mode === 'r') {
            if (!host.exists(this.fsName)) return false;
            this._content = host.readFile(this.fsName);
            this._pos = 0;
            return true;
        }
        if (mode === 'w') { this._content = ''; this._pos = 0; return true; }
        return false;
    };
    File.prototype.read = function (chars) {
        if (this._content === null) return '';
        var out = chars ? this._content.substr(this._pos, chars) : this._content.substr(this._pos);
        this._pos += out.length;
        return out;
    };
    File.prototype.write = function (s) {
        if (this._content === null) this._content = '';
        this._content += String(s);
        return true;
    };
    File.prototype.close = function () {
        if (this._content !== null) { host.writeFile(this.fsName, this._content); this._content = null; }
        return true;
    };

    function Folder(path) {
        if (!(this instanceof Folder)) return new Folder(path);
        this.fsName = String(path).replace(/\\/g, '/');
    }
    Object.defineProperty(Folder.prototype, 'exists', {
        get: function () { return host.exists(this.fsName); }
    });
    Folder.prototype.create = function () { host.mkdirp(this.fsName); return true; };
    Folder.prototype.getFiles = function () { return []; };

    // ---------- ActionManager ----------
    var actionSeq = 0;
    function ActionDescriptor() { this.__kind = 'descriptor'; this.__id = ++actionSeq; this.__props = []; }
    ActionDescriptor.prototype.putReference = function (k, v) { this.__props.push({ op: 'reference', k: k, v: v }); };
    ActionDescriptor.prototype.putObject = function (k1, k2, v) { this.__props.push({ op: 'object', k1: k1, k2: k2, v: v }); };
    ActionDescriptor.prototype.putEnumerated = function (k, t, v) { this.__props.push({ op: 'enumerated', k: k, t: t, v: v }); };
    ActionDescriptor.prototype.putInteger = function (k, v) { this.__props.push({ op: 'integer', k: k, v: v }); };
    ActionDescriptor.prototype.putDouble = function (k, v) { this.__props.push({ op: 'double', k: k, v: v }); };
    ActionDescriptor.prototype.putUnitDouble = function (k, u, v) { this.__props.push({ op: 'unitDouble', k: k, u: u, v: v }); };
    ActionDescriptor.prototype.putBoolean = function (k, v) { this.__props.push({ op: 'boolean', k: k, v: v }); };
    ActionDescriptor.prototype.putString = function (k, v) { this.__props.push({ op: 'string', k: k, v: v }); };
    ActionDescriptor.prototype.putList = function (k, v) { this.__props.push({ op: 'list', k: k, v: v }); };
    ActionDescriptor.prototype.putClass = function () { this.__props.push({ op: 'class' }); };
    ActionDescriptor.prototype.putAngle = function (k, v) { this.__props.push({ op: 'angle', k: k, v: v }); };
    ActionDescriptor.prototype.putData = function (k, v) { this.__props.push({ op: 'data', k: k, v: v }); };
    // getter 面：executeActionGet 的返回值要能被脚本读出来（图层 id/名称/索引）
    ActionDescriptor.prototype.hasKey = function (k) {
        var i;
        for (i = 0; i < this.__props.length; i++) if (this.__props[i].k === k) return true;
        return false;
    };
    ActionDescriptor.prototype.getInteger = function (k) { return this.__get(k, 'integer', 0); };
    ActionDescriptor.prototype.getDouble = function (k) { return this.__get(k, 'double', 0); };
    ActionDescriptor.prototype.getBoolean = function (k) { return this.__get(k, 'boolean', false); };
    ActionDescriptor.prototype.getString = function (k) { return this.__get(k, 'string', ''); };
    ActionDescriptor.prototype.getObjectValue = function (k) { return this.__get(k, 'object', null); };
    ActionDescriptor.prototype.getList = function (k) { return this.__get(k, 'list', null); };
    ActionDescriptor.prototype.getEnumeratedValue = function (k) { return this.__get(k, 'enumerated', null); };
    ActionDescriptor.prototype.__get = function (k, want, dflt) {
        var i, p;
        for (i = 0; i < this.__props.length; i++) {
            p = this.__props[i];
            if (p.k === k && p.op === want) return p.v;
        }
        return dflt;
    };

    function ActionReference() { this.__kind = 'reference'; this.__props = []; }
    ActionReference.prototype.putProperty = function (t, k) { this.__props.push({ op: 'property', t: t, k: k }); };
    ActionReference.prototype.putName = function (t, n) { this.__props.push({ op: 'name', t: t, n: n }); };
    ActionReference.prototype.putEnumerated = function (t, ty, v) { this.__props.push({ op: 'enumerated', t: t, ty: ty, v: v }); };
    ActionReference.prototype.putIdentifier = function (t, id) { this.__props.push({ op: 'identifier', t: t, id: id }); };
    ActionReference.prototype.putIndex = function (t, i) { this.__props.push({ op: 'index', t: t, i: i }); };
    ActionReference.prototype.putClass = function (t) { this.__props.push({ op: 'class', t: t }); };
    ActionReference.prototype.putOffset = function (t, o) { this.__props.push({ op: 'offset', t: t, o: o }); };

    function ActionList() { this.__kind = 'list'; this.__items = []; }
    ActionList.prototype.putObject = function (k, v) { this.__items.push({ op: 'object', k: k, v: v }); };
    ActionList.prototype.putEnumerated = function (t, v) { this.__items.push({ op: 'enumerated', t: t, v: v }); };
    ActionList.prototype.putInteger = function (v) { this.__items.push({ op: 'integer', v: v }); };
    ActionList.prototype.putString = function (v) { this.__items.push({ op: 'string', v: v }); };
    ActionList.prototype.putReference = function (v) { this.__items.push({ op: 'reference', v: v }); };
    ActionList.prototype.getCount = function () { return this.__items.length; };

    // ---------- 图层 ----------
    function makeLayer(spec) {
        var layer = {
            id: spec.id,
            name: spec.name || ('Layer ' + spec.id),
            typename: spec.kind === LayerKind.GROUP ? 'LayerSet' : 'ArtLayer',
            kind: spec.kind === undefined ? LayerKind.NORMAL : spec.kind,
            visible: spec.visible !== false,
            opacity: spec.opacity === undefined ? 100 : spec.opacity,
            blendMode: spec.blendMode || BlendMode.NORMAL,
            allLocked: !!spec.allLocked,
            isBackgroundLayer: !!spec.isBackgroundLayer,
            parent: spec.parent || null,
            // 注意：真实 PS 里非文字层的 textItem 是 undefined，但 ps_core 的写法是
            // 「先 artLayers.add() 再设 kind = TEXT」，所以这里必须让 textItem 一开始就存在，
            // 否则赋值那一步就崩。是否文字层一律看 kind。
            textItem: { contents: spec.contents || '', size: new UnitValue(12, 'pt'), font: 'ArialMT', justification: 'LEFT', tracking: 0, useAutoLeading: true },
            bounds: spec.bounds || [new UnitValue(0, 'px'), new UnitValue(0, 'px'), new UnitValue(100, 'px'), new UnitValue(100, 'px')]
        };
        if (spec.kind === LayerKind.GROUP) {
            layer.layers = spec.children || [];
            for (var i = 0; i < layer.layers.length; i++) layer.layers[i].parent = layer;
            // 真实 PS 的 LayerSet 也有 artLayers 子集合视图（anime_engine 的
            // repaint / anime / formLayers 会在组内 artLayers.add() 建层）。
            Object.defineProperty(layer, 'artLayers', {
                get: function () {
                    var list = layer.layers.filter(function (l) { return l.typename === 'ArtLayer'; });
                    list.add = function () {
                        var l = makeLayer({ id: ps._nextId(), name: 'Layer ' + ps._nextId() });
                        l.parent = layer;
                        layer.layers.unshift(l);
                        ps._log('dom', 'artLayers.add', { id: l.id, group_id: layer.id });
                        return l;
                    };
                    return list;
                }
            });
        }
        layer.duplicate = function (rel, placement) {
            var copy = makeLayer({ id: ps._nextId(), name: layer.name + ' copy', kind: layer.kind });
            ps._log('dom', 'layer.duplicate', { from: layer.id, to: copy.id });
            return copy;
        };
        layer.remove = function () {
            var parent = layer.parent || ps.activeDocument;
            var list = parent.layers;
            for (var i = 0; i < list.length; i++) if (list[i].id === layer.id) { list.splice(i, 1); break; }
            ps._log('dom', 'layer.remove', { id: layer.id });
        };
        layer.move = function (rel, placement) { ps._log('dom', 'layer.move', { id: layer.id, placement: placement }); };
        layer.resize = function (w, h, anchor) {
            var pctW = (w && typeof w.as === 'function') ? w.as('percent') : Number(w);
            var pctH = (h && typeof h.as === 'function') ? h.as('percent') : Number(h);
            var b = layer.bounds;
            var x0 = b[0].value, y0 = b[1].value, x1 = b[2].value, y1 = b[3].value;
            var cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
            var nw = (x1 - x0) * pctW / 100, nh = (y1 - y0) * pctH / 100;
            layer.bounds = [new UnitValue(cx - nw / 2, 'px'), new UnitValue(cy - nh / 2, 'px'),
                            new UnitValue(cx + nw / 2, 'px'), new UnitValue(cy + nh / 2, 'px')];
            ps._log('dom', 'layer.resize', { w: pctW, h: pctH });
        };
        layer.rotate = function (angle, anchor) { ps._log('dom', 'layer.rotate', { angle: angle }); };
        layer.translate = function (dx, dy) {
            var ddx = (dx && typeof dx.as === 'function') ? dx.as('px') : Number(dx);
            var ddy = (dy && typeof dy.as === 'function') ? dy.as('px') : Number(dy);
            var b = layer.bounds;
            // bounds 是 [left, top, right, bottom]：x 轴是 0/2，y 轴是 1/3
            layer.bounds = [
                new UnitValue(b[0].value + ddx, 'px'),
                new UnitValue(b[1].value + ddy, 'px'),
                new UnitValue(b[2].value + ddx, 'px'),
                new UnitValue(b[3].value + ddy, 'px')
            ];
            ps._log('dom', 'layer.translate', { dx: ddx, dy: ddy });
        };
        layer.rasterize = function (target) { ps._log('dom', 'layer.rasterize', { id: layer.id }); return layer; };
        layer.applyGaussianBlur = function (r) { ps._log('dom', 'layer.applyGaussianBlur', { id: layer.id, radius: r }); };
        layer.applyMotionBlur = function (angle, dist) { ps._log('dom', 'layer.applyMotionBlur', { angle: angle, distance: dist }); };
        layer.adjustBrightnessContrast = function (b, c) { ps._log('dom', 'adjustBrightnessContrast', { b: b, c: c }); };
        layer.adjustLevels = function () { ps._log('dom', 'adjustLevels', {}); };
        layer.adjustCurves = function () { ps._log('dom', 'adjustCurves', {}); };
        layer.adjustHueSaturation = function () { ps._log('dom', 'adjustHueSaturation', {}); };
        layer.invert = function () { ps._log('dom', 'layer.invert', { id: layer.id }); };
        layer.clear = function () { ps._log('dom', 'layer.clear', { id: layer.id }); };
        layer.fill = function (color) { ps._log('dom', 'layer.fill', { id: layer.id }); };
        layer.strokePath = function (tool, simulate) { ps._log('dom', 'path.strokePath', { id: layer.id, tool: tool, simulatePressure: simulate }); };
        layer.pathItems = {
            add: function (name, subs) {
                var p = makePath(name, subs);
                ps._log('dom', 'pathItems.add', { name: name, subpaths: subs.length });
                return p;
            }
        };
        return layer;
    }

    function makePath(name, subs) {
        return {
            name: name,
            subPathItems: subs || [],
            strokePath: function (tool, simulate) { ps._log('dom', 'path.strokePath', { name: name, tool: tool, simulatePressure: simulate }); },
            fillPath: function () { ps._log('dom', 'path.fillPath', { name: name }); },
            makeSelection: function (feather, antialias, op) { ps._log('dom', 'path.makeSelection', { name: name }); },
            remove: function () { ps._log('dom', 'path.remove', { name: name }); }
        };
    }

    function PathPointInfo() { this.kind = PointKind.CORNERPOINT; this.anchor = [0, 0]; this.leftDirection = [0, 0]; this.rightDirection = [0, 0]; }
    function SubPathInfo() { this.closed = true; this.operation = ShapeOperation.SHAPEADD; this.entireSubPath = []; }

    // ---------- 保存选项 ----------
    var Extension = {
        LOWERCASE: 'lowercase', UPPERCASE: 'uppercase', NONE: 'none'
    };
    function PhotoshopSaveOptions() { this.embedColorProfile = true; this.maximizeCompatibility = true; this.layers = true; this.alphaChannels = true; }
    function PNGSaveOptions() { this.compression = 6; this.interlaced = false; }
    function JPEGSaveOptions() { this.quality = 10; this.embedColorProfile = true; this.formatOptions = 1; }
    function TiffSaveOptions() { this.imageCompression = 1; this.layers = true; }
    function GIFSaveOptions() { this.colors = 256; this.dither = 100; }

    // ---------- 选区 ----------
    function makeSelection(doc) {
        var sel = {
            _active: false,
            _bounds: null,
            get bounds() {
                if (!sel._active) fail('No selection'); // 真实 PS 会抛，engine 依赖此分支
                return sel._bounds;
            },
            select: function (region, type, feather, antialias) {
                sel._active = true;
                sel._bounds = [new UnitValue(0, 'px'), new UnitValue(0, 'px'), new UnitValue(doc._w, 'px'), new UnitValue(doc._h, 'px')];
                ps._log('dom', 'selection.select', { region: String(region) });
            },
            selectRectangle: function (top, left, bottom, right, mode, feather, antialias) {
                sel._active = true;
                sel._bounds = [new UnitValue(left, 'px'), new UnitValue(top, 'px'), new UnitValue(right, 'px'), new UnitValue(bottom, 'px')];
                ps._log('dom', 'selection.selectRectangle', { top: top, left: left, bottom: bottom, right: right });
            },
            selectEllipse: function (top, left, bottom, right, mode, feather, antialias) {
                sel._active = true;
                sel._bounds = [new UnitValue(left, 'px'), new UnitValue(top, 'px'), new UnitValue(right, 'px'), new UnitValue(bottom, 'px')];
                ps._log('dom', 'selection.selectEllipse', {});
            },
            selectAll: function () {
                sel._active = true;
                sel._bounds = [new UnitValue(0, 'px'), new UnitValue(0, 'px'), new UnitValue(doc._w, 'px'), new UnitValue(doc._h, 'px')];
                ps._log('dom', 'selection.selectAll', {});
            },
            deselect: function () { sel._active = false; sel._bounds = null; ps._log('dom', 'selection.deselect', {}); },
            feather: function (r) { ps._log('dom', 'selection.feather', { radius: r }); },
            expand: function (n) { ps._log('dom', 'selection.expand', { by: n }); },
            contract: function (n) { ps._log('dom', 'selection.contract', { by: n }); },
            grow: function (t, a) { ps._log('dom', 'selection.grow', { tolerance: t }); },
            similar: function (t, a) { ps._log('dom', 'selection.similar', { tolerance: t }); },
            invert: function () { ps._log('dom', 'selection.invert', {}); },
            smooth: function (r) { ps._log('dom', 'selection.smooth', { radius: r }); },
            border: function (w) { ps._log('dom', 'selection.border', { width: w }); },
            selectBorder: function (w) {
                sel._active = true;
                if (!sel._bounds) sel._bounds = [new UnitValue(0, 'px'), new UnitValue(0, 'px'), new UnitValue(doc._w, 'px'), new UnitValue(doc._h, 'px')];
                ps._log('dom', 'selection.selectBorder', { width: (w && typeof w.as === 'function') ? w.as('px') : Number(w) });
            },
            store: function (channel, type) { ps._log('dom', 'selection.store', { channel: String(channel) }); },
            load: function (channel, type, invert) { ps._log('dom', 'selection.load', { channel: String(channel) }); },
            fill: function (color, mode, opacity, preserve) { ps._log('dom', 'selection.fill', { mode: String(mode) }); },
            translateBoundary: function (dx, dy) { ps._log('dom', 'selection.translate', { dx: dx, dy: dy }); },
            clear: function () { ps._log('dom', 'selection.clear', {}); },
            copy: function () { ps._log('dom', 'selection.copy', {}); },
            cut: function () { sel._active = false; sel._bounds = null; ps._log('dom', 'selection.cut', {}); }
        };
        return sel;
    }

    // ---------- 文档 ----------
    function makeDocument(spec) {
        var doc = {
            id: spec.id,
            name: spec.name || 'Untitled-' + spec.id,
            _w: spec.width || 1024,
            _h: spec.height || 1024,
            _res: spec.resolution || 72,
            mode: spec.mode || 'RGBColor',
            bitsPerChannel: spec.bitsPerChannel || 8,
            saved: spec.saved === true,
            activeLayer: null,
            colorProfileName: 'sRGB IEC61966-2.1',
            info: {},
            layers: [],
            historyStates: [{ name: 'Open' }, { name: 'New Layer' }],
            pathItems: []
        };
        doc.width = new UnitValue(doc._w, 'px');
        doc.height = new UnitValue(doc._h, 'px');
        doc.resolution = doc._res;
        doc.layers = spec.layers || [makeLayer({ id: 1, name: 'Background', parent: doc })];
        for (var i = 0; i < doc.layers.length; i++) doc.layers[i].parent = doc;
        doc.activeLayer = spec.activeLayer || doc.layers[0];
        // 真实 Photoshop 的 Document 还有 artLayers / layerSets 两个子集合视图。
        // updateText / exportLayers 这类代码依赖它们存在。
        Object.defineProperty(doc, 'artLayers', {
            get: function () {
                var list = doc.layers.filter(function (l) { return l.typename === 'ArtLayer'; });
                // 真实 PS 的 ArtLayers 是集合，有 add()。ps_core 的 PS.text.add 依赖它。
                list.add = function () {
                    var l = makeLayer({ id: ps._nextId(), name: 'Layer ' + ps._nextId() });
                    l.parent = doc;
                    doc.layers.unshift(l);
                    doc.activeLayer = l;
                    ps._log('dom', 'artLayers.add', { id: l.id });
                    return l;
                };
                return list;
            }
        });
        Object.defineProperty(doc, 'layerSets', {
            get: function () {
                var list = doc.layers.filter(function (l) { return l.typename === 'LayerSet'; });
                // engine 的 lineart / paint 会 doc.layerSets.add() 建组再往里落层
                list.add = function () {
                    var g = makeLayer({ id: ps._nextId(), name: 'Group ' + ps._nextId(), kind: LayerKind.GROUP, children: [] });
                    g.parent = doc;
                    doc.layers.unshift(g);
                    doc.activeLayer = g;
                    ps._log('dom', 'layerSets.add', { id: g.id });
                    return g;
                };
                return list;
            }
        });
        // 画布级变换：ps_core 的 xf.* / image.auto_straighten 依赖这两个
        doc.rotateCanvas = function (angle) {
            var a = (angle && typeof angle.as === 'function') ? angle.as('degrees') : Number(angle);
            ps._log('dom', 'doc.rotateCanvas', { angle: a });
        };
        doc.flipCanvas = function (dir) {
            ps._log('dom', 'doc.flipCanvas', { direction: String(dir) });
        };
        doc.crop = function (bounds) { ps._log('dom', 'doc.crop', { bounds: bounds }); };
        doc.resizeImage = function (w, h, res, method) {
            doc._w = (w && typeof w.as === 'function') ? w.as('px') : Number(w);
            doc._h = (h && typeof h.as === 'function') ? h.as('px') : Number(h);
            doc.width = new UnitValue(doc._w, 'px');
            doc.height = new UnitValue(doc._h, 'px');
            ps._log('dom', 'doc.resizeImage', { width: doc._w, height: doc._h });
        };
        doc.selection = makeSelection(doc);

        // 真实 Document.pathItems 是 PathItems 集合（add 构造开放/闭合路径），sel.polygon 依赖它。
        doc.pathItems.add = function (name, subs) {
            var p = makePath(name, subs);
            ps._log('dom', 'doc.pathItems.add', { name: name, subpaths: subs ? subs.length : 0 });
            return p;
        };

        // 真实 Document.paste()：把剪贴板内容粘进文档并返回新图层（sel.paste 依赖）。
        doc.paste = function () {
            var l = makeLayer({ id: ps._nextId(), name: 'Pasted Layer ' + ps._nextId(), parent: doc });
            doc.layers.unshift(l);
            doc.activeLayer = l;
            ps._log('dom', 'doc.paste', { id: doc.id, layer_id: l.id });
            return l;
        };

        // Alpha 通道：sel.store / sel.intersect_rect 依赖 channels.add 与 channel.remove。
        doc.channels = {
            add: function () {
                var ch = { name: '' };
                ch.remove = function () { ps._log('dom', 'channel.remove', { name: ch.name }); };
                ps._log('dom', 'channels.add', { name: ch.name });
                return ch;
            }
        };

        doc.suspendHistory = function (title, script) {
            ps.history.push(title);
            ps._log('dom', 'suspendHistory', { title: title });
            // ExtendScript 的 suspendHistory 第二个参数是「一段字符串」，内部 eval。
            return globalThis.eval(String(script));
        };
        doc.close = function (saveOptions) { ps._log('dom', 'doc.close', { id: doc.id, saving: String(saveOptions) }); return true; };
        doc.saveAs = function (file, options, asCopy) {
            doc.saved = true;
            ps._log('dom', 'doc.saveAs', { path: file && file.fsName, asCopy: !!asCopy });
            return true;
        };
        doc.crop = function (bounds) { ps._log('dom', 'doc.crop', {}); };
        doc.resizeImage = function (w, h, res, mode) { ps._log('dom', 'doc.resizeImage', {}); };
        doc.resizeCanvas = function (w, h, anchor) { ps._log('dom', 'doc.resizeCanvas', {}); };
        doc.flatten = function () { ps._log('dom', 'doc.flatten', { id: doc.id }); };
        doc.mergeVisibleLayers = function () { ps._log('dom', 'doc.mergeVisibleLayers', { id: doc.id }); };
        doc.duplicate = function (name) {
            var copy = makeDocument({ id: ps._nextId(), name: name || doc.name + ' copy', width: doc._w, height: doc._h });
            ps._log('dom', 'doc.duplicate', { from: doc.id, to: copy.id });
            return copy;
        };
        doc.trim = function (type) { ps._log('dom', 'doc.trim', {}); };
        doc.exportDocument = function (file, type, opts) { ps._log('dom', 'doc.exportDocument', { path: file && file.fsName }); };
        doc.generateThumbnail = function () { ps._log('dom', 'doc.generateThumbnail', {}); };
        return doc;
    }

    // ---------- 应用 ----------
    var ps = {
        version: '27.0.0',
        history: [],
        log: [],
        _idSeq: 100,
        _nextId: function () { return this._idSeq++; },
        _log: function (channel, name, args) {
            this.log.push({ channel: channel, name: name, args: args || {} });
        }
    };

    var documents = [];
    documents.add = function (w, h, res, name, mode, init) {
        // engine 传的是 UnitValue(1200,'px')。不解包的话 makeDocument 会把对象
        // 当尺寸存下去，documentInfo 的 width.as('px') 就会返回 NaN
        // ——而且 NaN 还会让 JSON 输出变成非法文本。
        var wv = (w && typeof w.as === 'function') ? w.as('px') : Number(w);
        var hv = (h && typeof h.as === 'function') ? h.as('px') : Number(h);
        var doc = makeDocument({ id: ps._nextId(), width: wv, height: hv, resolution: res, name: name });
        this.push(doc);
        app.activeDocument = doc;
        ps._log('dom', 'documents.add', { width: w, height: h, name: name });
        return doc;
    };

    var app = {
        version: ps.version,
        documents: documents,
        activeDocument: null,
        displayDialogs: DialogModes.ALL,
        preferences: { rulerUnits: Units.INCHES, typeUnits: Units.POINTS },
        foregroundColor: new SolidColor(),
        backgroundColor: new SolidColor(),
        currentTool: 'brushTool',
        colorSamplers: { add: function () { return {}; }, length: 0 },
        fonts: [
            { postScriptName: 'ArialMT', name: 'Arial' },
            { postScriptName: 'SimSun', name: '宋体' },
            { postScriptName: 'MicrosoftYaHei', name: 'Microsoft YaHei' }
        ],
        charIDToTypeID: globalThis.__hostBridge.charIDToTypeID,
        stringIDToTypeID: globalThis.__hostBridge.stringIDToTypeID,
        open: function (file) {
            var p = file && file.fsName ? file.fsName : String(file);
            var doc = makeDocument({ id: ps._nextId(), name: p.split('/').pop() });
            documents.push(doc);
            app.activeDocument = doc;
            ps._log('dom', 'app.open', { path: p });
            return doc;
        },
        bringToFront: function () { ps._log('dom', 'app.bringToFront', {}); }
    };

    function executeAction(type, descriptor, mode) {
        // 把描述符压成可断言的摘要：调用方（ext.jsx）靠 type + 引用数就能表达语义，
        // 不需要 mock 真的改文档。keys 保留 key 列表用于排查。
        var info = { type: type, mode: mode, props: 0, keys: [], refs: 0 };
        if (descriptor && descriptor.__props) {
            var i, p;
            info.props = descriptor.__props.length;
            for (i = 0; i < descriptor.__props.length; i++) {
                p = descriptor.__props[i];
                info.keys.push(p.k || p.op);
                if (p.op === 'reference') info.refs++;
                if (p.op === 'list' && p.v && p.v.__items) info.refs += p.v.__items.length;
            }
        }
        ps._log('action', 'executeAction', info);
        return new ActionDescriptor();
    }

    // ---------- 导出 ----------
    globalThis.DialogModes = DialogModes;
    globalThis.Units = Units;
    globalThis.LayerKind = LayerKind;
    globalThis.BlendMode = BlendMode;
    globalThis.PointKind = PointKind;
    globalThis.ShapeOperation = ShapeOperation;
    globalThis.ToolType = ToolType;
    globalThis.ElementPlacement = ElementPlacement;
    globalThis.SaveDocumentType = SaveDocumentType;
    globalThis.NewDocumentMode = NewDocumentMode;
    globalThis.DocumentMode = DocumentMode;
    globalThis.DocumentFill = DocumentFill;
    globalThis.BitsPerChannelType = BitsPerChannelType;
    globalThis.ColorBlendMode = ColorBlendMode;
    globalThis.AnchorPosition = AnchorPosition;
    globalThis.SelectionType = SelectionType;
    globalThis.RasterizeType = RasterizeType;
    globalThis.Direction = Direction;
    globalThis.Justification = Justification;
    globalThis.ResampleMethod = ResampleMethod;
    globalThis.SaveOptions = SaveOptions;
    globalThis.UnitValue = UnitValue;
    globalThis.SolidColor = SolidColor;
    globalThis.File = File;
    globalThis.Folder = Folder;
    globalThis.ActionDescriptor = ActionDescriptor;
    globalThis.ActionReference = ActionReference;
    globalThis.ActionList = ActionList;
    globalThis.PathPointInfo = PathPointInfo;
    globalThis.SubPathInfo = SubPathInfo;
    globalThis.Extension = Extension;
    globalThis.PhotoshopSaveOptions = PhotoshopSaveOptions;
    globalThis.PNGSaveOptions = PNGSaveOptions;
    globalThis.JPEGSaveOptions = JPEGSaveOptions;
    globalThis.TiffSaveOptions = TiffSaveOptions;
    globalThis.GIFSaveOptions = GIFSaveOptions;
    globalThis.app = app;
    // ExtendScript 的 $ 是全局对象本身（$.global === globalThis），
    // 且 charIDToTypeID / stringIDToTypeID 是顶层函数而非 app 的方法。
    if (!globalThis.$) globalThis.$ = {};
    globalThis.$.global = globalThis;
    globalThis.charIDToTypeID = globalThis.__hostBridge.charIDToTypeID;
    globalThis.executeAction = executeAction;
    globalThis.stringIDToTypeID = globalThis.__hostBridge.stringIDToTypeID;
    globalThis.localize = function (s) { return String(s); };

    globalThis.__PSMOCK = {
        ps: ps,
        app: app,
        makeDocument: makeDocument,
        makeLayer: makeLayer,
        reset: function () {
            ps.log.length = 0;
            ps.history.length = 0;
            documents.length = 0;
            app.activeDocument = null;
            app.displayDialogs = DialogModes.ALL;
            app.preferences.rulerUnits = Units.INCHES;
            app.currentTool = 'brushTool';
        },
        summary: function () {
            return ps.log.map(function (e) {
                return e.channel + ':' + e.name + '(' + JSON.stringify(e.args) + ')';
            });
        }
    };
}());
