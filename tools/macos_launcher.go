// The macOS app opens the same terminal menu as the Windows launcher.
package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

func fail(message string) {
	fmt.Fprintln(os.Stderr, message)
	_ = exec.Command("/usr/bin/osascript", "-e", `on run argv
display alert "Antigravity 汉化工具" message (item 1 of argv) as critical
end run`, message).Run()
	os.Exit(1)
}

func main() {
	executable, err := os.Executable()
	if err != nil {
		fail("无法定位汉化工具：" + err.Error())
	}
	launcher := filepath.Join(filepath.Dir(executable), "..", "Resources", "payload", "双击运行中文汉化工具.command")
	if info, err := os.Stat(launcher); err != nil || info.IsDir() {
		fail("应用文件不完整，请重新解压汉化工具。")
	}
	// Pass the path as a separate argument so spaces and Chinese names are safe.
	if output, err := exec.Command("/usr/bin/open", "-a", "Terminal", launcher).CombinedOutput(); err != nil {
		fail("无法打开汉化菜单：" + err.Error() + "\n" + string(output))
	}
}
