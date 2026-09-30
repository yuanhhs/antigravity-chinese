#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <io.h>
#include <conio.h>

#define MAGIC "AGYZHZIP"
#define MAGIC_LEN 8

// 探测 node.exe 或 Antigravity.exe
int find_runtime(char* out_path, int* is_electron) {
    *is_electron = 0;

    // 1. 优先从 PATH 查找系统 node.exe
    if (SearchPathA(NULL, "node.exe", NULL, MAX_PATH, out_path, NULL) > 0) {
        return 1;
    }

    // 2. 检查 LOCALAPPDATA 下的 Antigravity
    char local_appdata[MAX_PATH];
    if (GetEnvironmentVariableA("LOCALAPPDATA", local_appdata, MAX_PATH) > 0) {
        snprintf(out_path, MAX_PATH, "%s\\Programs\\antigravity\\Antigravity.exe", local_appdata);
        if (_access(out_path, 0) == 0) {
            *is_electron = 1;
            return 1;
        }
        snprintf(out_path, MAX_PATH, "%s\\Programs\\Antigravity\\Antigravity.exe", local_appdata);
        if (_access(out_path, 0) == 0) {
            *is_electron = 1;
            return 1;
        }
    }

    // 3. 检查 Program Files
    char prog_files[MAX_PATH];
    if (GetEnvironmentVariableA("ProgramFiles", prog_files, MAX_PATH) > 0) {
        snprintf(out_path, MAX_PATH, "%s\\Antigravity\\Antigravity.exe", prog_files);
        if (_access(out_path, 0) == 0) {
            *is_electron = 1;
            return 1;
        }
    }

    // 4. 检查常见盘符
    const char* drives = "CDEF";
    for (int i = 0; drives[i]; i++) {
        snprintf(out_path, MAX_PATH, "%c:\\Programs\\Antigravity\\Antigravity.exe", drives[i]);
        if (_access(out_path, 0) == 0) {
            *is_electron = 1;
            return 1;
        }
        snprintf(out_path, MAX_PATH, "%c:\\Antigravity\\Antigravity.exe", drives[i]);
        if (_access(out_path, 0) == 0) {
            *is_electron = 1;
            return 1;
        }
    }

    return 0;
}

// 静默运行命令等待结束
int run_silent_cmd(const char* cmd) {
    STARTUPINFOA si;
    PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    si.dwFlags |= STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE;
    ZeroMemory(&pi, sizeof(pi));

    char cmd_buf[2048];
    strncpy(cmd_buf, cmd, sizeof(cmd_buf) - 1);
    cmd_buf[sizeof(cmd_buf) - 1] = '\0';

    if (!CreateProcessA(NULL, cmd_buf, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, NULL, &si, &pi)) {
        return -1;
    }
    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD exit_code = 0;
    GetExitCodeProcess(pi.hProcess, &exit_code);
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
    return (int)exit_code;
}

