// dsh-skill-manager — 技能管理器（主机侧）。
//
// 端点：
//   GET  /api/skill-manager/list          → { skills: [{name, description, root, source, size, modelInvocable, userInvocable, version, repository, updateState}] }
//   GET  /api/skill-manager/trash         → 当前会话可撤回的删除记录
//   POST /api/skill-manager/delete        { path } → 把用户技能目录移入会话回收站（仅限已知用户技能根之下）
//   POST /api/skill-manager/undo          { id } → 从会话回收站恢复到原路径
//   POST /api/skill-manager/purge         { id } → 彻底删除会话回收站中的技能
//   POST /api/skill-manager/check-update  { path? } → 检查单个/全部技能更新
//   POST /api/skill-manager/update        { path } → 下载 Release 并整体替换技能
//
// 扫描根（与 dsh-skill-filesystem 的用户根一致）：
//   项目根/.agents/skills、项目根/.dsh/skills、$DSH_HOME/skills、~/.agents/skills
// 内置/随发行版技能（来自插件 bundle 等）不在这些根中，不会列出，也不会被删。
import { join, dirname, basename } from "node:path";
import {
  readFileSync, readdirSync, statSync, existsSync, rmSync, renameSync, mkdirSync,
  cpSync, mkdtempSync
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import {
  checkUpdateForSkill,
  compareVersions,
  downloadArchive,
  extractArchive,
  fetchLatestRelease,
  getUpdateState,
  locateSkillDir,
  parseRepository,
  readManifest,
  readSkillMetaFromDir,
  writeManifest
} from "./update.js";

const name = "skill-manager";
const inject = ["webServer"];

/** 会话级回收目录名（放在每个技能根的同级目录下）。 */
const TRASH_DIR_NAME = ".dsh-skill-manager-trash";
/** 当前会话内可撤回的删除记录。 */
const deletedItems = new Map();

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-cache"
  });
  res.end(body);
}

