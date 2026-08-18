// dsh-skill-manager — 技能更新检测/更新工具（主机侧）。
// 不依赖第三方包；网络请求使用全局 fetch，解压使用系统 tar。
import { join, dirname, relative, resolve, sep } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";

const MANIFEST_FILE = ".dsh-skill-manager.json";

/** 本地安装清单路径：$DSH_HOME/.dsh-skill-manager.json */
export function manifestPath() {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), ".dsh");
  return join(home, MANIFEST_FILE);
}

export function readManifest() {
  try {
    const text = readFileSync(manifestPath(), "utf8");
    const data = JSON.parse(text);
    if (data && typeof data === "object" && data.skills && typeof data.skills === "object") {
      return data;
    }
  } catch { /* 忽略损坏/不存在 */ }
  return { version: 1, skills: {} };
}

export function writeManifest(manifest) {
  const file = manifestPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(manifest, null, 2), "utf8");
}

/** 从 GitHub/Gitee 地址解析 owner/repo。 */
export function parseRepository(repository) {
  if (typeof repository !== "string") return null;
  let m = /github\.com[:/]([^/]+)\/([^/#?]+)/i.exec(repository);
  if (m) {
    return { platform: "github", owner: m[1], repo: m[2].replace(/\.git$/i, "") };
  }
  m = /gitee\.com[:/]([^/]+)\/([^/#?]+)/i.exec(repository);
  if (m) {
    return { platform: "gitee", owner: m[1], repo: m[2].replace(/\.git$/i, "") };
  }
  return null;
}

/** 规范化版本号：去掉前导 v，仅接受 semver 风格。 */
export function normalizeVersion(value) {
  if (typeof value !== "string") return null;
  const v = value.trim().replace(/^[vV]/, "");
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(v)) return null;
  return v;
}

function parseVersion(value) {
  const v = normalizeVersion(value);
  if (!v) return null;
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] || ""
  };
}

/** semver 比较；无法解析返回 null。 */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1; // release > prerelease
  if (!pb.pre) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

/** 读取 SKILL.md frontmatter 中的版本/仓库/子目录信息。 */
export function readSkillMetaFromDir(dir) {
  const skillMd = join(dir, "SKILL.md");
  if (!existsSync(skillMd)) return null;
  let version = null;
  let repository = null;
  let sourcePath = null;
  try {
    const text = readFileSync(skillMd, "utf8");
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (fm) {
      const mVersion = /^version:\s*(.+)$/m.exec(fm[1]);
      if (mVersion) version = mVersion[1].trim();
      const mRepo = /^repository:\s*(.+)$/m.exec(fm[1]);
      if (mRepo) repository = mRepo[1].trim();
      const mSourcePath = /^sourcePath:\s*(.+)$/m.exec(fm[1]);
      if (mSourcePath) sourcePath = mSourcePath[1].trim();
    }
  } catch { /* 忽略解析失败 */ }
  return { version, repository, sourcePath };
}

/** 查询 GitHub/Gitee 最新 Release。 */
export async function fetchLatestRelease(repository, fetchImpl = fetch) {
  const info = parseRepository(repository);
  if (!info) {
    const error = new Error("invalid-repository");
    error.code = "INVALID_SOURCE";
    throw error;
  }
  let url;
  const headers = { "user-agent": "dsh-skill-manager" };
  if (info.platform === "github") {
    url = `https://api.github.com/repos/${info.owner}/${info.repo}/releases/latest`;
    headers.accept = "application/vnd.github+json";
  } else {
    url = `https://gitee.com/api/v5/repos/${info.owner}/${info.repo}/releases/latest`;
  }
  const res = await fetchImpl(url, { headers });
  if (!res.ok) {
    const error = new Error(`release-http-${res.status}`);
    error.code = "CHECK_FAILED";
    error.status = res.status;
    throw error;
  }
  const data = await res.json();
  const tag = data?.tag_name;
  if (!tag) {
    const error = new Error("release-tag-missing");
    error.code = "CHECK_FAILED";
    throw error;
  }
  const version = normalizeVersion(tag);
  return {
    tag,
    version,
    name: data?.name || null,
    tarballUrl: data?.tarball_url || null,
    zipballUrl: data?.zipball_url || null
  };
}

/** 下载远程文件到本地临时文件。 */
export async function downloadArchive(url, destFile, fetchImpl = fetch) {
  const res = await fetchImpl(url);
  if (!res.ok) {
    const error = new Error(`download-http-${res.status}`);
    error.code = "DOWNLOAD_FAILED";
    error.status = res.status;
    throw error;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(destFile, buf);
  return destFile;
}

/** 使用系统 tar 解压（支持 .tar.gz / .zip）。 */
export function extractArchive(archivePath, destDir) {
  mkdirSync(destDir, { recursive: true });
  try {
    execFileSync("tar", ["-xf", archivePath, "-C", destDir], { stdio: "pipe" });
  } catch (error) {
    const wrapped = new Error(`extract-failed: ${String(error?.message ?? error)}`);
    wrapped.code = "EXTRACT_FAILED";
    throw wrapped;
  }
}

/** 在解压目录中定位技能目录。 */
export function locateSkillDir(extractDir, sourcePath) {
  let base = extractDir;
  const entries = readdirSync(extractDir, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory());
  const files = entries.filter((e) => !e.isDirectory());
  // GitHub/Gitee 压缩包通常带一个顶层目录；如果顶层只有目录，就进入它。
  if (files.length === 0 && dirs.length === 1) {
    base = join(extractDir, dirs[0].name);
  }
  const rel = sourcePath && sourcePath !== "." ? sourcePath.replace(/^\.\//, "").replace(/[\\/]+$/, "") : ".";
  const skillDir = rel === "." ? base : resolve(base, rel);
  // 防止 sourcePath 逃逸出解压目录
  const relCheck = relative(resolve(base), skillDir);
  if (relCheck === ".." || relCheck.startsWith(".." + sep) || relCheck.includes(sep + ".." + sep)) {
    const error = new Error(`invalid-source-path: ${rel}`);
    error.code = "INVALID_SOURCE_PATH";
    throw error;
  }
  if (!existsSync(join(skillDir, "SKILL.md"))) {
    const error = new Error(`skill-not-in-archive: ${rel}`);
    error.code = "SKILL_NOT_FOUND";
    throw error;
  }
  return skillDir;
}

/** 计算某个技能的更新状态（不发起网络请求）。 */
export function getUpdateState(skillPath, meta, manifest) {
  const entry = manifest?.skills?.[skillPath] || {};
  const version = meta.version || entry.installedVersion || null;
  const source = meta.repository || entry.source || null;
  const latestVersion = entry.latestVersion || null;
  if (!source) {
    return { version, source: null, latestVersion: null, updateAvailable: false, updateState: "no-source", lastCheckedAt: entry.lastCheckedAt || null, lastError: null };
  }
  if (!version) {
    return { version: null, source, latestVersion, updateAvailable: false, updateState: "no-version", lastCheckedAt: entry.lastCheckedAt || null, lastError: null };
  }
  if (!latestVersion) {
    return { version, source, latestVersion: null, updateAvailable: false, updateState: entry.lastError ? "check-failed" : "unknown", lastCheckedAt: entry.lastCheckedAt || null, lastError: entry.lastError || null };
  }
  const cmp = compareVersions(version, latestVersion);
  if (cmp === null) {
    return { version, source, latestVersion, updateAvailable: false, updateState: "check-failed", lastCheckedAt: entry.lastCheckedAt || null, lastError: entry.lastError || "invalid-version" };
  }
  const updateAvailable = cmp < 0;
  return {
    version,
    source,
    latestVersion,
    updateAvailable,
    updateState: updateAvailable ? "available" : "latest",
    lastCheckedAt: entry.lastCheckedAt || null,
    lastError: entry.lastError || null
  };
}

/** 检查单个技能更新并写入本地清单。返回更新状态。 */
export async function checkUpdateForSkill(skillPath, meta, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const now = options.now || Date.now;
  const manifest = readManifest();
  const entry = manifest.skills[skillPath] || {};
  const source = meta.repository || entry.source || null;
  if (!source) {
    return getUpdateState(skillPath, meta, manifest);
  }
  if (!meta.version && !entry.installedVersion) {
    return getUpdateState(skillPath, meta, manifest);
  }
  try {
    const release = await fetchLatestRelease(source, fetchImpl);
    const normalized = release.version;
    const latestVersion = normalized || release.tag;
    const state = {
      source,
      sourcePath: meta.sourcePath || entry.sourcePath || null,
      installedVersion: meta.version || entry.installedVersion || null,
      installedAt: entry.installedAt || null,
      lastCheckedAt: now(),
      latestVersion,
      latestTag: release.tag,
      updateAvailable: normalized ? compareVersions(meta.version || entry.installedVersion, normalized) < 0 : false,
      lastError: null
    };
    manifest.skills[skillPath] = state;
    writeManifest(manifest);
    return getUpdateState(skillPath, meta, manifest);
  } catch (error) {
    manifest.skills[skillPath] = {
      ...entry,
      source,
      sourcePath: meta.sourcePath || entry.sourcePath || null,
      installedVersion: meta.version || entry.installedVersion || null,
      lastCheckedAt: now(),
      lastError: String(error?.message || error)
    };
    writeManifest(manifest);
    return getUpdateState(skillPath, meta, manifest);
  }
}
