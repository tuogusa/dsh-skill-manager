# dsh-skill-manager

DeepSeek Harness (DSH) 技能管理器（host + client 一体包）。

## 功能

- **设置 → 技能**：列出全部用户技能（含来源目录：项目/DSH-Home/用户目录）
- 按名称/描述搜索，显示技能大小与文件数、`user-invocable` / `disable-model-invocation` 标记
- 复制技能路径、删除用户技能（仅限已知用户技能根之下，防路径逃逸）
- **会话级撤回**：删除技能时先移入同盘隐藏回收目录，当前会话内可一键恢复；也支持“彻底删除”和查看最近删除列表

## 安装

```bash
dsh plugin --profile web add github:tuogusa/dsh-skill-manager
```

**兼容 Profile**：`web`（DSH Web GUI）。



然后按 `dsh` 引导添加 `pnpm-workspace.yaml` 的 allowBuilds 条目，重启 DSH 并 `Ctrl+Shift+R` 刷新浏览器。

## 结构

- `lib/index.js` — 主机侧：`/api/skill-manager/list`、`/api/skill-manager/delete`、`/api/skill-manager/trash`、`/api/skill-manager/undo`、`/api/skill-manager/purge`
- `lib/client.js` — 浏览器侧：设置 → 技能 分区
- `test/delete-undo.test.mjs` — 删除/撤回/彻底删除的验证测试（`npm test`）

## 删除/撤回 API

- `POST /api/skill-manager/delete` `{ path }` → 移入会话回收站，返回 `{ undoId }`
- `GET /api/skill-manager/trash` → 当前会话可撤回的删除列表
- `POST /api/skill-manager/undo` `{ id }` → 恢复技能到原路径
- `POST /api/skill-manager/purge` `{ id }` → 彻底删除回收站中的技能

回收目录位于各技能根目录的同级隐藏目录 `.dsh-skill-manager-trash`；插件重启时会自动清理，保证“仅当前会话可撤回”。

## 扫描根（与 dsh-skill-filesystem 一致）

- `<项目>/.agents/skills`、`<项目>/.dsh/skills`
- `$DSH_HOME/skills`、`~/.agents/skills`

## License

MIT
