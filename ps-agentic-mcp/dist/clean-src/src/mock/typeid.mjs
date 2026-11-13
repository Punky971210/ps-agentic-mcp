/**
 * ExtendScript type-ID 模拟。
 *
 * charIDToTypeID 在真实 ExtendScript 里是纯粹的字节打包：
 *   4 字符 ASCII -> (c0<<24) | (c1<<16) | (c2<<8) | c3  (有符号 32 位)
 * 例如 'HstS' -> 0x48737453 = 1215857235
 * 因此可以精确复现，断言时能比对真实数值。
 *
 * stringIDToTypeID 真实实现是查 Adobe 内部字符串表，无法复现；
 * 这里用稳定哈希，保证「同一个字符串永远同一个 ID」，足够做分支与断言的依据。
 */

const charCache = new Map();
const stringCache = new Map();
let stringSeq = 0x40000000; // 与 charID 值域错开，便于区分

export function charIDToTypeID(s) {
  const key = String(s);
  if (charCache.has(key)) return charCache.get(key);
  if (key.length === 0) return 0;
  // Adobe 允许 1-4 字符；不足 4 位右侧补空格
  const padded = (key + '    ').slice(0, 4);
  const v =
    ((padded.charCodeAt(0) & 0xff) << 24) |
    ((padded.charCodeAt(1) & 0xff) << 16) |
    ((padded.charCodeAt(2) & 0xff) << 8) |
    (padded.charCodeAt(3) & 0xff);
  const signed = v | 0;
  charCache.set(key, signed);
  return signed;
}

export function stringIDToTypeID(s) {
  const key = String(s);
  if (stringCache.has(key)) return stringCache.get(key);
  const id = stringSeq++;
  stringCache.set(key, id);
  return id;
}

/** 反向查表：把一个 ID 还原成可读字符串，供断言失败时输出。 */
export function describeTypeID(id) {
  for (const [k, v] of charCache) if (v === id) return `'${k}'`;
  for (const [k, v] of stringCache) if (v === id) return `"${k}"`;
  return String(id);
}

export function resetTypeIDCache() {
  charCache.clear();
  stringCache.clear();
  stringSeq = 0x40000000;
}
