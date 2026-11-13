const luminance = p => p[0] * 0.299 + p[1] * 0.587 + p[2] * 0.114;
const hex = p => '#' + p.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase();
const rgbAt = (image, i) => [image.rgb[i * 3], image.rgb[i * 3 + 1], image.rgb[i * 3 + 2]];
const opaque = (image, i) => !image.alpha || image.alpha[i] >= 128;
const distance2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

function validate(image) {
  if (!Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 1 || image.height < 1 || image.width > 512 || image.height > 512 || image.rgb.length !== image.width * image.height * 3 || (image.alpha && image.alpha.length !== image.width * image.height)) throw new Error('无效的二次元参考图采样数据');
}
export function quantize(image, count = 24) {
  validate(image);
  const histogram = new Map();
  for (let i = 0; i < image.width * image.height; i++) {
    if (!opaque(image, i)) continue;
    const p = rgbAt(image, i), key = (p[0] >> 3) * 1024 + (p[1] >> 3) * 32 + (p[2] >> 3);
    let bin = histogram.get(key); if (!bin) histogram.set(key, bin = { n: 0, sum: [0, 0, 0] });
    bin.n++; p.forEach((v, c) => { bin.sum[c] += v; });
  }
  if (!histogram.size) throw new Error('参考区域完全透明，没有可重绘内容');
  const bins = [...histogram.values()].map(bin => ({ n: bin.n, rgb: bin.sum.map(v => v / bin.n) }));
  const boxes = [bins];
  const range = box => [0, 1, 2].map(c => Math.max(...box.map(b => b.rgb[c])) - Math.min(...box.map(b => b.rgb[c])));
  while (boxes.length < count) {
    let best = -1, score = -1;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].length < 2) continue;
      const value = Math.max(...range(boxes[i])) * Math.sqrt(boxes[i].reduce((n, b) => n + b.n, 0));
      if (value > score) { score = value; best = i; }
    }
    if (best < 0) break;
    const box = boxes.splice(best, 1)[0], ranges = range(box), channel = ranges.indexOf(Math.max(...ranges));
    box.sort((a, b) => a.rgb[channel] - b.rgb[channel]);
    const half = box.reduce((n, b) => n + b.n, 0) / 2; let sum = 0, cut = 1;
    for (let i = 0; i < box.length - 1; i++) { sum += box[i].n; cut = i + 1; if (sum >= half) break; }
    boxes.push(box.slice(0, cut), box.slice(cut));
  }
  let palette = boxes.map(box => {
    const total = box.reduce((n, b) => n + b.n, 0);
    return [0, 1, 2].map(c => box.reduce((n, b) => n + b.rgb[c] * b.n, 0) / total);
  });
  const nearest = p => { let best = 0, dist = Infinity; palette.forEach((c, i) => { const d = distance2(p, c); if (d < dist) { dist = d; best = i; } }); return best; };
  for (let iteration = 0; iteration < 3; iteration++) {
    const sums = palette.map(() => [0, 0, 0, 0]);
    for (const b of bins) { const sum = sums[nearest(b.rgb)]; b.rgb.forEach((v, c) => { sum[c] += v * b.n; }); sum[3] += b.n; }
    palette = palette.map((p, i) => sums[i][3] ? sums[i].slice(0, 3).map(v => v / sums[i][3]) : p);
  }
  palette = palette.map(p => p.map(Math.round));
  const labels = new Int16Array(image.width * image.height); labels.fill(-1);
  const populations = new Uint32Array(palette.length);
  let error = 0;
  for (let i = 0; i < labels.length; i++) if (opaque(image, i)) {
    const p = rgbAt(image, i), label = nearest(p); labels[i] = label; populations[label]++; error += distance2(p, palette[label]);
  }
  return { labels, palette, populations, quantization_rmse: Math.sqrt(error / (populations.reduce((a, b) => a + b, 0) * 3)) };
}

