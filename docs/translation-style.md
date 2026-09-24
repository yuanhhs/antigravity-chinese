# 翻译维护约定

以 Codex 桌面端的简体中文表达为参考，按 Antigravity 的实际功能和上下文翻译。

## 用词

| 原文 | 默认译法 |
| --- | --- |
| agent / subagent | 智能体 / 子智能体 |
| conversation / workspace | 对话 / 工作区（AGY 的工作区是实际的开发环境） |
| repository / branch / commit / worktree | 仓库 / 分支 / 提交 / 工作树 |
| approval / permission | 批准 / 权限 |
| review | 代码审查、文档审阅、请求审核、检查配置；按界面语境选择 |
| remove / delete | 移除 / 删除 |
| dismiss | 关闭提示；涉及忽略操作时按语境翻译 |

默认使用“你”；进行中提示用“正在…”，末尾使用省略号“…”；保留品牌、模型名、命令、路径和代码标识符。菜单与正文采用相同术语，不给品牌添加自创中文名称。Codex 中“项目”和“工作空间”也会出现，但 AGY 的 `workspace` 是独立的开发环境，统一称为“工作区”。

## 词库

- `dicts_src/`：界面词条，按文件名排序合并；后面的文件覆盖前面的同名键。
- `locales/zh-CN.json`：原生菜单、托盘、加载页和更新弹窗。
- `null` 或原文：有意保留英文。
- 对象词条的 `note`：记录语境；现有 `scope`、`keys`、`notWith` 可限定展示位置。不要为解决漏翻随意扩大到 `scope: "all"`。

## 参数与复数

`${0}` 等参数必须保留，校验器检查参数编号和出现次数。命名参数属于上游源码，不能仅靠改词库将数字参数改成命名参数。

只有明确属于英文复数后缀的参数允许省略：

```json
{
  "${0} item${1}": {
    "zh": "${0} 项",
    "omitPlaceholders": [1],
    "note": "参数 1 为英文复数后缀 s/es"
  }
}
```

运行时会验证被省略参数的表达式。不满足要求时保留原文并写入日志，防止新版软件更改参数含义后被误删。

## 验证

```bash
node tools/validate_translations.js
node tools/validate_translations.js temps/live_main.js
node --test tests/*.test.js
```

提取工具生成的 `pending_*.context.json` 包含源码片段、使用位置、动态参数和建议来源。它供人工核对，不应复制进词库。参数不匹配的相似译文不会自动填入待翻清单。

源码扫描覆盖率不代表所有运行时服务端文案都已翻译。发布前还需在实际应用中核对菜单、配额提示和新功能。
