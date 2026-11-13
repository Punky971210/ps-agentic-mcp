/*
 * 安全序列化 —— ExtendScript 没有 JSON 对象，且 PS DOM 对象普遍存在循环引用
 * （document.activeLayer.parent.layers[0].parent === document）。
 *
 * 两个职责：
 *   1) summarize：把 DOM 对象压成有限深度的摘要（typename/id/name/opacity…）
 *   2) stringify：ES3 实现，输出严格 JSON 文本
 *
 * 必须 ES3 兼容：这份代码会在真实 Photoshop 里执行。
 */
var __PSX = (function () {
    function isArray(v) { return Object.prototype.toString.call(v) === '[object Array]'; }
    function px(v) {
        if (v === null || typeof v === 'undefined') return null;
        if (typeof v.as === 'function') { try { return v.as('px'); } catch (ignored) { return v.value; } }
        return v;
    }

    function summarize(v, depth) {
        depth = depth || 0;
        if (v === null || typeof v === 'undefined') return null;
        var t = typeof v;
        if (t === 'string' || t === 'number' || t === 'boolean') return v;
        if (t === 'function') return '[function]';
        if (depth > 3) return '[depth-limit]';

        if (isArray(v)) {
            var arr = [], i;
            for (i = 0; i < v.length && i < 300; i++) arr.push(summarize(v[i], depth + 1));
            return arr;
        }

        // UnitValue：优先按像素取值
        if (typeof v.as === 'function' && typeof v.value !== 'undefined' && !v.typename) return px(v);

        // PS DOM 对象：只保留身份与关键状态，避免把整棵树带出来。
        // __plain 是扩展层给「自己的普通对象」打的标记（它也带 typename 字段），
        // 没有这个豁免，listLayers 之类的返回会被误裁。
        if (v.typename && !v.__plain) {
            var o = { typename: String(v.typename) };
            if (typeof v.id !== 'undefined') o.id = v.id;
            if (typeof v.name !== 'undefined') o.name = String(v.name);
            if (typeof v.visible !== 'undefined') o.visible = v.visible;
            if (typeof v.opacity !== 'undefined') o.opacity = v.opacity;
            if (typeof v.kind !== 'undefined') o.kind = v.kind;
            if (typeof v.blendMode !== 'undefined') o.blendMode = String(v.blendMode);
            if (typeof v.bounds !== 'undefined') {
                try { o.bounds = [px(v.bounds[0]), px(v.bounds[1]), px(v.bounds[2]), px(v.bounds[3])]; } catch (ignored) {}
            }
            return o;
        }

        var out = {}, n = 0, k;
        for (k in v) {
            if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
            if (k === '__plain') continue;
            if (typeof v[k] === 'function') continue;
            if (n++ >= 80) break;
            out[k] = summarize(v[k], depth + 1);
        }
        return out;
    }

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
        if (typeof v === 'number') return isFinite(v) ? String(v) : 'null';
        if (typeof v === 'boolean') return v ? 'true' : 'false';
        var out = [], k, i;
        if (isArray(v)) {
            for (i = 0; i < v.length; i++) out.push(stringify(v[i]));
            return '[' + out.join(',') + ']';
        }
        for (k in v) if (Object.prototype.hasOwnProperty.call(v, k)) out.push(quote(k) + ':' + stringify(v[k]));
        return '{' + out.join(',') + '}';
    }

    /** 一步到位：安全摘要 + JSON 文本 */
    function safe(value) { return stringify({ ok: true, value: summarize(value) }); }

    return { summarize: summarize, stringify: stringify, safe: safe };
}());