function pointDistanceSquared(p, a, b) {
  let x = a.x, y = a.y, dx = b.x - x, dy = b.y - y;
  if (dx || dy) { const t = Math.max(0, Math.min(1, ((p.x - x) * dx + (p.y - y) * dy) / (dx * dx + dy * dy))); x += t * dx; y += t * dy; }
  return (p.x - x) ** 2 + (p.y - y) ** 2;
}
export function simplify(points, tolerance = 0.4) {
  if (points.length <= 2) return points;
  const keep = new Uint8Array(points.length); keep[0] = keep[points.length - 1] = 1;
  const pending = [[0, points.length - 1]], square = tolerance * tolerance;
  while (pending.length) {
    const [start, end] = pending.pop(); let best = square, index = -1;
    for (let i = start + 1; i < end; i++) { const d = pointDistanceSquared(points[i], points[start], points[end]); if (d > best) { best = d; index = i; } }
    if (index !== -1) { keep[index] = 1; pending.push([start, index], [index, end]); }
  }
  return points.filter((_, i) => keep[i]);
}
const signedArea = points => points.reduce((n, p, i) => { const q = points[(i + 1) % points.length]; return n + p.x * q.y - q.x * p.y; }, 0) / 2;

// Oriented pixel boundaries: outer loops clockwise in screen coordinates, holes counterclockwise.
export function traceContours(labels, width, height, label, tolerance = 0.35) {
  const vertices = new Map(), edges = [];
  const vertex = (x, y) => y * (width + 1) + x;
  const add = (x, y, ex, ey, direction) => {
    const edge = { start: vertex(x, y), end: vertex(ex, ey), direction, used: false };
    const list = vertices.get(edge.start) || []; list.push(edges.length); vertices.set(edge.start, list); edges.push(edge);
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (labels[y * width + x] === label) {
    if (y === 0 || labels[(y - 1) * width + x] !== label) add(x, y, x + 1, y, 0);
    if (x === width - 1 || labels[y * width + x + 1] !== label) add(x + 1, y, x + 1, y + 1, 1);
    if (y === height - 1 || labels[(y + 1) * width + x] !== label) add(x + 1, y + 1, x, y + 1, 2);
    if (x === 0 || labels[y * width + x - 1] !== label) add(x, y + 1, x, y, 3);
  }
  const contours = [], turnRank = [1, 0, 3, 2];
  for (let start = 0; start < edges.length; start++) {
    if (edges[start].used) continue;
    const points = []; let current = start, closed = false;
    for (let step = 0; step <= edges.length; step++) {
      const edge = edges[current]; if (edge.used) break; edge.used = true;
      points.push({ x: edge.start % (width + 1), y: Math.floor(edge.start / (width + 1)) });
      if (edge.end === edges[start].start) { closed = true; break; }
      const choices = (vertices.get(edge.end) || []).filter(i => !edges[i].used);
      if (!choices.length) break;
      choices.sort((a, b) => turnRank.indexOf((edges[a].direction - edge.direction + 4) % 4) - turnRank.indexOf((edges[b].direction - edge.direction + 4) % 4));
      current = choices[0];
    }
    if (!closed || points.length < 4) continue;
    const originalArea = signedArea(points);
    // Include closure during RDP so the first and last corners survive simplification.
    let effectiveTolerance = tolerance;
    let simple = simplify([...points, points[0]], effectiveTolerance).slice(0, -1);
    // Photoshop rejects overly large individual subpaths. Simplify only those
    // loops, retaining small contours and their holes at the requested detail.
    while (simple.length > 900) {
      effectiveTolerance = Math.max(0.1, effectiveTolerance * 1.25);
      simple = simplify([...points, points[0]], effectiveTolerance).slice(0, -1);
    }
    if (simple.length >= 3) contours.push({ points: simple, hole: originalArea < 0, area: Math.abs(originalArea) });
  }
  return contours.sort((a, b) => b.area - a.area);
}

export function thin(mask, width, height) {
  const skeleton = Uint8Array.from(mask);
  const at = (x, y) => x < 0 || y < 0 || x >= width || y >= height ? 0 : skeleton[y * width + x];
  for (let iteration = 0; iteration < 128; iteration++) {
    let changes = 0;
    for (let pass = 0; pass < 2; pass++) {
      const remove = [];
      for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
        const i = y * width + x; if (!skeleton[i]) continue;
        const p = [at(x, y - 1), at(x + 1, y - 1), at(x + 1, y), at(x + 1, y + 1), at(x, y + 1), at(x - 1, y + 1), at(x - 1, y), at(x - 1, y - 1)];
        const sum = p.reduce((a, b) => a + b, 0); if (sum < 2 || sum > 6) continue;
        let transitions = 0; for (let n = 0; n < 8; n++) if (!p[n] && p[(n + 1) % 8]) transitions++;
        if (transitions !== 1) continue;
        if (pass === 0 ? p[0] * p[2] * p[4] === 0 && p[2] * p[4] * p[6] === 0 : p[0] * p[2] * p[6] === 0 && p[0] * p[4] * p[6] === 0) remove.push(i);
      }
      remove.forEach(i => { skeleton[i] = 0; }); changes += remove.length;
    }
    if (!changes) break;
  }
  return skeleton;
}
export function linePaths(mask, image, maxStrokes, { connectJunctions = false } = {}) {
  const { width, height } = image, skeleton = thin(mask, width, height);
  const neighbors = i => {
    const x = i % width, y = Math.floor(i / width), result = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if ((!dx && !dy) || x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height) continue;
      const n = (y + dy) * width + x + dx; if (!skeleton[n]) continue;
      if (dx && dy && (skeleton[y * width + x + dx] || skeleton[(y + dy) * width + x])) continue;
      result.push(n);
    }
    return result;
  };
  const visited = new Set(), paths = [], edgeKey = (a, b) => Math.min(a, b) * skeleton.length + Math.max(a, b);
  const follow = (start, next) => {
    const path = [start]; let previous = start, current = next;
    while (true) {
      const key = edgeKey(previous, current); if (visited.has(key)) break; visited.add(key); path.push(current);
      const list = neighbors(current); if (current === start) break;
      if (!connectJunctions && list.length !== 2) break;
      const choices = list.filter(n => n !== previous && !visited.has(edgeKey(current,n)));
      if (!choices.length) break;
      const tx=current%width-previous%width,ty=Math.floor(current/width)-Math.floor(previous/width);
      const alignment=n=>{const dx=n%width-current%width,dy=Math.floor(n/width)-Math.floor(current/width);return (tx*dx+ty*dy)/Math.hypot(tx,ty)/Math.hypot(dx,dy);};
      if(choices.length>1)choices.sort((a,b)=>alignment(b)-alignment(a));
      if(connectJunctions && list.length>2 && alignment(choices[0])<0.5)break;
      const candidate = choices[0]; previous = current; current = candidate;
    }
    paths.push(path);
  };
  for (let i = 0; i < skeleton.length; i++) if (skeleton[i] && neighbors(i).length !== 2) {
    const list = neighbors(i); if (!list.length) paths.push([i]);
    for (const n of list) if (!visited.has(edgeKey(i, n))) follow(i, n);
  }
  for (let i = 0; i < skeleton.length; i++) if (skeleton[i]) for (const n of neighbors(i)) if (!visited.has(edgeKey(i, n))) follow(i, n);
  return paths.sort((a, b) => b.length - a.length).slice(0, maxStrokes).map(indices => {
    const p = simplify(indices.map(i => ({ x: i % width + 0.5, y: Math.floor(i / width) + 0.5 })), 0.4);
    const color = [0, 1, 2].map(c => indices.reduce((n, i) => n + image.rgb[i * 3 + c], 0) / indices.length);
    return { points: p, color: hex(color), size: 2.5, opacity: 100, flow: 100, hardness: 100, simulate_pressure: false, closed: false };
  });
}

