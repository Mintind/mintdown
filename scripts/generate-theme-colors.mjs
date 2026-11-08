import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(resolve(project, 'src/styles/theme-colors.css'), 'utf8');
const blocks = [...source.matchAll(/:root(\[data-theme="dark"\])?\s*\{([^}]*)\}/g)];
if (blocks.length !== 2) throw new Error('Expected Mint Light and Tokyo Night color blocks');
const parse = (body) => Object.fromEntries([...body.matchAll(/(--[a-z-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]));
const light = parse(blocks[0][2]);
const dark = { ...light, ...parse(blocks[1][2]) };
const resolveColor = (name, colors, seen = new Set()) => {
  if (seen.has(name)) throw new Error(`Cyclic theme variable ${name}`);
  const raw = colors[name];
  if (!raw) throw new Error(`Missing theme variable ${name}`);
  const next = new Set(seen); next.add(name);
  return raw.replace(/var\((--[a-z-]+)\)/g, (_, referenced) => resolveColor(referenced, colors, next));
};
const labels = {
  '--page': '正文背景', '--surface': '侧栏、菜单、弹窗背景', '--text': '正文文字', '--heading': '标题',
  '--heading-inline': '编辑中标题', '--heading-secondary': '次级标题', '--heading-tertiary': '低级标题',
  '--muted': '辅助文字', '--border': '通用边框', '--accent': '交互强调与键盘焦点',
  '--accent-soft': '柔和强调背景', '--outline-active': '大纲当前项混合底色（75%）', '--outline-hover': '大纲与标签悬停',
  '--editor-caret': '插入光标', '--link': '链接与 URL', '--link-hover': '链接悬停',
  '--link-visited': '已访问链接', '--spelling': '拼写提示', '--selection': '聚焦选区',
  '--selection-inactive': '失焦选区', '--code': '代码背景', '--quote': '引用文字',
  '--quote-border': '引用边框', '--table-head': '表格表头', '--table-body': '表格主体',
  '--table-head-text': '表头文字', '--table-border': '表格边框',
  '--frontmatter-background': 'Front Matter 背景', '--frontmatter-key': 'YAML 键名',
  '--frontmatter-syntax': 'YAML 标记', '--syntax-keyword': '源码关键字',
  '--syntax-string': '源码字符串', '--syntax-comment': '源码注释', '--syntax-number': '源码数字',
  '--syntax-function': '源码函数', '--syntax-type': '源码类型', '--error-bg': '错误背景',
  '--error-text': '错误文字', '--shadow-soft': '浅阴影', '--shadow-strong': '深阴影',
  '--dialog-backdrop': '弹窗遮罩', '--button-primary-bg': '主按钮背景',
  '--button-primary-text': '主按钮文字', '--button-primary-border': '主按钮边框',
  '--button-primary-hover': '主按钮悬停', '--button-primary-active': '主按钮按下',
};
const names = Object.keys(light);
for (const name of names) if (!labels[name]) throw new Error(`Add a label for ${name}`);
for (const name of Object.keys(dark)) if (!light[name]) throw new Error(`Missing light value for ${name}`);
const rows = names.map((name) => `| ${labels[name]} | \`${name}\` | \`${resolveColor(name, light)}\` | \`${resolveColor(name, dark)}\` |`);
const document = `# Mintdown 主题颜色\n\n此表由 \`src/styles/theme-colors.css\` 生成。修改颜色后运行 \`node scripts/generate-theme-colors.mjs\`；CI/本地可用 \`--check\` 检查同步。\n\n| 用途 | CSS 变量 | Mint Light | Tokyo Night Storm |\n| --- | --- | --- | --- |\n${rows.join('\n')}\n\n应用布局 CSS、CodeMirror Markdown 着色、ProseMirror 自定义样式均引用上述语义变量。Shiki 围栏代码的词法配色由 \`shiki\` 的 \`github-light\` 与 \`tokyo-night\` 主题提供（见 \`src/editor/syntaxHighlight.ts\`），未纳入 Mintdown 的 UI 色板。\n`;
const target = resolve(project, 'docs/THEME_COLORS.md');
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== document) throw new Error('docs/THEME_COLORS.md is out of date');
} else writeFileSync(target, document);
