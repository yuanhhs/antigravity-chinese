# Antigravity 汉化工具（macOS App）

解压 `v<版本号>.app.zip` 后，双击同名版本的 `.app`，例如 **v2.19.1.app**。应用会打开终端操作菜单，操作方式与 Windows EXE 相同：

| 选项 | 操作 |
| --- | --- |
| 1（默认） | 安装桌面版汉化 |
| 2 | 卸载桌面版汉化 |
| 3 | 安装 VS Code 插件汉化 |
| 4 | 卸载 VS Code 插件汉化 |
| 5 | 同时安装桌面版与插件汉化 |

适用于 macOS 12 及以上的 Apple Silicon 和 Intel Mac。运行前需安装 [Node.js LTS](https://nodejs.org/)（含 npm）；首次安装汉化需要联网获取打包工具。

桌面版默认安装位置为 `/Applications/Antigravity.app`。安装时会请求管理员密码并关闭 Antigravity，请先保存工作。终端输入密码时不显示字符，输入后按回车即可。

安装完成后重新打开 Antigravity；插件汉化完成后，在 VS Code 中执行 `Developer: Reload Window`。工具会保留官方备份，卸载时可还原。

应用包含与 Windows 版相同的词库及安装引擎，提供 Intel 与 Apple Silicon 通用启动器。此包未经 Apple Developer ID 签名或公证；当前构建及校验在 Windows 完成，尚未进行 macOS 实机安装验证。

维护者可用 `python tools/build_macos.py 2.19.1` 重新打包，构建机需安装 Python 3.9+ 与 Go 1.26+。