export function planAnime(image, area, { paletteColors = 24, lineThreshold = 80, maxStrokes = 1200, simplifyTolerance = 0.35 } = {}) {
  const data = quantize(image, paletteColors), ratio = Math.min(area.width / image.width, area.height / image.height);
  const bounds = { x: area.x + (area.width - image.width * ratio) / 2, y: area.y + (area.height - image.height * ratio) / 2,
    width: image.width * ratio, height: image.height * ratio };
  const transform = p => ({ x: bounds.x + p.x * ratio, y: bounds.y + p.y * ratio });
  let contourCount = 0, pointCount = 0;
  const fills = data.palette.map((rgb, label) => {
    const contours = traceContours(data.labels, image.width, image.height, label, simplifyTolerance);
    contourCount += contours.length;
    const transformed = contours.map(c => { pointCount += c.points.length; return { hole: c.hole, points: c.points.map(transform) }; });
    return { color: hex(rgb), dark: luminance(rgb) < 145, contours: transformed };
  }).filter(fill => fill.contours.length);
  if (contourCount > 16000 || pointCount > 250000) throw new Error('参考图色块过于复杂，请缩小 source_bounds 或降低 detail/palette_colors');
  const mask = Uint8Array.from(data.labels, (label, i) => label >= 0 && luminance(rgbAt(image, i)) <= lineThreshold ? 1 : 0);
  const inkContours = traceContours(mask, image.width, image.height, 1, simplifyTolerance).map(c => ({ hole: c.hole, points: c.points.map(transform) }));
  const strokes = linePaths(mask, image, maxStrokes).map(s => ({ ...s, points: s.points.map(transform), size: Math.max(1, Math.min(5000, s.size * ratio)) }));
  const total = data.populations.reduce((a, b) => a + b, 0);
  return { bounds, fills, ink_contours: inkContours, strokes, stroke_count: strokes.length, contour_count: contourCount, point_count: pointCount,
    palette: data.palette.map((p, i) => ({ color: hex(p), fraction: Math.round(data.populations[i] / total * 10000) / 10000 })),
    quantization_rmse: Math.round(data.quantization_rmse * 100) / 100, sample_width: image.width, sample_height: image.height,
    transparent_fraction: Math.round((1 - total / data.labels.length) * 10000) / 10000,
    rendering: 'photoshop_native_path_fills_and_real_brush_lineart' };
}

