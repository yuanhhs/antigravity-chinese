#!/bin/bash
cd "$(dirname "$0")"

echo "====== Antigravity 中文汉化工具 (macOS) ======"
echo "请选择要执行的操作："
echo "[1] 安装 Antigravity 桌面版汉化"
echo "[2] 卸载 Antigravity 桌面版汉化"
echo "[3] 安装 VS Code 插件汉化"
echo "[4] 卸载 VS Code 插件汉化"
printf "请输入 1/2/3/4，直接回车默认 1："
read -r ACTION
ACTION="${ACTION:-1}"

case "$ACTION" in
    1|2)
        NODE_BIN="$(command -v node)"
        if [ -z "$NODE_BIN" ]; then
            echo "未找到 Node.js，请先安装 Node.js。"
            exit 1
        fi
        if [ "$ACTION" = "2" ]; then
            echo "正在还原 Antigravity 桌面版..."
            APP_ARGS=(--huifu --install-dir /Applications/Antigravity.app)
        else
            echo "正在安装 Antigravity 桌面版汉化..."
            APP_ARGS=(--install-dir /Applications/Antigravity.app)
        fi
        if [ "$EUID" -ne 0 ]; then
            echo "修改 /Applications 中的程序需要管理员密码。"
            sudo "$NODE_BIN" localization_engine.js "${APP_ARGS[@]}" "$@"
        else
            "$NODE_BIN" localization_engine.js "${APP_ARGS[@]}" "$@"
        fi
        ;;
    3)
        echo "正在安装 VS Code 插件汉化..."
        node tools/localize_vscode_extension.js "$@"
        ;;
    4)
        echo "正在卸载 VS Code 插件汉化..."
        node tools/localize_vscode_extension.js --uninstall "$@"
        ;;
    *)
        echo "无效选项：$ACTION"
        exit 1
        ;;
esac

if [ $? -ne 0 ]; then
    echo ""
    echo "运行失败！请检查上方错误信息。"
    read -n 1 -s
    exit 1
fi

echo ""
echo "处理完成。窗口将在 5 秒后自动关闭（或按任意键立即关闭）..."
read -t 5 -n 1 -s
