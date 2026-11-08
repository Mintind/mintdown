import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const tokens = new Map([...readFileSync(resolve(root, 'src/styles/typography.css'), 'utf8')
  .matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]));
const value = name => {
  const actual = tokens.get(name);
  if (!actual) throw Error(`Missing typography token: ${name}`);
  return `\`${name}\` (${actual})`;
};
const rows = [
  ['顶部菜单项', '--font-ui', '--font-size-ui-md', '--font-weight-ui-normal', '--line-height-ui-menu'],
  ['标签右键菜单项', '--font-ui', '--font-size-ui-md', '--font-weight-ui-normal', '--line-height-ui-menu'],
  ['文档标签', '--font-ui', '--font-size-tab', '--font-weight-ui-normal', '--line-height-ui-menu'],
  ['大纲标题与条目', '--font-ui', '--font-size-ui-md', '--font-weight-ui-normal', '--line-height-ui-menu'],
  ['设置内容', '--font-ui', '--font-size-ui-lg', '--font-weight-ui-normal', '--line-height-ui-menu'],
  ['操作弹窗', '--font-ui', '--font-size-ui-md', '--font-weight-ui-normal', '--line-height-ui-dialog'],
  ['状态栏', '--font-ui', '--font-size-ui-xs', '--font-weight-ui-normal', '--line-height-ui-menu'],
  ['可视正文', '--font-editor', '--font-size-editor-default', '--font-weight-ui-normal', '--line-height-editor-visual'],
  ['源码正文', '--font-code', '--font-size-editor-default', '--font-weight-ui-normal', '--line-height-editor-source'],
  ['H1', '--font-editor', '--font-scale-h1', '--font-weight-editor-bold', '--line-height-editor-heading'],
  ['H2', '--font-editor', '--font-scale-h2', '--font-weight-editor-bold', '--line-height-editor-heading'],
  ['H3', '--font-editor', '--font-scale-h3', '--font-weight-editor-bold', '--line-height-editor-heading'],
  ['H4', '--font-editor', '--font-scale-h4', '--font-weight-editor-bold', '--line-height-editor-heading'],
  ['H5', '--font-editor', '--font-scale-h5', '--font-weight-editor-heavy', '--line-height-editor-heading'],
  ['H6', '--font-editor', '--font-scale-h6', '--font-weight-ui-emphasis', '--line-height-editor-heading'],
  ['行内代码', '--font-code', '--font-size-editor-default', '--font-weight-ui-normal', '--line-height-editor-visual'],
  ['可视代码行', '--font-code', '--font-scale-table-code', '--font-weight-ui-normal', '--line-height-editor-visual'],
];
const table = rows.map(([component, family, size, weight, height]) =>
  `| ${component} | ${value(family)} | ${value(size)} | ${value(weight)} | ${value(height)} |`).join('\n');
const document = `# Mintdown 字体规范\n\n本表由 [\`src/styles/typography.css\`](../src/styles/typography.css) 生成，数值为当前样式的配置值。运行 \`node scripts/typography-doc.mjs --write\` 更新，运行 \`node scripts/typography-doc.mjs --check\` 检查同步。\n\n| 组件 | 字体变量 | 字号或比例 | 字重 | 行高 |\n| --- | --- | --- | --- | --- |\n${table}\n\nMarkdown 正文字号由用户偏好 \`--editor-font-size\` 覆盖上表中的默认值；标题比例相对于正文计算。旧版 Milkdown 源码编辑器使用正文设置减 1px，当前 CodeMirror 编辑器使用正文设置值。代码高亮颜色来自主题变量与 Shiki，不在字体文件中。\n\n配色单独维护于 [\`src/styles/theme-colors.css\`](../src/styles/theme-colors.css)。\n`;
const target = resolve(root, 'docs/TYPOGRAPHY.md');
if (process.argv[2] === '--write') writeFileSync(target, document);
else if (process.argv[2] === '--check') {
  if (readFileSync(target, 'utf8') !== document) throw Error('docs/TYPOGRAPHY.md is out of sync; run --write');
} else throw Error('Usage: node scripts/typography-doc.mjs --write|--check');
