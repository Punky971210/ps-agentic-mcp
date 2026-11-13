const hex = rgb => '#' + rgb.map(v => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
function pixel(image, x, y) {
  x = Math.max(0, Math.min(image.width - 1, Math.round(x)));
  y = Math.max(0, Math.min(image.height - 1, Math.round(y)));
  const n = (y * image.width + x) * 3;
  return [image.rgb[n], image.rgb[n + 1], image.rgb[n + 2]];
}
function randomSource(seed) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}

// A deterministic painter: coarse color coverage, then edge-following strokes at smaller scales.
// The returned paths are executed by Photoshop's real brush engine, never pasted as a raster image.
export function planRepaint(image, bounds, { maxStrokes = 1500, seed = 1, style = 'painterly' } = {}) {
  if (!Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 1 || image.height < 1 || image.rgb.length !== image.width * image.height * 3) throw new Error('无效的参考图像素数据');
  const ratio = Math.min(bounds.width / image.width, bounds.height / image.height);
  const width = image.width * ratio, height = image.height * ratio;
  const ox = bounds.x + (bounds.width - width) / 2, oy = bounds.y + (bounds.height - height) / 2;
  const rng = randomSource(seed), passes = [];
  const average = [0, 0, 0];
  for (let i = 0; i < image.rgb.length; i++) average[i % 3] += image.rgb[i] / (image.width * image.height);
  const fractions = [0.28, 0.34, 0.38];
  for (let pass = 0; pass < 3; pass++) {
    const budget = pass === 2 ? maxStrokes - passes.reduce((n, p) => n + p.strokes.length, 0) : Math.floor(maxStrokes * fractions[pass]);
    const columns = Math.max(1, Math.min(budget, Math.round(Math.sqrt(budget * image.width / image.height))));
    const rows = Math.max(1, Math.floor(budget / columns));
    const stepX = image.width / columns, stepY = image.height / rows;
    const gridStep = Math.sqrt(stepX * stepY);
    const candidates = [];
    const luminance = (x, y) => { const p = pixel(image, x, y); return p[0] * 0.299 + p[1] * 0.587 + p[2] * 0.114; };
    // A regular first pass guarantees coverage; later passes favor high-gradient detail.
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const px = Math.max(0, Math.min(image.width - 1, (column + 0.5) * stepX + (rng() - 0.5) * stepX * 0.4));
        const py = Math.max(0, Math.min(image.height - 1, (row + 0.5) * stepY + (rng() - 0.5) * stepY * 0.4));
        const gx = luminance(px + 1, py) - luminance(px - 1, py);
        const gy = luminance(px, py + 1) - luminance(px, py - 1);
        candidates.push({ x: px, y: py, angle: Math.atan2(gy, gx) + Math.PI / 2, gradient: Math.hypot(gx, gy), order: rng() });
      }
    }
    // Paint flat background first, edge detail last so broad white strokes cannot erase the subject.
    candidates.sort((a, b) => pass === 0 ? a.order - b.order : (a.gradient - b.gradient || a.order - b.order));
    const strokes = candidates.slice(0, budget).map(p => {
      const radius = gridStep * ratio * [1.65, 1.0, 0.64][pass];
      const length = radius * (style === 'pointillist' ? 0.03 : 1.2);
      const cx = ox + p.x * ratio, cy = oy + p.y * ratio;
      const dx = Math.cos(p.angle) * length / 2, dy = Math.sin(p.angle) * length / 2;
      const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
      return { color: hex(pixel(image, p.x, p.y)), size: Math.max(1, Math.min(5000, radius)),
        opacity: pass === 0 ? 100 : 88, flow: 100, hardness: style === 'soft' ? 20 : 80,
        simulate_pressure: false, closed: false,
        points: [{ x: clamp(cx - dx, ox, ox + width), y: clamp(cy - dy, oy, oy + height) },
          { x: clamp(cx + dx, ox, ox + width), y: clamp(cy + dy, oy, oy + height) }] };
    });
    if (strokes.length) passes.push({ name: ['01 大色块', '02 形体', '03 细节'][pass], strokes });
  }
  return { passes, background: hex(average), bounds: { x: ox, y: oy, width, height },
    stroke_count: passes.reduce((n, p) => n + p.strokes.length, 0), seed, style };
}

export function summarizeImage(image, gridSize = 12) {
  const bins = new Map(), sum = [0, 0, 0];
  for (let i = 0; i < image.rgb.length; i += 3) {
    const p = [...image.rgb.subarray(i, i + 3)];
    p.forEach((v, c) => { sum[c] += v; });
    const key = p.map(v => Math.min(255, Math.round(v / 32) * 32)).join(',');
    bins.set(key, (bins.get(key) || 0) + 1);
  }
  const total = image.width * image.height;
  const palette = [...bins].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([key, count]) => ({ color: hex(key.split(',').map(Number)), fraction: Math.round(count / total * 1000) / 1000 }));
  const grid = Array.from({ length: gridSize }, (_, y) => Array.from({ length: gridSize }, (_, x) =>
    hex(pixel(image, (x + 0.5) / gridSize * image.width, (y + 0.5) / gridSize * image.height))));
  return { width: image.source_width, height: image.source_height, average_color: hex(sum.map(n => n / total)), palette, color_grid: grid,
    note: '颜色采样不提供语义视觉理解。文本模型不可据此声称已看清主体或细节；可用图像模型读取 preview_path。透明像素按白色合成。' };
}
