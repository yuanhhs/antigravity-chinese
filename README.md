# Antigravity 简体中文汉化

适配 **Antigravity 2.17.0**，提供界面、设置、系统菜单和托盘菜单的简体中文翻译。支持 Windows 和 macOS，需安装 [Node.js LTS](https://nodejs.org/)（含 npm）。

[下载汉化包](https://github.com/yuanhhs/antigravity-chinese/releases/latest)

## 安装

1. 下载 `2.17.0.zip` 并解压。
2. 完全退出 Antigravity。
3. Windows 运行 `双击运行中文汉化工具.bat`；macOS 运行 `双击运行中文汉化工具.command`。
4. 选择 `1` 安装，完成后重新打开软件。

安装时自动备份原始程序包。首次安装需联网获取打包工具；macOS 脚本会请求管理员密码。

## 卸载与更新

- **卸载汉化**：退出软件，运行同一脚本，选择 `2`，从备份还原。
- **软件更新后**：下载适配新版本的汉化包，重新安装。
- **修改翻译后**：重新安装汉化并重启软件。

## 命令行

在汉化包目录运行：

```bash
node localization_engine.js                         # 安装
node localization_engine.js --install-dir "安装路径" # 指定路径
node localization_engine.js --huifu                 # 卸载
```

## 补充翻译

词库位于 `dicts_src/`。保持 Antigravity 运行，执行：

```bash
node tools/extract_src_strings.js
```

工具会在 `temps/pending_<版本号>.json` 生成待翻清单，同名 `.context.json` 提供源码语境。保留 `${0}` 等动态参数，补充词条后运行 `node tools/validate_translations.js` 校验，再重新安装汉化。原生菜单译文位于 `locales/zh-CN.json`，详见[翻译维护约定](docs/translation-style.md)。

## 常见问题

- **找不到 Node.js 或解包失败**：确认已安装 Node.js/npm，且网络可访问 npm。
- **文件占用或权限不足**：完全退出 Antigravity；Windows 可尝试以管理员身份运行脚本。
- **macOS 脚本无法执行**：在汉化包目录运行 `chmod +x *.command`。
- **菜单已中文、主界面仍英文**：关闭开发者工具后重启，查看应用日志中的 `[agy-zh]` 信息。

## 许可证

[MIT](LICENSE)。使用 [Acorn](https://github.com/acornjs/acorn) 解析前端源码，并对公式、Markdown 等渲染库设置翻译保护区。
