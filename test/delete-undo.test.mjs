// dsh-skill-manager 删除/撤回功能验证测试。
// 运行：npm test
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

const originalCwd = process.cwd();
const originalDshHome = process.env.DSH_HOME;
const originalAgentsHome = process.env.DSH_AGENTS_HOME;

function makeSkillDir(dir, name, description) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n`, "utf8");
}

function makeRes() {
  let status = 0;
  let body = "";
  const headers = {};
  return {
    writeHead(code, head) {
      status = code;
      Object.assign(headers, head);
    },
    end(text) {
      body = String(text);
    },
    getStatus() { return status; },
    getBody() { return body; },
    getHeader(name) { return headers[name]; }
  };
}

function makeReq(method, remoteAddress, payload) {
  const req = Readable.from(payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))]);
  req.method = method;
  req.socket = { remoteAddress };
  req.headers = { host: "localhost" };
  return req;
}

test("删除/撤回/彻底删除 生命周期与 API 路由", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "dsh-skill-manager-test-"));
  const project = join(tmp, "project");
  const dshHome = join(tmp, "dsh-home");
  const agentsHome = join(tmp, "agents-home");
  mkdirSync(join(project, ".git"), { recursive: true });
  process.env.DSH_HOME = dshHome;
  process.env.DSH_AGENTS_HOME = agentsHome;
  process.chdir(project);

  const userRoot = join(agentsHome, "skills");
  const projectRootDir = join(project, ".agents", "skills");
  const demoDir = join(userRoot, "demo");
  makeSkillDir(demoDir, "demo", "A demo skill");

  const mod = await import("../lib/index.js");
  const ctx = {
    effect(fn) { fn(); },
    get() { return undefined; },
    webServer: { register(route) { ctx.routes.push(route); } },
    logger: { warn() {} }
  };
  ctx.routes = [];
  mod.apply(ctx);

  const route = (path) => ctx.routes.find((r) => r.path === path);
  const call = async (path, method, body, remote = "127.0.0.1") => {
    const res = makeRes();
    await route(path).handler(makeReq(method, remote, body), res);
    return { status: res.getStatus(), body: res.getBody() ? JSON.parse(res.getBody()) : null };
  };

  await t.test("初始列表包含 demo", async () => {
    const res = await call("/api/skill-manager/list", "GET");
    assert.equal(res.status, 200);
    assert.ok(res.body.skills.some((s) => s.name === "demo" && s.path === demoDir));
  });

  let undoId;
  await t.test("删除后进入会话回收站，技能从列表消失", async () => {
    const res = await call("/api/skill-manager/delete", "POST", { path: demoDir });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(typeof res.body.undoId, "string");
    assert.equal(res.body.deleted.name, "demo");
    undoId = res.body.undoId;

    assert.equal(existsSync(demoDir), false);
    const trashDir = join(agentsHome, ".dsh-skill-manager-trash");
    assert.equal(existsSync(trashDir), true);
    assert.equal(readdirSync(trashDir).length, 1);

    const listRes = await call("/api/skill-manager/list", "GET");
    assert.equal(listRes.body.skills.some((s) => s.path === demoDir), false);
  });

  await t.test("回收站列表返回该记录", async () => {
    const res = await call("/api/skill-manager/trash", "GET");
    assert.equal(res.status, 200);
    assert.equal(res.body.deleted.length, 1);
    assert.equal(res.body.deleted[0].id, undoId);
    assert.equal(res.body.deleted[0].originalPath, demoDir);
  });

  await t.test("撤回后技能恢复原路径", async () => {
    const res = await call("/api/skill-manager/undo", "POST", { id: undoId });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.path, demoDir);
    assert.equal(existsSync(demoDir), true);
    assert.equal(readFileSync(join(demoDir, "SKILL.md"), "utf8").includes("name: demo"), true);

    const listRes = await call("/api/skill-manager/list", "GET");
    assert.equal(listRes.body.skills.some((s) => s.path === demoDir), true);

    const trashRes = await call("/api/skill-manager/trash", "GET");
    assert.equal(trashRes.body.deleted.length, 0);
  });

  await t.test("再次删除后可彻底删除，且不能再撤回", async () => {
    const delRes = await call("/api/skill-manager/delete", "POST", { path: demoDir });
    assert.equal(delRes.status, 200);
    const purgeId = delRes.body.undoId;

    const purgeRes = await call("/api/skill-manager/purge", "POST", { id: purgeId });
    assert.equal(purgeRes.status, 200);
    assert.equal(purgeRes.body.ok, true);
    assert.equal(existsSync(demoDir), false);
    const trashDir = join(agentsHome, ".dsh-skill-manager-trash");
    assert.equal(existsSync(trashDir) ? readdirSync(trashDir).length : 0, 0);

    const undoRes = await call("/api/skill-manager/undo", "POST", { id: purgeId });
    assert.equal(undoRes.status, 404);
    assert.equal(undoRes.body.error, "undo-not-found");
  });

  await t.test("路径逃逸被拒绝", async () => {
    const outside = join(tmp, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "SKILL.md"), "---\nname: outside\n---\n", "utf8");
    const res = await call("/api/skill-manager/delete", "POST", { path: outside });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "protected-path");
  });

  await t.test("非回环地址被拒绝", async () => {
    const res = await call("/api/skill-manager/list", "GET", undefined, "10.0.0.1");
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "forbidden");
  });

  await t.test("cleanupTrash 清掉遗留回收目录", async () => {
    // 手工制造一个“上次会话”遗留目录
    const staleTrash = join(agentsHome, ".dsh-skill-manager-trash");
    mkdirSync(staleTrash, { recursive: true });
    writeFileSync(join(staleTrash, "stale.txt"), "stale", "utf8");
    mod.cleanupTrash();
    assert.equal(existsSync(staleTrash), false);
  });

  process.chdir(originalCwd);
  process.env.DSH_HOME = originalDshHome;
  process.env.DSH_AGENTS_HOME = originalAgentsHome;
  rmSync(tmp, { recursive: true, force: true });
});
