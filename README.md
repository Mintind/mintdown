# Mintdown

简洁、离线运行的 Windows Markdown 桌面编辑器。

## 主要功能

- 可视编辑与完整源码模式，支持光标驱动的局部 Markdown 源码编辑。
- 多标签、大纲导航、查找替换、会话恢复与未保存内容恢复快照。
- GFM 表格、代码高亮、数学公式和可直接编辑的 YAML Front Matter。
- 本地图片归档、缺失图片重新定位、文档与图片资源联动。
- 独立 HTML / PDF 导出，PDF 支持标题书签。
- Mint Light / Tokyo Night 主题及标准 / 紧凑界面密度。

## Windows 安装

1. 前往 [GitHub Releases](https://github.com/Mintind/mintdown/releases)，下载所需版本的 `Mintdown_<version>_x64-setup.exe` 和 `SHA256SUMS.txt`。
2. 使用 PowerShell 的 `Get-FileHash .\Mintdown_<version>_x64-setup.exe -Algorithm SHA256` 核对校验值。
3. 运行安装向导，选择安装目录，然后从开始菜单启动 Mintdown。

支持 Windows 10 / 11 x64，需要 Microsoft Edge WebView2 运行时。安装包包含运行时引导程序，系统缺少 WebView2 时可能需要联网下载。安装后无需 Node.js、Rust 或其他开发工具。

当前安装包**未签名**，Windows 可能显示“发布者未知”提示，请核对下载来源和校验值。

## 基本使用

- `Ctrl+O` 打开，`Ctrl+S` 保存，`Ctrl+Shift+S` 另存为。
- `Ctrl+/` 切换可视 / 源码模式，`Ctrl+F` 查找，`Ctrl+H` 替换。
- `Ctrl+Tab` 切换文档，`Ctrl+W` 关闭当前标签，`Ctrl+,` 打开偏好设置。
- 标签右键菜单提供另存为、重命名或移动、图片重新定位和导出等操作。

## 从源码构建

准备 Git、Node.js 22.12+（含 npm）、Rust stable MSVC、Visual Studio 2022 C++ Build Tools（含 Windows SDK）及 WebView2。

```powershell
git clone https://github.com/Mintind/mintdown.git
cd mintdown
npm.cmd ci
npm.cmd run desktop
```

构建 Windows x64 安装包：

```powershell
npm.cmd run build:windows
```

安装包位于 `artifacts/windows/<version>/`。更多命令见 [构建与测试](docs/BUILDING.md)。

## 许可与版权

Mintdown 自身源码的许可证尚未指定；公开源码不代表授予开源许可。第三方组件遵循各自许可，见 [版权说明](COPYRIGHT.md) 和 [第三方声明](third-party/THIRD_PARTY_NOTICES.txt)。