// 释放自包含的 payload.zip 并解压
int extract_payload_if_needed(const char* target_dir) {
    char exe_path[MAX_PATH];
    GetModuleFileNameA(NULL, exe_path, MAX_PATH);

    FILE* fp = fopen(exe_path, "rb");
    if (!fp) return 0;

    fseek(fp, 0, SEEK_END);
    long file_size = ftell(fp);
    if (file_size < MAGIC_LEN + 4) {
        fclose(fp);
        return 0;
    }

    // 读取末尾魔数与长度
    fseek(fp, file_size - (MAGIC_LEN + 4), SEEK_SET);
    unsigned int zip_len = 0;
    if (fread(&zip_len, sizeof(unsigned int), 1, fp) != 1) {
        fclose(fp);
        return 0;
    }

    char magic[MAGIC_LEN + 1] = {0};
    if (fread(magic, 1, MAGIC_LEN, fp) != MAGIC_LEN || memcmp(magic, MAGIC, MAGIC_LEN) != 0) {
        fclose(fp);
        return 0; // 没有附加 payload
    }

    // 检查是否已经解压过且版本一致
    char stamp_file[MAX_PATH];
    snprintf(stamp_file, MAX_PATH, "%s\\.stamp", target_dir);
    FILE* sfp = fopen(stamp_file, "rb");
    if (sfp) {
        unsigned int saved_len = 0;
        if (fread(&saved_len, sizeof(unsigned int), 1, sfp) == 1 && saved_len == zip_len) {
            fclose(sfp);
            fclose(fp);
            return 1; // 缓存有效，无需重复解压
        }
        fclose(sfp);
    }

    // 创建目录
    CreateDirectoryA(target_dir, NULL);

    // 读取并写入临时 zip 文件
    long zip_offset = file_size - (MAGIC_LEN + 4) - zip_len;
    fseek(fp, zip_offset, SEEK_SET);

    char zip_file[MAX_PATH];
    snprintf(zip_file, MAX_PATH, "%s\\payload.zip", target_dir);
    FILE* zfp = fopen(zip_file, "wb");
    if (!zfp) {
        fclose(fp);
        return 0;
    }

    char buf[16384];
    unsigned int remaining = zip_len;
    while (remaining > 0) {
        size_t to_read = remaining < sizeof(buf) ? remaining : sizeof(buf);
        size_t n = fread(buf, 1, to_read, fp);
        if (n == 0) break;
        fwrite(buf, 1, n, zfp);
        remaining -= (unsigned int)n;
    }
    fclose(zfp);
    fclose(fp);

    if (remaining > 0) return 0;

    // 解压 zip (调用系统 tar)
    char cmd[2048];
    snprintf(cmd, sizeof(cmd), "tar.exe -xf \"%s\" -C \"%s\"", zip_file, target_dir);
    int res = run_silent_cmd(cmd);
    if (res != 0) {
        // tar 解压失败，尝试用 powershell 解压兜底
        snprintf(cmd, sizeof(cmd), "powershell.exe -NoProfile -Command \"Expand-Archive -LiteralPath '%s' -DestinationPath '%s' -Force\"", zip_file, target_dir);
        res = run_silent_cmd(cmd);
    }

    // 删除临时 zip 文件
    remove(zip_file);

    if (res == 0) {
        // 写入 stamp
        sfp = fopen(stamp_file, "wb");
        if (sfp) {
            fwrite(&zip_len, sizeof(unsigned int), 1, sfp);
            fclose(sfp);
        }
        return 1;
    }

    return 0;
}

int run_script(const char* runtime_path, int is_electron, const char* script_path, const char* extra_args) {
    if (is_electron) {
        SetEnvironmentVariableA("ELECTRON_RUN_AS_NODE", "1");
    }

    char cmd_line[4096];
    if (extra_args && strlen(extra_args) > 0) {
        snprintf(cmd_line, sizeof(cmd_line), "\"%s\" \"%s\" %s", runtime_path, script_path, extra_args);
    } else {
        snprintf(cmd_line, sizeof(cmd_line), "\"%s\" \"%s\"", runtime_path, script_path);
    }

    STARTUPINFOA si;
    PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    ZeroMemory(&pi, sizeof(pi));

    if (!CreateProcessA(NULL, cmd_line, NULL, NULL, TRUE, 0, NULL, NULL, &si, &pi)) {
        printf("[错误] 启动脚本失败: %lu\n", GetLastError());
        return 1;
    }

    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD exit_code = 0;
    GetExitCodeProcess(pi.hProcess, &exit_code);
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
    return (int)exit_code;
}

