# Mintdown 主题颜色

此表由 `src/styles/theme-colors.css` 生成。修改颜色后运行 `node scripts/generate-theme-colors.mjs`；CI/本地可用 `--check` 检查同步。

| 用途 | CSS 变量 | Mint Light | Tokyo Night Storm |
| --- | --- | --- | --- |
| 正文背景 | `--page` | `#f8faf8` | `#24283b` |
| 侧栏、菜单、弹窗背景 | `--surface` | `#f0f5f2` | `#1f2335` |
| 正文文字 | `--text` | `#34413f` | `#c0caf5` |
| 标题 | `--heading` | `#223431` | `#ced7e6` |
| 编辑中标题 | `--heading-inline` | `#223431` | `#ced7e6` |
| 次级标题 | `--heading-secondary` | `#223431` | `#ced7e6` |
| 低级标题 | `--heading-tertiary` | `#223431` | `#ced7e6` |
| 辅助文字 | `--muted` | `#63746f` | `#a9b1c6` |
| 通用边框 | `--border` | `#dce8e1` | `#414868` |
| 交互强调与键盘焦点 | `--accent` | `#187968` | `#7aa2f7` |
| 柔和强调背景 | `--accent-soft` | `#dbeee6` | `#303e60` |
| 大纲当前项混合底色（75%） | `--outline-active` | `#dbeee6` | `#364568` |
| 大纲与标签悬停 | `--outline-hover` | `#eaf1ed` | `#30384d` |
| 插入光标 | `--editor-caret` | `#34413f` | `#7aa2f7` |
| 链接与 URL | `--link` | `#257b6a` | `#89b4fa` |
| 链接悬停 | `--link-hover` | `#176b5a` | `#a9c9ff` |
| 已访问链接 | `--link-visited` | `#496d78` | `#a9b8e7` |
| 拼写提示 | `--spelling` | `#ba625c` | `#d5a3a0` |
| 聚焦选区 | `--selection` | `#cbded7` | `#354d73` |
| 失焦选区 | `--selection-inactive` | `#dfeae5` | `#354d73` |
| 代码背景 | `--code` | `#edf4ef` | `#292e42` |
| 引用文字 | `--quote` | `#637c70` | `#aebbd0` |
| 引用边框 | `--quote-border` | `#dce8e1` | `#53617e` |
| 表格表头 | `--table-head` | `#f0f5f2` | `#343d54` |
| 表格主体 | `--table-body` | `transparent` | `#292f43` |
| 表头文字 | `--table-head-text` | `#34413f` | `#d7e0ea` |
| 表格边框 | `--table-border` | `#dce8e1` | `#414868` |
| Front Matter 背景 | `--frontmatter-background` | `#eaf3ed` | `#292d3e` |
| YAML 键名 | `--frontmatter-key` | `#586862` | `#b5c0d5` |
| YAML 标记 | `--frontmatter-syntax` | `#7b8a84` | `#929db7` |
| 源码关键字 | `--syntax-keyword` | `#8250df` | `#bcb2d2` |
| 源码字符串 | `--syntax-string` | `#0a7b32` | `#aac9b6` |
| 源码注释 | `--syntax-comment` | `#6e7781` | `#97a7bb` |
| 源码数字 | `--syntax-number` | `#b35c16` | `#c6bba9` |
| 源码函数 | `--syntax-function` | `#0550ae` | `#a8c8d6` |
| 源码类型 | `--syntax-type` | `#953800` | `#b7bfd9` |
| 错误背景 | `--error-bg` | `#ae34261a` | `#ae34261a` |
| 错误文字 | `--error-text` | `#a63129` | `#f0a49e` |
| 浅阴影 | `--shadow-soft` | `#0002` | `#0002` |
| 深阴影 | `--shadow-strong` | `#0003` | `#0003` |
| 弹窗遮罩 | `--dialog-backdrop` | `#0007` | `#0007` |
| 主按钮背景 | `--button-primary-bg` | `#d4ece4` | `#394c74` |
| 主按钮文字 | `--button-primary-text` | `#125b4e` | `#e3ebf7` |
| 主按钮边框 | `--button-primary-border` | `#a4cec1` | `#60749d` |
| 主按钮悬停 | `--button-primary-hover` | `#c4e3d8` | `#455b87` |
| 主按钮按下 | `--button-primary-active` | `#b6d9cc` | `#324264` |

应用布局 CSS、CodeMirror Markdown 着色、ProseMirror 自定义样式均引用上述语义变量。Shiki 围栏代码的词法配色由 `shiki` 的 `github-light` 与 `tokyo-night` 主题提供（见 `src/editor/syntaxHighlight.ts`），未纳入 Mintdown 的 UI 色板。
