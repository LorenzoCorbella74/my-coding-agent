import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createMemoryTool, MemoryStore, memoryInputSchema } from "./memory";
import { createParentTools, TOOLS } from "./tools";
import { selectAgentTools } from "./agents";

test("persists scoped Markdown entries, updates keys and reloads project overrides without losing global preferences", () => {
    const root = mkdtempSync(path.join(tmpdir(), "corbecode-memory-"));
    const workspace = path.join(root, "workspace");
    const global = path.join(root, "global");
    const projectFile = path.join(workspace, ".corbecode", "memory.md");
    try {
        const store = new MemoryStore(workspace, global);
        assert.deepEqual(store.list("global"), {});
        assert.deepEqual(store.list("project"), {});
        assert.equal(existsSync(workspace), false);
        store.set("global", "response.language", "Italian");
        store.set("global", "coding.style", "Minimal: reuse | standard libraries");
        store.set("project", "response.language", "English");
        store.set("project", "tooling.package-manager", "npm");
        store.set("project", "tooling.package-manager", "pnpm");
        assert.equal(readFileSync(projectFile, "utf8").match(/- tooling.package-manager:/g)?.length, 1);
        const restored = new MemoryStore(workspace, global);
        const context = JSON.parse(restored.context().split("\n").at(-1)!);
        assert.deepEqual(context["response.language"], { scope: "project", value: "English" });
        assert.deepEqual(context["coding.style"], { scope: "global", value: "Minimal: reuse | standard libraries" });
        assert.equal(context["tooling.package-manager"].value, "pnpm");
        restored.delete("project", "response.language");
        const nextContext = JSON.parse(store.context().split("\n").at(-1)!);
        assert.equal(nextContext["response.language"].value, "Italian");
        assert.throws(() => store.delete("project", "missing"), /not found/);
        const other = new MemoryStore(path.join(root, "other-workspace"), global);
        assert.equal(other.list("global")["response.language"], "Italian");
        assert.deepEqual(other.list("project"), {});
        assert.match(readFileSync(projectFile, "utf8"), /^# Project memory\n\n- tooling.package-manager: pnpm\n$/);
        assert.equal(readdirSync(global).some((file) => file.endsWith(".tmp")), false);
        if (process.platform !== "win32") assert.equal(statSync(projectFile).mode & 0o777, 0o600);
        const home = path.join(root, "home");
        const overlapping = new MemoryStore(home, path.join(home, ".corbecode"));
        overlapping.set("global", "coding.style", "Minimal");
        assert.match(overlapping.context(), /Project memory is unavailable/);
        assert.throws(() => overlapping.set("project", "coding.style", "Different"), /overlap/);
        assert.equal(overlapping.list("global")["coding.style"], "Minimal");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("rejects malformed, duplicate, multiline and oversized entries without overwriting existing memory", () => {
    const root = mkdtempSync(path.join(tmpdir(), "corbecode-memory-invalid-"));
    const global = path.join(root, "global");
    const file = path.join(global, "memory.md");
    try {
        const store = new MemoryStore(path.join(root, "workspace"), global);
        store.set("global", "coding.style", "Minimal");
        const original = readFileSync(file, "utf8");
        assert.throws(() => store.set("global", "../escape", "bad"));
        assert.throws(() => store.set("global", "coding.style", "one\n- injected.key: two"));
        assert.throws(() => store.set("global", "coding.style", "one\u001btwo"));
        assert.equal(readFileSync(file, "utf8"), original);
        for (const invalid of ["# Memory\nfree-form text\n", "- duplicate.key: one\n- duplicate.key: two\n"]) {
            writeFileSync(file, invalid);
            assert.throws(() => store.list("global"), /Invalid or duplicate/);
            assert.throws(() => store.set("global", "new.key", "value"), /Invalid or duplicate/);
            assert.equal(readFileSync(file, "utf8"), invalid);
        }
        writeFileSync(file, "\uFEFF# User memory\r\n\r\n- coding.style: Minimal\r\n");
        assert.equal(store.list("global")["coding.style"], "Minimal");
        for (let index = 0; index < 16; index++) store.set("global", `entry.${index}`, "x".repeat(950));
        const beforeLimit = readFileSync(file, "utf8");
        assert.throws(() => store.set("global", "entry.too-large", "x".repeat(1000)), /16 KiB/);
        assert.equal(readFileSync(file, "utf8"), beforeLimit);
        writeFileSync(file, "x".repeat(16385));
        assert.throws(() => store.context(), /16 KiB/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("excludes project memory and temporary files from Git, preserves ignore rules and refuses tracked memory", () => {
    const root = mkdtempSync(path.join(tmpdir(), "corbecode-memory-git-"));
    const workspace = path.join(root, "workspace");
    const directory = path.join(workspace, ".corbecode");
    const file = path.join(directory, "memory.md");
    try {
        mkdirSync(directory, { recursive: true });
        const git = (...args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
        assert.equal(git("init", "--quiet").status, 0);
        const ignoreFile = path.join(directory, ".gitignore");
        writeFileSync(ignoreFile, "# Existing rules\n/cache/\n/memory.md\n!/memory.md");
        const store = new MemoryStore(workspace, path.join(root, "global"));
        store.set("project", "testing.command", "npm test");
        assert.match(readFileSync(ignoreFile, "utf8"), /^# Existing rules\n\/cache\//);
        for (const relative of ["workspace/.corbecode/memory.md", "workspace/.corbecode/memory.md.example.tmp"]) {
            assert.equal(git("check-ignore", "--quiet", "--", relative).status, 0);
        }
        const ignoreBeforeUpdate = readFileSync(ignoreFile, "utf8");
        store.set("project", "testing.command", "npm run test:unit");
        assert.equal(readFileSync(ignoreFile, "utf8"), ignoreBeforeUpdate);
        assert.equal(git("add", "--force", "--", "workspace/.corbecode/memory.md").status, 0);
        const beforeTracked = readFileSync(file, "utf8");
        assert.throws(() => store.set("project", "coding.style", "Minimal"), /tracked by Git/);
        assert.throws(() => store.delete("project", "testing.command"), /tracked by Git/);
        assert.equal(readFileSync(file, "utf8"), beforeTracked);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("does not follow a project memory directory symlink into global storage", () => {
    const root = mkdtempSync(path.join(tmpdir(), "corbecode-memory-links-"));
    const workspace = path.join(root, "workspace");
    const global = path.join(root, "global");
    try {
        mkdirSync(workspace);
        mkdirSync(global);
        const store = new MemoryStore(workspace, global);
        store.set("global", "coding.style", "Minimal");
        symlinkSync(global, path.join(workspace, ".corbecode"), process.platform === "win32" ? "junction" : "dir");
        assert.throws(() => store.list("project"), /symbolic link/);
        assert.throws(() => store.set("project", "coding.style", "Changed"), /symbolic link/);
        assert.equal(store.list("global")["coding.style"], "Minimal");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("validates and executes memory operations only through parent tools, including workflow discussion", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "corbecode-memory-tool-"));
    try {
        const store = new MemoryStore(path.join(root, "workspace"), path.join(root, "global"));
        const memory = createMemoryTool(store);
        const options = { toolCallId: "memory-test", messages: [], context: {} };
        assert.equal(memoryInputSchema.safeParse({ action: "list" }).success, false);
        assert.equal(memoryInputSchema.safeParse({ action: "set", scope: "global", key: "coding.style" }).success, false);
        assert.equal(memoryInputSchema.safeParse({ action: "delete", scope: "global", key: "coding.style", value: "extra" }).success, false);
        await memory.execute!({ action: "set", scope: "global", key: "coding.style", value: "Minimal" }, options);
        const listed = await memory.execute!({ action: "list", scope: "global" }, options);
        assert.ok(typeof listed === "string");
        assert.deepEqual(JSON.parse(listed), { scope: "global", entries: { "coding.style": "Minimal" } });
        await memory.execute!({ action: "delete", scope: "global", key: "coding.style" }, options);
        assert.deepEqual(store.list("global"), {});
        const controller = new AbortController();
        controller.abort();
        await assert.rejects(async () => createMemoryTool(store, controller.signal).execute!({
            action: "set", scope: "global", key: "coding.style", value: "Must not persist",
        }, options), /abort/i);
        assert.deepEqual(store.list("global"), {});
        const session = { id: "test", messages: [], createdAt: "", approvedTools: [], title: "" };
        const spinner = { start: (_label: string) => { }, stop: () => { } };
        for (const discussion of [false, true]) {
            const parent = createParentTools(session, spinner, () => { }, undefined, discussion);
            assert.equal(Object.hasOwn(parent, "memory"), true);
            assert.equal(Object.hasOwn(parent, "task"), !discussion);
        }
        assert.equal(Object.hasOwn(selectAgentTools(TOOLS, ["*"]), "memory"), false);
        assert.throws(() => selectAgentTools(TOOLS, ["memory"]), /unavailable/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