int main(int argc, char* argv[]) {
    // 设置 UTF-8 编码，防止中文乱码
    SetConsoleOutputCP(CP_UTF8);
    SetConsoleCP(CP_UTF8);

    // 1. 查找运行环境
    char runtime_path[MAX_PATH] = {0};
    int is_electron = 0;
    if (!find_runtime(runtime_path, &is_electron)) {
        printf("[错误] 未检测到 Node.js 运行环境，也未找到 Antigravity 安装目录。\n");
        printf("请先安装 Node.js (https://nodejs.org/) 或先安装 Antigravity 客户端。\n");
        printf("\n按任意键退出...\n");
        _getch();
        return 1;
    }

    // 2. 解压 Payload 到临时目录
    char temp_dir[MAX_PATH];
    char app_dir[MAX_PATH];
    GetTempPathA(MAX_PATH, temp_dir);
    snprintf(app_dir, MAX_PATH, "%santigravity_cn_launcher", temp_dir);

    if (!extract_payload_if_needed(app_dir)) {
        // 如果没有内嵌 payload，则假设在当前目录运行（开发调试模式）
        GetModuleFileNameA(NULL, app_dir, MAX_PATH);
        char* last_slash = strrchr(app_dir, '\\');
        if (last_slash) *last_slash = '\0';
    }

    // 脚本路径
    char engine_script[MAX_PATH];
    char vscode_script[MAX_PATH];
    char both_script[MAX_PATH];
    snprintf(engine_script, MAX_PATH, "%s\\localization_engine.js", app_dir);
    snprintf(vscode_script, MAX_PATH, "%s\\tools\\localize_vscode_extension.js", app_dir);
    snprintf(both_script, MAX_PATH, "%s\\tools\\localize_both.js", app_dir);

    // 3. 处理命令行或交互菜单
    int exit_code = 0;
    if (argc > 1) {
        // 检查是否为单数字快捷命令 (1~5)
        if (argc == 2 && strlen(argv[1]) == 1 && argv[1][0] >= '1' && argv[1][0] <= '5') {
            char choice = argv[1][0];
            switch (choice) {
                case '1':
                    exit_code = run_script(runtime_path, is_electron, engine_script, "");
                    break;
                case '2':
                    exit_code = run_script(runtime_path, is_electron, engine_script, "--huifu");
                    break;
                case '3':
                    exit_code = run_script(runtime_path, is_electron, vscode_script, "");
                    break;
                case '4':
                    exit_code = run_script(runtime_path, is_electron, vscode_script, "--uninstall");
                    break;
                case '5':
                    exit_code = run_script(runtime_path, is_electron, both_script, "");
                    break;
            }
        } else {
            // 标准命令行模式：透传所有参数给 localization_engine.js
            char combined_args[3072] = {0};
            for (int i = 1; i < argc; i++) {
                if (i > 1) strncat(combined_args, " ", sizeof(combined_args) - strlen(combined_args) - 1);
                if (strchr(argv[i], ' ')) {
                    strncat(combined_args, "\"", sizeof(combined_args) - strlen(combined_args) - 1);
                    strncat(combined_args, argv[i], sizeof(combined_args) - strlen(combined_args) - 1);
                    strncat(combined_args, "\"", sizeof(combined_args) - strlen(combined_args) - 1);
                } else {
                    strncat(combined_args, argv[i], sizeof(combined_args) - strlen(combined_args) - 1);
                }
            }
            exit_code = run_script(runtime_path, is_electron, engine_script, combined_args);
        }
    } else {
        // 交互菜单模式
        printf("\n");
        printf("====== Antigravity 简体中文汉化工具 ======\n\n");
        printf("请选择需要执行的操作：\n");
        printf("[1] 安装 Antigravity 桌面版汉化\n");
        printf("[2] 卸载 Antigravity 桌面版汉化\n");
        printf("[3] 安装 VS Code 插件汉化\n");
        printf("[4] 卸载 VS Code 插件汉化\n");
        printf("[5] 同时安装 Antigravity 与 VS Code 汉化\n");
        printf("[0] 退出\n\n");
        printf("请输入选项 [1/2/3/4/5/0] (直接按 Enter 默认为 1): ");
        fflush(stdout);

        char input[64] = {0};
        if (!fgets(input, sizeof(input), stdin)) {
            strcpy(input, "1");
        }
        // 去除换行与首尾空白
        char* p = input;
        while (*p == ' ' || *p == '\t') p++;
        char choice = *p;
        if (choice == '\r' || choice == '\n' || choice == '\0') {
            choice = '1';
        }

        switch (choice) {
            case '1':
                printf("\n正在安装 Antigravity 桌面版汉化...\n");
                exit_code = run_script(runtime_path, is_electron, engine_script, "");
                break;
            case '2':
                printf("\n正在卸载 Antigravity 桌面版汉化...\n");
                exit_code = run_script(runtime_path, is_electron, engine_script, "--huifu");
                break;
            case '3':
                printf("\n正在安装 VS Code 插件汉化...\n");
                exit_code = run_script(runtime_path, is_electron, vscode_script, "");
                break;
            case '4':
                printf("\n正在卸载 VS Code 插件汉化...\n");
                exit_code = run_script(runtime_path, is_electron, vscode_script, "--uninstall");
                break;
            case '5':
                printf("\n正在同时安装 Antigravity 与 VS Code 汉化...\n");
                exit_code = run_script(runtime_path, is_electron, both_script, "");
                break;
            case '0':
                printf("已退出。\n");
                return 0;
            default:
                printf("\n[错误] 无效的选项: %c\n", choice);
                exit_code = 1;
                break;
        }

        printf("\n执行完成，按任意键退出...\n");
        _getch();
    }

    return exit_code;
}
