// dsh-skill-manager — 技能管理器（主机侧）。
//
// 端点：
//   GET  /api/skill-manager/list    → { skills: [{name, description, root, source, size, modelInvocable, userInvocable}] }
//   POST /api/skill-manager/delete  { name } → 删除用户技能目录（仅限已知用户技能根之下）
//
// 扫描根（与 dsh-skill-filesystem 的用户根一致）：
//   项目根/.agents/skills、项目根/.dsh/skills、$DSH_HOME/skills、~/.agents/skills
// 内置/随发行版技能（来自插件 bundle 等）不在这些根中，不会列出，也不会被删。
import { join, dirname } from "node:path";
import { readFileSync, readdirSync, statSync, existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";

const name = "skill-manager";
const inject = ["webServer"];

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
    }
  } catch { /* 忽略解析失败 */ }
  return { name, description, modelInvocable, userInvocable };
}
/** 扫描全部用户技能根，按名称排序。 */
function listSkills() {
  const out = [];
  for (const { root, source } of skillRoots()) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(root, entry.name);
      const meta = parseSkill(dir);
      if (meta === null) continue;
      const info = dirInfo(dir);
      out.push({
        name: meta.name,
        description: meta.description,
        root,
        path: dir,
        source,
        size: info.size,
        fileCount: info.fileCount,
        modelInvocable: meta.modelInvocable,
        userInvocable: meta.userInvocable
      });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function apply(ctx) {
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
        rmSync(targetPath, { recursive: true, force: true });
        json(res, 200, { ok: true, path: targetPath });
      } catch (error) {
        ctx.logger.warn(error);
        json(res, 500, { error: "delete-failed", message: String(error?.message ?? error) });
      }
    }
  }), "skill-manager: delete route");
}

export { apply, inject, isUnderSkillRoot, listSkills, name, parseSkill, skillRoots };
