# Antigravity 简体中文汉化

为 **Antigravity 2.17.0** 提供简体中文界面，覆盖主界面、设置、系统菜单与托盘菜单，并支持 VS Code 中的 Antigravity 扩展（`google.google-antigravity`）。适用于 Windows 和 macOS。

**[下载最新汉化包](https://github.com/yuanhhs/antigravity-chinese/releases/latest)**

## 准备

- 安装 [Node.js LTS](https://nodejs.org/)（自带 npm）。
- 首次安装需联网，用于获取打包工具。

## 安装

1. 下载并解压 `2.17.0.zip`。
2. 运行双击脚本。安装时会结束正在运行的 Antigravity，请先保存工作。
   - Windows：`双击运行中文汉化工具.bat`
   - macOS：`双击运行中文汉化工具.command`（会请求管理员密码）
3. 输入选项并回车：

   | 选项 | 操作 |
   | --- | --- |
   | `1`（默认） | 安装桌面版汉化 |
   | `2` | 卸载桌面版汉化 |
   | `3` | 安装 VS Code 插件汉化 |
   | `4` | 卸载 VS Code 插件汉化 |
   | `5` | 同时安装桌面版与插件汉化 |

4. 让汉化生效：桌面版重新打开 Antigravity；插件在 VS Code 中执行 `Developer: Reload Window`。

首次安装会备份原始文件：桌面版为 `app.asar.bak`，插件为 `extension.js` 与 `package.json`。卸载即从备份还原。

## 更新

Antigravity 或插件升级后，官方文件会覆盖汉化。下载适配新版本的汉化包，重新安装即可。

## 命令行

在汉化包目录运行：

```bash
node localization_engine.js                           # 安装桌面版汉化
node localization_engine.js --huifu                   # 卸载桌面版汉化
node tools/localize_vscode_extension.js               # 安装插件汉化（默认最新安装的版本）
node tools/localize_vscode_extension.js --uninstall   # 卸载插件汉化
node tools/localize_both.js                           # 同时安装桌面版与插件汉化
```

| 参数 | 适用命令 | 说明 |
| --- | --- | --- |
| `--install-dir "路径"` | 桌面版、同时安装 | 指定 Antigravity 安装目录，自动探测失败时使用 |
| `--extension-dir "路径"` | 插件、同时安装 | 指定插件版本目录或自定义扩展目录 |
| `--no-kill` | 桌面版、同时安装 | 不自动结束 Antigravity 进程 |

macOS 上修改 `/Applications` 需要管理员权限，工具会自动通过 `sudo` 提权，并对应用做本地 ad-hoc 重签名。

## VS Code 插件汉化说明

插件汉化会翻译命令、设置说明，以及插件侧栏从本机 `agy --hub` 加载的界面。侧栏通过一个仅监听本机回环地址的代理翻译 `/main.js`，其余请求原样转发给插件自带的 AGY 服务。

远程 VS Code 会话若连接的是非本机 AGY 服务，侧栏界面暂不汉化。

## 补充翻译

1. 保持 Antigravity 运行，提取未翻译文案：

   ```bash
   node tools/extract_src_strings.js
   ```

   待翻清单生成在 `temps/pending_<版本号>.json`，同名 `.context.json` 提供源码语境。
2. 将译文补入 `dicts_src/`，保留 `${0}` 等动态参数。原生菜单、托盘、加载页与更新弹窗的译文在 `locales/zh-CN.json`。
3. 校验并运行测试：

   ```bash
   node tools/validate_translations.js
   node --test tests/*.test.js
   ```

4. 重新安装汉化。桌面版与插件都读取 `dicts_src/`，改动后需分别重装。

用词与词条格式见[翻译维护约定](docs/translation-style.md)。

## 常见问题

- **找不到 Node.js 或解包失败**：确认已安装 Node.js 与 npm，且网络可访问 npm。
- **文件占用或权限不足**：完全退出 Antigravity；Windows 可尝试以管理员身份运行脚本。
- **macOS 提示脚本无法执行**：在汉化包目录运行 `chmod +x *.command`。
- **菜单已是中文，主界面仍为英文**：关闭开发者工具后重启 Antigravity，在应用日志中查看 `[agy-zh]` 开头的信息。
- **插件侧栏仍为英文**：确认已执行 `Developer: Reload Window`；插件升级后需重新安装插件汉化。

## 许可证

[MIT](LICENSE)。使用 [Acorn](https://github.com/acornjs/acorn) 解析前端源码，并为公式、Markdown 等渲染库设置翻译保护区，避免破坏渲染结果。
