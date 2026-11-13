import path from 'node:path';

export function number(value, name, min, max, fallback, integer = false) {
  const n = value === undefined ? fallback : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    throw new Error(`${name} 必须是 ${min}–${max} 的${integer ? '整数' : '数字'}`);
  }
  return n;
}
export const id = (value, name = 'document_id') => number(value, name, 1, 2147483647, undefined, true);
export function text(value, name, fallback, max = 240) {
  const s = value === undefined ? fallback : value;
  if (typeof s !== 'string' || !s.trim() || s.length > max || /[\x00-\x1f]/.test(s)) throw new Error(`${name} 必须是 1–${max} 字符的文本`);
  return s.trim();
}
export function bool(value, name, fallback = false) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${name} 必须是布尔值`);
  return value;
}
export function color(value = '#000000') {
  if (typeof value !== 'string' || !/^#?[0-9a-f]{6}$/i.test(value)) throw new Error('color 必须是 #RRGGBB');
  return '#' + value.replace('#', '').toUpperCase();
}
export function filePath(value, extensions) {
  const p = text(value, 'path', undefined, 2048);
  if (!path.isAbsolute(p) || /[\r\n\0]/.test(p)) throw new Error('必须提供绝对文件路径');
  if (extensions && !extensions.includes(path.extname(p).toLowerCase())) throw new Error(`支持的文件格式：${extensions.join(', ')}`);
  return path.resolve(p);
}
export function region(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('bounds 必须是矩形对象');
  return { x: number(value.x, 'bounds.x', 0, 30000), y: number(value.y, 'bounds.y', 0, 30000),
    width: number(value.width, 'bounds.width', 1, 30000), height: number(value.height, 'bounds.height', 1, 30000) };
}
export function strokes(value, maxStrokes = 512) {
  if (!Array.isArray(value) || !value.length || value.length > maxStrokes) throw new Error(`strokes 需要 1–${maxStrokes} 条笔画`);
  let pointCount = 0;
  return value.map((s, index) => {
    if (!s || typeof s !== 'object') throw new Error(`strokes[${index}] 必须是对象`);
    if (!Array.isArray(s.points) || s.points.length < 1 || s.points.length > 2048) throw new Error('每条笔画需要 1–2048 个点');
    pointCount += s.points.length;
    if (pointCount > 32768) throw new Error('单批总点数不能超过 32768');
    const points = s.points.map(p => {
      if (!p || typeof p !== 'object') throw new Error('笔画点需要 x、y');
      const out = { x: number(p.x, 'point.x', -30000, 60000), y: number(p.y, 'point.y', -30000, 60000) };
      for (const key of ['left', 'right']) {
        if (p[key] !== undefined) {
          if (!Array.isArray(p[key]) || p[key].length !== 2) throw new Error(`${key} 贝塞尔手柄需要 [x,y]`);
          out[key] = p[key].map(n => number(n, key, -30000, 60000));
        }
      }
      return out;
    });
    return { points, color: color(s.color), size: number(s.size, 'size', 1, 5000, 12),
      opacity: number(s.opacity, 'opacity', 1, 100, 100), flow: number(s.flow, 'flow', 1, 100, 100),
      hardness: number(s.hardness, 'hardness', 0, 100, 100),
      simulate_pressure: bool(s.simulate_pressure, 'simulate_pressure'), closed: bool(s.closed, 'closed') };
  });
}
