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
echo 请选择左上角品牌显示方式：
echo [1] 保持英文 Antigravity（推荐）
echo [2] 隐藏品牌名
echo [3] 汉化为品牌名（反重力）
set "CHOICE_VAL=1"
set /p "CHOICE_VAL=请选择 [1/2/3] (直接按 Enter 默认为 1): "
set "BRAND_ARG=--brand-title english"
if "%CHOICE_VAL%"=="2" set "BRAND_ARG=--brand-title hidden"
if "%CHOICE_VAL%"=="3" set "BRAND_ARG=--brand-title translated"

echo.
echo [1/2] 正在注入汉化...
node "%~dp0localization_engine.js" %BRAND_ARG% %*
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
