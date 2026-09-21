@echo off
title Antigravity 中文汉化工具

echo.
echo ====== Antigravity 中文汉化工具 ======
echo.
echo 请选择要执行的操作：
echo [1] 安装中文汉化（推荐）
echo [2] 卸载汉化，还原官方英文
set "ACTION=1"
set /p "ACTION=请选择 [1/2] (直接按 Enter 默认为 1): "
if "%ACTION%"=="2" goto :restore

:install
echo.
echo [1/2] 正在注入汉化...
node "%~dp0localization_engine.js" %*
if %errorlevel% neq 0 goto :fail

echo.
echo [2/2] 注入完成！
echo.
echo 提示：汉化已成功安装。
goto :done

:restore
echo.
echo [1/2] 正在还原官方文件...
node "%~dp0localization_engine.js" --huifu %*
if %errorlevel% neq 0 goto :fail

echo.
echo [2/2] 还原完成！
echo.
echo 提示：Antigravity 已恢复至官方原版状态。
goto :done

:fail
echo.
echo [×] 操作失败，请检查上方错误信息。
pause
exit /b 1

:done
echo.
echo 窗口将在 5 秒后自动关闭...
timeout /t 5
