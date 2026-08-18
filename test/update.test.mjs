// dsh-skill-manager 技能更新检测/更新功能验证测试。
// 运行：npm test（会依次执行 delete-undo 与 update 测试）
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, cpSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseRepository,
  normalizeVersion,
  compareVersions,
  readSkillMetaFromDir,
  readManifest,
  writeManifest,
  getUpdateState,
  checkUpdateForSkill,
  locateSkillDir
} from "../lib/update.js";

const originalCwd = process.cwd();
const originalDshHome = process.env.DSH_HOME;
const originalAgentsHome = process.env.DSH_AGENTS_HOME;

function makeSkillDir(dir, version, repository, sourcePath) {
  mkdirSync(dir, { recursive: true });
  const lines = ["---", `name: ${dir.split(/[\\/]/).pop()}`, `version: ${version}`];
  if (repository) lines.push(`repository: ${repository}`);
  if (sourcePath) lines.push(`sourcePath: ${sourcePath}`);
  lines.push("---", "");
  writeFileSync(join(dir, "SKILL.md"), lines.join("\n"), "utf8");
}

test("技能更新检测与更新功能", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "dsh-skill-manager-update-test-"));
  const project = join(tmp, "project");
  const dshHome = join(tmp, "dsh-home");
  const agentsHome = join(tmp, "agents-home");
  mkdirSync(join(project, ".git"), { recursive: true });
  process.env.DSH_HOME = dshHome;
  process.env.DSH_AGENTS_HOME = agentsHome;
  process.chdir(project);

  const userRoot = join(agentsHome, "skills");
  const demoDir = join(userRoot, "demo");
  makeSkillDir(demoDir, "1.0.0", "https://github.com/example/demo-skill", ".");

  const mod = await import("../lib/index.js");

  await t.test("解析仓库地址和版本号", () => {
    assert.deepEqual(parseRepository("https://github.com/example/demo-skill.git"), {
      platform: "github", owner: "example", repo: "demo-skill"
    });
    assert.deepEqual(parseRepository("https://gitee.com/example/demo-skill"), {
      platform: "gitee", owner: "example", repo: "demo-skill"
    });
    assert.equal(parseRepository("https://example.com/x"), null);
    assert.equal(normalizeVersion("v1.2.3"), "1.2.3");
    assert.equal(compareVersions("1.2.0", "1.2.1"), -1);
    assert.equal(compareVersions("1.2.1", "1.2.1"), 0);
    assert.equal(compareVersions("1.2.1", "not-a-version"), null);
  });

  await t.test("读取 SKILL.md 中的版本/仓库/sourcePath", () => {
    const meta = readSkillMetaFromDir(demoDir);
    assert.equal(meta.version, "1.0.0");
    assert.equal(meta.repository, "https://github.com/example/demo-skill");
    assert.equal(meta.sourcePath, ".");
  });

  await t.test("getUpdateState 状态计算", () => {
    const manifest = {
      skills: {
        [demoDir]: { source: "https://github.com/example/demo-skill", latestVersion: "1.2.0", lastCheckedAt: "now" }
      }
    };
    const meta = { version: "1.0.0", repository: "https://github.com/example/demo-skill" };
    const state = getUpdateState(demoDir, meta, manifest);
    assert.equal(state.updateState, "available");
    assert.equal(state.updateAvailable, true);
    assert.equal(state.latestVersion, "1.2.0");

    const latestMeta = { version: "1.2.0", repository: "https://github.com/example/demo-skill" };
    assert.equal(getUpdateState(demoDir, latestMeta, manifest).updateState, "latest");
    assert.equal(getUpdateState(demoDir, { version: "1.0.0", repository: null }, {}).updateState, "no-source");
  });

  await t.test("locateSkillDir 拒绝越界 sourcePath", () => {
    const extractDir = join(tmp, "extract-safety");
    mkdirSync(extractDir, { recursive: true });
    writeFileSync(join(extractDir, "SKILL.md"), "---\nname: safe\nversion: 1.0.0\n---\n", "utf8");
    assert.throws(() => locateSkillDir(extractDir, "../evil"), /invalid-source-path/);
    assert.equal(locateSkillDir(extractDir, ".").endsWith(extractDir), true);
  });

  await t.test("checkUpdateForSkill 使用 mock fetch 检查更新并写清单", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      assert.match(String(url), /api\.github\.com\/repos\/example\/demo-skill\/releases\/latest/);
      return { ok: true, json: async () => ({ tag_name: "v1.2.0", tarball_url: "http://fake/demo.tar.gz" }) };
    };
    try {
      const state = await checkUpdateForSkill(demoDir, { version: "1.0.0", repository: "https://github.com/example/demo-skill" });
      assert.equal(state.latestVersion, "1.2.0");
      assert.equal(state.updateState, "available");
      const manifest = readManifest();
      assert.equal(manifest.skills[demoDir].latestTag, "v1.2.0");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  await t.test("API check-update 路由返回更新状态", async () => {
    const ctx = {
      effect(fn) { fn(); },
      get() { return undefined; },
      webServer: { register(route) { ctx.routes.push(route); } },
      logger: { warn() {} }
    };
    ctx.routes = [];
    mod.apply(ctx);

    const route = (path) => ctx.routes.find((r) => r.path === path);
    const { Readable } = await import("node:stream");
    const makeReq = (method, body) => {
      const req = Readable.from([Buffer.from(JSON.stringify(body))]);
      req.method = method;
      req.socket = { remoteAddress: "127.0.0.1" };
      req.headers = { host: "localhost" };
      return req;
    };
    const makeRes = () => {
      let status = 0;
      let body = "";
      return {
        writeHead(code) { status = code; },
        end(text) { body = String(text); },
        getStatus() { return status; },
        getBody() { return body ? JSON.parse(body) : null; }
      };
    };

    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      return { ok: true, json: async () => ({ tag_name: "v2.0.0", tarball_url: "http://fake/demo.tar.gz" }) };
    };
    try {
      const res = makeRes();
      await route("/api/skill-manager/check-update").handler(makeReq("POST", { path: demoDir }), res);
      assert.equal(res.getStatus(), 200);
      assert.equal(res.getBody().results[0].updateState, "available");
      assert.equal(res.getBody().results[0].latestVersion, "2.0.0");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  await t.test("完整更新：下载 Release 压缩包并替换技能目录", async () => {
    // 模拟解压后得到的“新版本技能目录”
    const newSkillSource = join(tmp, "new-skill-source");
    makeSkillDir(newSkillSource, "2.0.0", "https://github.com/example/demo-skill", ".");
    writeFileSync(join(newSkillSource, "README.md"), "new readme", "utf8");

    const realFetch = globalThis.fetch;
    let releaseFetchCount = 0;
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes("releases/latest")) {
        releaseFetchCount += 1;
        return { ok: true, json: async () => ({ tag_name: "v2.0.0", tarball_url: "http://fake/demo-skill.tar.gz" }) };
      }
      throw new Error("unexpected fetch: " + u);
    };
    try {
      const result = await mod.updateSkillToLatest(demoDir, {
        downloadArchive: async (url, destFile) => {
          assert.equal(url, "http://fake/demo-skill.tar.gz");
          writeFileSync(destFile, "fake-archive");
        },
        extractArchive: (archivePath, destDir) => {
          mkdirSync(destDir, { recursive: true });
          // 模拟压缩包解压后产生一个顶层目录
          cpSync(newSkillSource, join(destDir, "demo-skill-2.0.0"), { recursive: true });
        }
      });
      assert.equal(result.ok, true);
      assert.equal(result.oldVersion, "1.0.0");
      assert.equal(result.newVersion, "2.0.0");
      assert.equal(releaseFetchCount >= 1, true);

      const meta = readSkillMetaFromDir(demoDir);
      assert.equal(meta.version, "2.0.0");
      assert.equal(existsSync(join(demoDir, "README.md")), true);
      const manifest = readManifest();
      assert.equal(manifest.skills[demoDir].installedVersion, "2.0.0");
      // 更新备份不应出现在“最近删除”中
      const trashRes = await mod.listTrash();
      assert.equal(trashRes.some((item) => item.originalPath === demoDir), false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  process.chdir(originalCwd);
  process.env.DSH_HOME = originalDshHome;
  process.env.DSH_AGENTS_HOME = originalAgentsHome;
  rmSync(tmp, { recursive: true, force: true });
});
