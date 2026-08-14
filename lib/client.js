// dsh-skill-manager — browser half (v2)。
// 在 设置 注册「技能」分区：按来源分组列出已安装技能（名称/描述/来源/大小/文件数），
// 支持复制路径与删除用户技能。
window.__ModuleLoader__.load({
	id: "dsh-skill-manager",
	factory: (require) => {
		"use strict";
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var react = require("react");
		var h = react.createElement;

		var NS = "settings.skillManager";
		var zh = {
			nav: "技能",
			intro: "已安装的用户技能（按来源目录分组）。删除会移除整个目录，不可撤销；内置/随发行版技能不在此列出。",
			loading: "正在读取技能…",
			error: "暂时无法读取技能。",
			retry: "重试",
			none: "暂无用户技能。",
			search: "搜索技能",
			emptySearch: "没有匹配的技能。",
			model: "模型可调用",
			userOnly: "仅用户可调用",
			size: "大小",
			fileCount: "文件",
			total: "共 {count} 个技能 · 总大小 {size}",
			groupUser: "用户目录 (~/.agents/skills)",
			groupProject: "项目目录",
			groupDshHome: "DSH 目录",
			copyPath: "复制路径",
			copied: "已复制路径",
			deleteSkill: "删除",
			deleteConfirm: "确认删除技能 {name}？将从磁盘移除（{path}），不可撤销。",
			deleted: "已删除",
			deleteFailed: "删除失败"
		};
		var en = {
			nav: "Skills",
			intro: "Installed user skills, grouped by source directory. Deleting removes the directory and cannot be undone. Built-in / shipped skills are not listed here.",
			loading: "Loading skills…",
			error: "Failed to read skills.",
			retry: "Retry",
			none: "No user skills.",
			search: "Search skills",
			emptySearch: "No matching skills.",
			model: "Model-invocable",
			userOnly: "User-only",
			size: "Size",
			fileCount: "files",
			total: "{count} skills · {size} total",
			groupUser: "User (~/.agents/skills)",
			groupProject: "Project",
			groupDshHome: "DSH home",
			copyPath: "Copy path",
			copied: "Path copied",
			deleteSkill: "Delete",
			deleteConfirm: "Delete skill {name}? It will be removed from disk ({path}) and cannot be undone.",
			deleted: "Deleted",
			deleteFailed: "Delete failed"
		};

		function formatSize(bytes) {
			if (bytes < 1024) return bytes + " B";
			if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
			return (bytes / (1024 * 1024)).toFixed(1) + " MB";
		}

		function SkillManagerSection({ t, list, remove }) {
			// 每个状态必须是「一次 useState 调用返回的 [值, 设值] 对」
			var entriesState = react.useState(null);
			var entries = entriesState[0];
			var setEntries = entriesState[1];
			var errorState = react.useState(null);
			var error = errorState[0];
			var setError = errorState[1];
			var busyState = react.useState(null);
			var busy = busyState[0];
			var setBusy = busyState[1];
			var noticeState = react.useState(null);
			var notice = noticeState[0];
			var setNotice = noticeState[1];
			var requestState = react.useState(0);
			var request = requestState[0];
			var setRequest = requestState[1];
			var queryState = react.useState("");
			var query = queryState[0];
			var setQuery = queryState[1];

			var refresh = react.useCallback(function () {
				Promise.resolve().then(list).then(function (data) {
					setEntries(data.skills);
					setError(null);
				}, function (e) {
					setError(String((e && e.message) || e));
				});
			}, [list]);
			react.useEffect(function () { refresh(); }, [refresh, request]);

			var normalizedQuery = query.trim().toLocaleLowerCase();
			var visible = entries === null ? [] : entries.filter(function (skill) {
				if (normalizedQuery === "") return true;
				return String(skill.name).toLocaleLowerCase().includes(normalizedQuery)
					|| String(skill.description).toLocaleLowerCase().includes(normalizedQuery)
					|| String(skill.path).toLocaleLowerCase().includes(normalizedQuery);
			});

			var onDelete = function (skill) {
				return function () {
					if (typeof window !== "undefined" && !window.confirm(t("deleteConfirm", { name: skill.name, path: skill.path }))) return;
					setBusy(skill.path);
					setNotice(null);
					remove(skill.path).then(function () {
						setNotice(t("deleted") + ": " + skill.name);
						refresh();
					}).catch(function (e) {
						setNotice(t("deleteFailed") + ": " + String((e && e.message) || e));
					}).finally(function () { setBusy(null); });
				};
			};
			var onCopy = function (skill) {
				return function () {
					try {
						if (typeof navigator !== "undefined" && navigator.clipboard) {
							navigator.clipboard.writeText(skill.path);
							setNotice(t("copied") + ": " + skill.path);
						}
					} catch { /* 剪贴板不可用时忽略 */ }
				};
			};

			var row = function (skill) {
				var badge = h("span", {
					style: {
						fontSize: "11px",
						flex: "none",
						color: skill.modelInvocable ? "var(--dsw-static-deepseek-500)" : "var(--dsw-alias-label-tertiary)",
						border: "1px solid " + (skill.modelInvocable ? "var(--dsw-static-deepseek-500)" : "var(--dsw-alias-border-l2)"),
						borderRadius: "8px",
						padding: "0 6px",
						lineHeight: "16px",
						marginLeft: "6px"
					}
				}, skill.modelInvocable ? t("model") : t("userOnly"));
				var copy = h("button", {
					type: "button",
					onClick: onCopy(skill),
					style: {
						font: "inherit",
						cursor: "pointer",
						background: "var(--dsw-alias-interactive-bg-hover)",
						color: "var(--dsw-alias-label-secondary)",
						border: "1px solid var(--dsw-alias-border-l2)",
						borderRadius: "14px",
						padding: "4px 12px",
						fontSize: "12px",
						lineHeight: "20px",
						flex: "none"
					}
				}, t("copyPath"));
				var del = h("button", {
					type: "button",
					disabled: busy === skill.path,
					onClick: onDelete(skill),
					style: {
						font: "inherit",
						cursor: "pointer",
						background: "transparent",
						color: "var(--dsw-alias-state-error-primary)",
						border: "1px solid var(--dsw-alias-state-error-primary)",
						borderRadius: "14px",
						padding: "4px 12px",
						fontSize: "13px",
						lineHeight: "20px",
						flex: "none"
					}
				}, t("deleteSkill"));
				return h("li", {
					key: skill.path,
					style: {
						display: "flex",
						alignItems: "center",
						gap: "10px",
						border: "1px solid var(--dsw-alias-border-l1)",
						borderRadius: "12px",
						padding: "10px 12px",
						background: "var(--dsw-alias-bg-layer-1)"
					}
				},
					h("div", { style: { minWidth: 0, flex: "auto" } },
						h("div", { style: { display: "flex", alignItems: "center", minWidth: 0 } },
							h("span", { style: { fontSize: "13px", fontWeight: 500, color: "var(--dsw-alias-label-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, skill.name),
							badge
						),
						h("div", { style: { fontSize: "12px", color: "var(--dsw-alias-label-secondary)", lineHeight: "18px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, skill.description || ""),
						h("div", { style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
							skill.path + " · " + t("size") + " " + formatSize(skill.size) + " · " + skill.fileCount + " " + t("fileCount")
						)
					),
					copy,
					del
				);
			};

			var content;
			if (error !== null) {
				content = h("div", { style: { display: "flex", alignItems: "center", gap: "8px" } },
					h("p", { style: { color: "var(--dsw-alias-state-error-primary)", fontSize: "13px", margin: 0 } }, t("error") + " " + error),
					h("button", { type: "button", onClick: function () { setRequest(function (v) { return v + 1; }); }, style: { font: "inherit", cursor: "pointer", background: "var(--dsw-alias-interactive-bg-hover)", color: "var(--dsw-alias-label-secondary)", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "12px", padding: "2px 10px", fontSize: "12px" } }, t("retry"))
				);
			} else if (entries === null) {
				content = h("p", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: "13px", margin: 0 } }, t("loading"));
			} else if (entries.length === 0) {
				content = h("p", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: "13px", margin: 0 } }, t("none"));
			} else if (visible.length === 0) {
				content = h("p", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: "13px", margin: 0 } }, t("emptySearch"));
			} else {
				var order = ["user", "project", "dsh-home"];
				var labels = { user: t("groupUser"), project: t("groupProject"), "dsh-home": t("groupDshHome") };
				var totalSize = visible.reduce(function (acc, s) { return acc + (s.size || 0); }, 0);
				content = h("div", { style: { display: "flex", flexDirection: "column", gap: "14px" } },
					h("p", { style: { margin: 0, fontSize: "12px", color: "var(--dsw-alias-label-tertiary)" } },
						t("total", { count: visible.length, size: formatSize(totalSize) })
					),
					order.map(function (src) {
						var group = visible.filter(function (s) { return s.source === src; });
						if (group.length === 0) return null;
						return h("div", { key: src, style: { display: "flex", flexDirection: "column", gap: "8px" } },
							h("div", { style: { fontSize: "12px", fontWeight: 600, color: "var(--dsw-alias-label-secondary)" } },
								labels[src] + " (" + group.length + ")"
							),
							h("ul", { style: { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "8px" } }, group.map(row))
						);
					})
				);
			}

			return h("div", { style: { display: "flex", flexDirection: "column", gap: "10px" } },
				h("p", { style: { margin: 0, fontSize: "13px", lineHeight: "20px", color: "var(--dsw-alias-label-tertiary)" } }, t("intro")),
				notice !== null ? h("p", { style: { margin: 0, fontSize: "13px", color: "var(--dsw-alias-label-secondary)" } }, notice) : null,
				h("label", { style: { display: "flex", alignItems: "center", gap: "8px" } },
					h("span", { style: { fontSize: "13px", color: "var(--dsw-alias-label-secondary)" } }, t("search")),
					h("input", {
						type: "search",
						value: query,
						placeholder: t("search"),
						onChange: function (event) { setQuery(event.currentTarget.value); },
						style: {
							font: "inherit",
							flex: "auto",
							maxWidth: "320px",
							background: "var(--dsw-alias-interactive-bg-hover)",
							color: "var(--dsw-alias-label-primary)",
							border: "1px solid var(--dsw-alias-border-l1)",
							borderRadius: "10px",
							padding: "4px 10px",
							fontSize: "13px",
							outline: "none"
						}
					})
				),
				content
			);
		}

		var inject = ["slots", "locale"];

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "ui-skill-manager: dictionaries");
			var t = ctx.locale.bind(NS);
			var list = async function () {
				var response = await fetch("/api/skill-manager/list");
				if (!response.ok) throw new Error("HTTP " + response.status);
				return await response.json();
			};
			var remove = async function (skillPath) {
				var response = await fetch("/api/skill-manager/delete", {
					method: "POST",
					headers: { "content-type": "application/json", "x-dsh-plugin-toggle": "1" },
					body: JSON.stringify({ path: skillPath })
				});
				var payload;
				try { payload = await response.json(); } catch { payload = null; }
				if (!response.ok) throw new Error((payload && payload.error) || ("HTTP " + response.status));
				return payload;
			};
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "skills",
				order: 20,
				label: () => t("nav"),
				locale: NS,
				inject: () => ({ list, remove })
			}, SkillManagerSection));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
