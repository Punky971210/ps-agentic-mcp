import path from 'node:path';
import { homedir } from 'node:os';

export const name = 'ps-anime-preview-mode-policy';
export const inject = ['tools', 'systemPrompt'];

export function apply(ctx) {
  ctx.tools.presentAs('native');
  const output = path.join(homedir(), 'Desktop', 'PS作品');
  ctx.systemPrompt.section({ name: 'ps-anime-preview:output', order: 171,
    text: `PS 绘图模式的默认交付目录是 ${output}。用户明确指定其他目录时遵从用户。保存时使用实际文件名和绝对路径；PSD 保留图层，PNG 便于预览。` });

  // Hide inherited host tools only in this preset. Preset-local tools remain available.
  let signature = '', release;
  const update = () => {
    const names = ctx.root.tools.sdkSchemas().map(tool => tool.name).filter(n => n !== 'run_code').sort();
    const next = names.join('\n');
    if (next === signature) return;
    signature = next;
    const previous = release;
    release = names.length ? ctx.tools.restrict({ deny: names }) : undefined;
    previous?.();
  };
  ctx.on('tools/change', update);
  ctx.effect(() => () => release?.());
  update();
}
