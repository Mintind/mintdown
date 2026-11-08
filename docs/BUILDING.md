# 构建与测试

## Windows x64 环境

- Git，Node.js 22.12 或更高版本及 npm。
- Rust stable `x86_64-pc-windows-msvc` 工具链。
- Visual Studio 2022 Build Tools：“使用 C++ 的桌面开发”及 Windows SDK。
- Microsoft Edge WebView2 运行时。

依赖安装和首次构建需要访问 npm、crates.io 及 Tauri 的官方构建工具下载地址。使用锁文件安装，不需要个人目录、私有 registry、恢复快照或额外本地配置。

```powershell
git clone https://github.com/Mintind/mintdown.git
cd mintdown
# 如需构建指定版本：git checkout v0.4.1
npm.cmd ci
npm.cmd run desktop
```

开发模式运行 Vite 本地服务器；正式安装版不需要本地服务器。开发身份与正式安装版隔离，不共享用户会话或单实例锁。

## 构建

```powershell
# 前端类型检查与生产构建
npm.cmd run build
# Windows x64 NSIS 安装包
npm.cmd run build:windows
```

安装包输出到 `artifacts/windows/<version>/`，构建来源记录在同目录的 `build-info.json` 和 `SHA256.json`。构建不会执行安装、卸载或修改 Windows 文件关联。

请在 Git checkout 中构建，以便记录准确的源码 commit；自动下载的 ZIP 可用于查看源码，但构建来源验证需要 Git 历史。

## 自动测试

```powershell
npm.cmd test -- --maxWorkers=1
cargo test --manifest-path src-tauri/Cargo.toml --locked -- --test-threads=1
```

前端测试使用合成文档和临时目录，不等同于 Windows 原生交互的人工验收。

安全的隐藏 WebView2 视觉回归使用独立测试程序：

```powershell
$env:VITE_NATIVE_TEST='1'
$env:CARGO_TARGET_DIR=Join-Path (Get-Location) 'src-tauri/target/interaction-isolated'
npm.cmd exec -- tauri build --debug --no-bundle --features native-test --config src-tauri/tauri.native-test.conf.json
Remove-Item Env:VITE_NATIVE_TEST
Remove-Item Env:CARGO_TARGET_DIR
npm.cmd run test:visual
```

测试只操作它创建的隔离窗口，不使用系统进程清理、监控或强制结束流程。视觉预期只可在需求明确改变时更新；测试自身不会重录基准。

## 配置入口

- 颜色：`src/styles/theme-colors.css`，对应 [颜色表](THEME_COLORS.md)。
- 字体：`src/styles/typography.css`，对应 [字体规范](TYPOGRAPHY.md)。
- 导出样式：`src/styles/export-document.css`。
- 发布源文件清单：`scripts/public-source-files.json`，排除缓存、个人数据和测试产物。

没有配置自动发布或在线更新服务。Windows 安装包与校验文件通过 GitHub Releases 提供。
