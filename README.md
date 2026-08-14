# dsh-skill-manager

DeepSeek Harness (DSH) 技能管理器（host + client 一体包）。

## 功能

- **设置 → 技能**：列出全部用户技能（含来源目录：项目/DSH-Home/用户目录）
- 按名称/描述搜索，显示技能大小与文件数、`user-invocable` / `disable-model-invocation` 标记
- 复制技能路径、删除用户技能（仅限已知用户技能根之下，防路径逃逸）

## 安装

```bash
dsh plugin --profile web add github:<your-name>/dsh-skill-manager
```

然后按 `dsh` 引导添加 `pnpm-workspace.yaml` 的 allowBuilds 条目，重启 DSH 并 `Ctrl+Shift+R` 刷新浏览器。

## 结构

- `lib/index.js` — 主机侧：`/api/skill-manager/list`、`/api/skill-manager/delete`
- `lib/client.js` — 浏览器侧：设置 → 技能 分区

## 扫描根（与 dsh-skill-filesystem 一致）

- `<项目>/.agents/skills`、`<项目>/.dsh/skills`
- `$DSH_HOME/skills`、`~/.agents/skills`

## License

MIT