/** 信任检查：loopback 或 Host 在 webRuntime.trustedHosts 内。 */
function isTrusted(ctx, req) {
  const remote = String(req.socket.remoteAddress ?? "");
  if (remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1") return true;
  const host = String(req.headers.host ?? "");
  const trusted = ctx.get("webRuntime")?.trustedHosts;
  if (!Array.isArray(trusted)) return false;
  return trusted.some((candidate) => host === candidate || host.startsWith(`${candidate}:`));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function dshHomeDir() {
  return (process.env.DSH_HOME?.trim() || join(homedir(), ".dsh"));
}
function agentsHomeDir() {
  return (process.env.DSH_AGENTS_HOME?.trim() || join(homedir(), ".agents"));
}
function projectRoot() {
  const cwd = process.cwd();
  let cur = cwd;
  while (true) {
    if (existsSync(join(cur, ".git"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) return cwd;
    cur = parent;
  }
}
/** 用户可写技能根（可删除）。 */
function skillRoots() {
  const pr = projectRoot();
  return [
    { root: join(pr, ".agents", "skills"), source: "project" },
    { root: join(pr, ".dsh", "skills"), source: "project" },
    { root: join(dshHomeDir(), "skills"), source: "dsh-home" },
    { root: join(agentsHomeDir(), "skills"), source: "user" }
  ];
}
/** 路径是否位于某个用户技能根之下（防路径逃逸）。 */
function isUnderSkillRoot(path) {
  return skillRoots().some(({ root }) => path === root || path.startsWith(root + "\\") || path.startsWith(root + "/"));
}
/** 返回包含该路径的用户技能根信息；不在任何根下时返回 undefined。 */
function skillRootForPath(path) {
  return skillRoots().find(({ root }) => path === root || path.startsWith(root + "\\") || path.startsWith(root + "/"));
}
/** 某个技能根对应的同级会话回收目录。 */
function trashRootForRoot(root) {
  return join(dirname(root), TRASH_DIR_NAME);
}
/** 清理上次会话遗留的回收目录并清空内存记录。 */
function cleanupTrash() {
  const parents = new Set();
  for (const { root } of skillRoots()) {
    const parent = dirname(root);
    if (parents.has(parent)) continue;
    parents.add(parent);
    try {
      for (const entry of readdirSync(parent, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name === TRASH_DIR_NAME) {
          rmSync(join(parent, entry.name), { recursive: true, force: true });
        }
      }
    } catch { /* 忽略不存在或无权限的父目录 */ }
  }
  deletedItems.clear();
}
/** 当前会话内可撤回的删除记录（按删除时间倒序）。 */
function listTrash() {
  return Array.from(deletedItems.values()).sort((a, b) => b.deletedAt - a.deletedAt);
}
/** 把技能目录移动到会话级回收目录，返回撤回记录。 */
function deleteSkillToTrash(targetPath) {
  const rootInfo = skillRootForPath(targetPath);
  if (!rootInfo) {
    const error = new Error("protected-path");
    error.code = "PROTECTED";
    throw error;
  }
  const meta = parseSkill(targetPath);
  if (meta === null) {
    const error = new Error("skill-not-found");
    error.code = "NOT_FOUND";
    throw error;
  }
  const trashRoot = trashRootForRoot(rootInfo.root);
  mkdirSync(trashRoot, { recursive: true });
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const trashPath = join(trashRoot, `${basename(targetPath)}.${id}`);
  renameSync(targetPath, trashPath);
  const entry = {
    id,
    originalPath: targetPath,
    trashPath,
    name: meta.name,
    description: meta.description,
    source: rootInfo.source,
    deletedAt: Date.now()
  };
  deletedItems.set(id, entry);
  return entry;
}
/** 按撤回记录 id 把技能从回收目录恢复到原路径。 */
function undoSkillFromTrash(id) {
  const entry = deletedItems.get(id);
  if (!entry) {
    const error = new Error("undo-not-found");
    error.code = "NOT_FOUND";
    throw error;
  }
  if (existsSync(entry.originalPath)) {
    const error = new Error("target-exists");
    error.code = "CONFLICT";
    error.path = entry.originalPath;
    throw error;
  }
  mkdirSync(dirname(entry.originalPath), { recursive: true });
  renameSync(entry.trashPath, entry.originalPath);
  deletedItems.delete(id);
  return entry;
}
/** 永久删除一条回收站记录（彻底清除磁盘目录）。 */
function purgeTrashItem(id) {
  const entry = deletedItems.get(id);
  if (!entry) {
    const error = new Error("purge-not-found");
    error.code = "NOT_FOUND";
    throw error;
  }
  rmSync(entry.trashPath, { recursive: true, force: true });
  deletedItems.delete(id);
  return entry;
}
function dirInfo(dir) {
  let size = 0;
  let fileCount = 0;
  try {
    const walk = (p) => {
      for (const entry of readdirSync(p, { withFileTypes: true })) {
        const fp = join(p, entry.name);
        if (entry.isDirectory()) walk(fp);
        else {
          size += statSync(fp).size;
          fileCount += 1;
        }
      }
    };
    walk(dir);
  } catch { /* 忽略 */ }
  return { size, fileCount };
}
/** 解析 SKILL.md frontmatter。 */
function parseSkill(dir) {
  const skillMd = join(dir, "SKILL.md");
  if (!existsSync(skillMd)) return null;
  let name = dirname(skillMd).split(/[\\/]/).pop() ?? "";
  let description = "";
  let modelInvocable = true;
  let userInvocable = false;
  let version = null;
  let repository = null;
  let sourcePath = null;
  try {
    const text = readFileSync(skillMd, "utf8");
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (fm) {
      const mName = /^name:\s*(.+)$/m.exec(fm[1]);
      if (mName) name = mName[1].trim();
      const mDesc = /^description:\s*(.+)$/m.exec(fm[1]);
      if (mDesc) description = mDesc[1].trim();
      modelInvocable = !/^disable-model-invocation:\s*true/m.test(fm[1]);
      userInvocable = /^user-invocable:\s*true/m.test(fm[1]);
      const mVersion = /^version:\s*(.+)$/m.exec(fm[1]);
      if (mVersion) version = mVersion[1].trim();
      const mRepo = /^repository:\s*(.+)$/m.exec(fm[1]);
      if (mRepo) repository = mRepo[1].trim();
      const mSourcePath = /^sourcePath:\s*(.+)$/m.exec(fm[1]);
      if (mSourcePath) sourcePath = mSourcePath[1].trim();
    }
  } catch { /* 忽略解析失败 */ }
  return { name, description, modelInvocable, userInvocable, version, repository, sourcePath };
}
/** 扫描全部用户技能根，按名称排序。 */
function listSkills() {
  const manifest = readManifest();
  const out = [];
  for (const { root, source } of skillRoots()) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(root, entry.name);
      const meta = parseSkill(dir);
      if (meta === null) continue;
      const info = dirInfo(dir);
      const update = getUpdateState(dir, meta, manifest);
      const manifestEntry = manifest.skills?.[dir] || {};
      out.push({
        name: meta.name,
        description: meta.description,
        root,
        path: dir,
        source,
        size: info.size,
        fileCount: info.fileCount,
        modelInvocable: meta.modelInvocable,
        userInvocable: meta.userInvocable,
        version: update.version,
        repository: update.source,
        sourcePath: meta.sourcePath || manifestEntry.sourcePath || null,
        latestVersion: update.latestVersion,
        updateAvailable: update.updateAvailable,
        updateState: update.updateState,
        lastCheckedAt: update.lastCheckedAt,
        lastError: update.lastError
      });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** 检查一个或多个技能的更新，返回状态列表。 */
async function checkSkillUpdates(paths) {
  const skills = listSkills();
  const targets = Array.isArray(paths) && paths.length > 0
    ? skills.filter((s) => paths.includes(s.path))
    : skills;
  const results = [];
  for (const skill of targets) {
    const meta = { version: skill.version, repository: skill.repository, sourcePath: skill.sourcePath };
    const state = await checkUpdateForSkill(skill.path, meta);
    results.push({ path: skill.path, name: skill.name, ...state });
  }
  return results;
}

/** 下载 Release 并整体替换技能目录；失败时回滚旧版本。 */
async function updateSkillToLatest(path, options = {}) {
  const skills = listSkills();
  const skill = skills.find((s) => s.path === path);
  if (!skill) {
    const error = new Error("skill-not-found");
    error.code = "NOT_FOUND";
    throw error;
  }
  if (!skill.repository) {
    const error = new Error("no-source");
    error.code = "NO_SOURCE";
    throw error;
  }
  if (!skill.version) {
    const error = new Error("no-version");
    error.code = "NO_VERSION";
    throw error;
  }

  const release = await fetchLatestRelease(skill.repository);
  if (!release.version) {
    const error = new Error("invalid-latest-version");
    error.code = "INVALID_VERSION";
    throw error;
  }

  const repoInfo = parseRepository(skill.repository);
  let url = release.tarballUrl || release.zipballUrl;
  if (!url && repoInfo) {
    if (repoInfo.platform === "github") {
      url = `https://github.com/${repoInfo.owner}/${repoInfo.repo}/archive/refs/tags/${encodeURIComponent(release.tag)}.tar.gz`;
    } else {
      url = `https://gitee.com/${repoInfo.owner}/${repoInfo.repo}/repository/archive/${encodeURIComponent(release.tag)}.zip`;
    }
  }
  if (!url) {
    const error = new Error("no-download-url");
    error.code = "DOWNLOAD_FAILED";
    throw error;
  }

  const downloadImpl = options.downloadArchive || downloadArchive;
  const extractImpl = options.extractArchive || extractArchive;
  const tmpRoot = mkdtempSync(join(tmpdir(), "dsh-skill-manager-update-"));
  const archivePath = join(tmpRoot, "archive.bin");
  const extractDir = join(tmpRoot, "extracted");
  try {
    await downloadImpl(url, archivePath);
    extractImpl(archivePath, extractDir);
    const newSkillDir = locateSkillDir(extractDir, skill.sourcePath || ".");
    const newMeta = readSkillMetaFromDir(newSkillDir);
    if (!newMeta?.version) {
      const error = new Error("new-version-missing");
      error.code = "INVALID_VERSION";
      throw error;
    }

    const backup = deleteSkillToTrash(path);
    try {
      mkdirSync(dirname(path), { recursive: true });
      cpSync(newSkillDir, path, { recursive: true });
    } catch (error) {
      try { rmSync(path, { recursive: true, force: true }); } catch { /* 清理半成品 */ }
      try { undoSkillFromTrash(backup.id); } catch { /* 若恢复失败，旧版仍在回收站可手动恢复 */ }
      throw error;
    }

    // 更新成功：清除本次更新备份，避免出现在“最近删除”里。
    try { rmSync(backup.trashPath, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }
    deletedItems.delete(backup.id);

    const manifest = readManifest();
    manifest.skills[path] = {
      source: skill.repository,
      sourcePath: skill.sourcePath || newMeta.sourcePath || ".",
      installedVersion: newMeta.version,
      installedAt: new Date().toISOString(),
      lastCheckedAt: new Date().toISOString(),
      latestVersion: release.version,
      latestTag: release.tag,
      updateAvailable: compareVersions(newMeta.version, release.version) < 0,
      lastError: null
    };
    writeManifest(manifest);

    return { ok: true, path, oldVersion: skill.version, newVersion: newMeta.version };
  } finally {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 忽略临时目录清理失败 */ }
  }
}

function apply(ctx) {
  // 新会话开始：清掉上次会话遗留的回收目录，保证“仅当前会话可撤回”。
  cleanupTrash();

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/api/skill-manager/list",
    handler: (req, res) => {
      if (req.method !== "GET") {
        json(res, 405, { error: "method-not-allowed" });
        return;
      }
      if (!isTrusted(ctx, req)) {
        json(res, 403, { error: "forbidden" });
        return;
      }
      try {
        json(res, 200, { skills: listSkills() });
      } catch (error) {
        ctx.logger.warn(error);
        json(res, 500, { error: "list-failed", message: String(error?.message ?? error) });
      }
    }
  }), "skill-manager: list route");

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/api/skill-manager/check-update",
    handler: async (req, res) => {
      if (req.method !== "POST") {
        json(res, 405, { error: "method-not-allowed" });
        return;
      }
      if (!isTrusted(ctx, req)) {
        json(res, 403, { error: "forbidden" });
        return;
      }
      let payload = {};
      try {
        const raw = await readBody(req);
        if (raw.trim()) payload = JSON.parse(raw) || {};
      } catch {
        json(res, 400, { error: "bad-json" });
        return;
      }
      const paths = typeof payload?.path === "string" ? [payload.path] : (Array.isArray(payload?.paths) ? payload.paths : []);
      if (paths.some((p) => typeof p !== "string" || !isUnderSkillRoot(p))) {
        json(res, 403, { error: "protected-path" });
        return;
      }
      try {
        const results = await checkSkillUpdates(paths);
        json(res, 200, { results });
      } catch (error) {
        ctx.logger.warn(error);
        json(res, 500, { error: "check-update-failed", message: String(error?.message ?? error) });
      }
    }
  }), "skill-manager: check-update route");

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/api/skill-manager/update",
    handler: async (req, res) => {
      if (req.method !== "POST") {
        json(res, 405, { error: "method-not-allowed" });
        return;
      }
      if (!isTrusted(ctx, req)) {
        json(res, 403, { error: "forbidden" });
        return;
      }
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "bad-json" });
        return;
      }
      const targetPath = payload?.path;
      if (typeof targetPath !== "string" || targetPath.length === 0) {
        json(res, 400, { error: "expected { path }" });
        return;
      }
      if (!isUnderSkillRoot(targetPath)) {
        json(res, 403, { error: "protected-path", path: targetPath });
        return;
      }
      if (parseSkill(targetPath) === null) {
        json(res, 404, { error: "skill-not-found", path: targetPath });
        return;
      }
      try {
        const result = await updateSkillToLatest(targetPath);
        json(res, 200, result);
      } catch (error) {
        if (error?.code === "NOT_FOUND") {
          json(res, 404, { error: "skill-not-found", path: targetPath });
          return;
        }
        if (error?.code === "NO_SOURCE" || error?.code === "NO_VERSION" || error?.code === "INVALID_VERSION") {
          json(res, 400, { error: error.code.toLowerCase(), message: String(error?.message ?? error) });
          return;
        }
        ctx.logger.warn(error);
        json(res, 500, { error: "update-failed", code: error?.code || null, message: String(error?.message ?? error) });
      }
    }
  }), "skill-manager: update route");

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/api/skill-manager/trash",
    handler: (req, res) => {
      if (req.method !== "GET") {
        json(res, 405, { error: "method-not-allowed" });
        return;
      }
      if (!isTrusted(ctx, req)) {
        json(res, 403, { error: "forbidden" });
        return;
      }
      try {
        json(res, 200, { deleted: listTrash() });
      } catch (error) {
        ctx.logger.warn(error);
        json(res, 500, { error: "trash-list-failed", message: String(error?.message ?? error) });
      }
    }
  }), "skill-manager: trash list route");

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/api/skill-manager/delete",
    handler: async (req, res) => {
      if (req.method !== "POST") {
        json(res, 405, { error: "method-not-allowed" });
        return;
      }
      if (!isTrusted(ctx, req)) {
        json(res, 403, { error: "forbidden" });
        return;
      }
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "bad-json" });
        return;
      }
      const targetPath = payload?.path;
      if (typeof targetPath !== "string" || targetPath.length === 0) {
        json(res, 400, { error: "expected { path }" });
        return;
      }
      // 按路径删除：同名技能在不同根下也互不干扰；只允许用户技能根之下的目录
      if (!isUnderSkillRoot(targetPath)) {
        json(res, 403, { error: "protected-path", path: targetPath });
        return;
      }
      if (parseSkill(targetPath) === null) {
        json(res, 404, { error: "skill-not-found", path: targetPath });
        return;
      }
      try {
        const entry = deleteSkillToTrash(targetPath);
        json(res, 200, {
          ok: true,
          undoId: entry.id,
          deleted: { name: entry.name, path: entry.originalPath }
        });
      } catch (error) {
        if (error?.code === "PROTECTED") {
          json(res, 403, { error: "protected-path", path: targetPath });
          return;
        }
        if (error?.code === "NOT_FOUND") {
          json(res, 404, { error: "skill-not-found", path: targetPath });
          return;
        }
        ctx.logger.warn(error);
        json(res, 500, { error: "delete-failed", message: String(error?.message ?? error) });
      }
    }
  }), "skill-manager: delete route");

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/api/skill-manager/undo",
    handler: async (req, res) => {
      if (req.method !== "POST") {
        json(res, 405, { error: "method-not-allowed" });
        return;
      }
      if (!isTrusted(ctx, req)) {
        json(res, 403, { error: "forbidden" });
        return;
      }
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "bad-json" });
        return;
      }
      const id = payload?.id;
      if (typeof id !== "string" || id.length === 0) {
        json(res, 400, { error: "expected { id }" });
        return;
      }
      try {
        const entry = undoSkillFromTrash(id);
        json(res, 200, { ok: true, path: entry.originalPath, name: entry.name });
      } catch (error) {
        if (error?.code === "NOT_FOUND") {
          json(res, 404, { error: "undo-not-found", id });
          return;
        }
        if (error?.code === "CONFLICT") {
          json(res, 409, { error: "target-exists", path: error.path });
          return;
        }
        ctx.logger.warn(error);
        json(res, 500, { error: "undo-failed", message: String(error?.message ?? error) });
      }
    }
  }), "skill-manager: undo route");

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/api/skill-manager/purge",
    handler: async (req, res) => {
      if (req.method !== "POST") {
        json(res, 405, { error: "method-not-allowed" });
        return;
      }
      if (!isTrusted(ctx, req)) {
        json(res, 403, { error: "forbidden" });
        return;
      }
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "bad-json" });
        return;
      }
      const id = payload?.id;
      if (typeof id !== "string" || id.length === 0) {
        json(res, 400, { error: "expected { id }" });
        return;
      }
      try {
        purgeTrashItem(id);
        json(res, 200, { ok: true, id });
      } catch (error) {
        if (error?.code === "NOT_FOUND") {
          json(res, 404, { error: "purge-not-found", id });
          return;
        }
        ctx.logger.warn(error);
        json(res, 500, { error: "purge-failed", message: String(error?.message ?? error) });
      }
    }
  }), "skill-manager: purge route");
}

export {
  apply,
  checkSkillUpdates,
  cleanupTrash,
  deleteSkillToTrash,
  inject,
  isUnderSkillRoot,
  listSkills,
  listTrash,
  name,
  parseSkill,
  purgeTrashItem,
  skillRoots,
  trashRootForRoot,
  undoSkillFromTrash,
  updateSkillToLatest
};