export function analyzeReference(image, paletteColors = 24) {
  const data = quantize(image, paletteColors), visited = new Uint8Array(data.labels.length), regions = [];
  const { width, height } = image;
  for (let start = 0; start < data.labels.length; start++) {
    if (visited[start] || data.labels[start] < 0) continue;
    const label = data.labels[start], queue = [start]; visited[start] = 1;
    let minX = width, maxX = 0, minY = height, maxY = 0;
    for (let q = 0; q < queue.length; q++) {
      const i = queue[q], x = i % width, y = Math.floor(i / width); minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      const next = []; if (x) next.push(i - 1); if (x + 1 < width) next.push(i + 1); if (y) next.push(i - width); if (y + 1 < height) next.push(i + width);
      for (const n of next) if (!visited[n] && data.labels[n] === label) { visited[n] = 1; queue.push(n); }
    }
    const seed = queue[Math.floor(queue.length / 2)];
    regions.push({ color: hex(data.palette[label]), pixels: queue.length, sampled_bounds: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }, sampled_seed: { x: seed % width + 0.5, y: Math.floor(seed / width) + 0.5 } });
  }
  const crop = image.source_bounds || { x: 0, y: 0, width: image.source_width || width, height: image.source_height || height };
  const mapped = regions.sort((a, b) => b.pixels - a.pixels).slice(0, 24).map((region, i) => ({ region_id: i + 1, color: region.color, fraction: Math.round(region.pixels / data.labels.length * 10000) / 10000,
    source_bounds: { x: crop.x + region.sampled_bounds.x / width * crop.width, y: crop.y + region.sampled_bounds.y / height * crop.height,
      width: region.sampled_bounds.width / width * crop.width, height: region.sampled_bounds.height / height * crop.height },
    source_seed: { x: crop.x + region.sampled_seed.x / width * crop.width, y: crop.y + region.sampled_seed.y / height * crop.height } }));
  return { source_width: image.source_width || width, source_height: image.source_height || height, source_bounds: crop,
    sampled_width: width, sampled_height: height, regions: mapped,
    palette: data.palette.map((p, i) => ({ color: hex(p), pixels: data.populations[i] })),
    note: '区域依据颜色连通性编号，没有头发、眼睛等语义标签。source_seed 是参考图坐标；用于目标文档前必须确认尺寸和位置映射。' };
}
