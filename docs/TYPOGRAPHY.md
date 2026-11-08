# Mintdown 字体规范

本表由 [`src/styles/typography.css`](../src/styles/typography.css) 生成，数值为当前样式的配置值。运行 `node scripts/typography-doc.mjs --write` 更新，运行 `node scripts/typography-doc.mjs --check` 检查同步。

| 组件 | 字体变量 | 字号或比例 | 字重 | 行高 |
| --- | --- | --- | --- | --- |
| 顶部菜单项 | `--font-ui` ("Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif) | `--font-size-ui-md` (13px) | `--font-weight-ui-normal` (400) | `--line-height-ui-menu` (normal) |
| 标签右键菜单项 | `--font-ui` ("Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif) | `--font-size-ui-md` (13px) | `--font-weight-ui-normal` (400) | `--line-height-ui-menu` (normal) |
| 文档标签 | `--font-ui` ("Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif) | `--font-size-tab` (16px) | `--font-weight-ui-normal` (400) | `--line-height-ui-menu` (normal) |
| 大纲标题与条目 | `--font-ui` ("Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif) | `--font-size-ui-md` (13px) | `--font-weight-ui-normal` (400) | `--line-height-ui-menu` (normal) |
| 设置内容 | `--font-ui` ("Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif) | `--font-size-ui-lg` (14px) | `--font-weight-ui-normal` (400) | `--line-height-ui-menu` (normal) |
| 操作弹窗 | `--font-ui` ("Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif) | `--font-size-ui-md` (13px) | `--font-weight-ui-normal` (400) | `--line-height-ui-dialog` (1.5) |
| 状态栏 | `--font-ui` ("Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif) | `--font-size-ui-xs` (11px) | `--font-weight-ui-normal` (400) | `--line-height-ui-menu` (normal) |
| 可视正文 | `--font-editor` ("Microsoft YaHei UI", "Segoe UI", sans-serif) | `--font-size-editor-default` (18px) | `--font-weight-ui-normal` (400) | `--line-height-editor-visual` (1.55) |
| 源码正文 | `--font-code` (Consolas, "Cascadia Code", monospace) | `--font-size-editor-default` (18px) | `--font-weight-ui-normal` (400) | `--line-height-editor-source` (1.65) |
| H1 | `--font-editor` ("Microsoft YaHei UI", "Segoe UI", sans-serif) | `--font-scale-h1` (1.67em) | `--font-weight-editor-bold` (700) | `--line-height-editor-heading` (1.35) |
| H2 | `--font-editor` ("Microsoft YaHei UI", "Segoe UI", sans-serif) | `--font-scale-h2` (1.44em) | `--font-weight-editor-bold` (700) | `--line-height-editor-heading` (1.35) |
| H3 | `--font-editor` ("Microsoft YaHei UI", "Segoe UI", sans-serif) | `--font-scale-h3` (1.28em) | `--font-weight-editor-bold` (700) | `--line-height-editor-heading` (1.35) |
| H4 | `--font-editor` ("Microsoft YaHei UI", "Segoe UI", sans-serif) | `--font-scale-h4` (1.11em) | `--font-weight-editor-bold` (700) | `--line-height-editor-heading` (1.35) |
| H5 | `--font-editor` ("Microsoft YaHei UI", "Segoe UI", sans-serif) | `--font-scale-h5` (1em) | `--font-weight-editor-heavy` (750) | `--line-height-editor-heading` (1.35) |
| H6 | `--font-editor` ("Microsoft YaHei UI", "Segoe UI", sans-serif) | `--font-scale-h6` (1em) | `--font-weight-ui-emphasis` (650) | `--line-height-editor-heading` (1.35) |
| 行内代码 | `--font-code` (Consolas, "Cascadia Code", monospace) | `--font-size-editor-default` (18px) | `--font-weight-ui-normal` (400) | `--line-height-editor-visual` (1.55) |
| 可视代码行 | `--font-code` (Consolas, "Cascadia Code", monospace) | `--font-scale-table-code` (.9em) | `--font-weight-ui-normal` (400) | `--line-height-editor-visual` (1.55) |

Markdown 正文字号由用户偏好 `--editor-font-size` 覆盖上表中的默认值；标题比例相对于正文计算。旧版 Milkdown 源码编辑器使用正文设置减 1px，当前 CodeMirror 编辑器使用正文设置值。代码高亮颜色来自主题变量与 Shiki，不在字体文件中。

配色单独维护于 [`src/styles/theme-colors.css`](../src/styles/theme-colors.css)。
