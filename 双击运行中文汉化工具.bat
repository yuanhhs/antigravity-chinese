@echo off
title Antigravity 中文汉化工具

echo.
echo ====== Antigravity 中文汉化工具 ======
echo.
echo 请选择要执行的操作：
echo [1] 安装 Antigravity 桌面版汉化
echo [2] 卸载 Antigravity 桌面版汉化
echo [3] 安装 VS Code 插件汉化
echo [4] 卸载 VS Code 插件汉化
set "ACTION=1"
set /p "ACTION=请选择 [1/2/3/4] (直接按 Enter 默认为 1): "
for /f "tokens=1" %%A in ("%ACTION%") do set "ACTION=%%A"
if "%ACTION%"=="1" goto :install_app
if "%ACTION%"=="2" goto :restore_app
if "%ACTION%"=="3" goto :install_vscode
if "%ACTION%"=="4" goto :restore_vscode
echo.
echo [×] 无效选项：%ACTION%
goto :fail

:install_app
echo.
echo 正在安装 Antigravity 桌面版汉化...
node "%~dp0localization_engine.js" %*
if %errorlevel% neq 0 goto :fail
echo.
echo Antigravity 桌面版汉化已安装。
goto :done

:restore_app
echo.
echo 正在还原 Antigravity 桌面版...
node "%~dp0localization_engine.js" --huifu %*
if %errorlevel% neq 0 goto :fail
echo.
echo Antigravity 桌面版已还原。
goto :done

:install_vscode
echo.
echo 正在安装 VS Code 插件汉化...
node "%~dp0tools\localize_vscode_extension.js" %*
if %errorlevel% neq 0 goto :fail
echo.
echo VS Code 插件汉化已安装。请在 VS Code 中执行 Developer: Reload Window。
goto :done

:restore_vscode
echo.
echo 正在卸载 VS Code 插件汉化...
node "%~dp0tools\localize_vscode_extension.js" --uninstall %*
if %errorlevel% neq 0 goto :fail
echo.
echo VS Code 插件汉化已卸载。请在 VS Code 中执行 Developer: Reload Window。
goto :done

:fail
echo.
echo [×] 操作失败，请检查上方错误信息。
pause
exit /b 1

:done
echo.
echo 窗口将在 5 秒后自动关闭...
timeout /t 5 >nul 2>&1
exit /b 0
