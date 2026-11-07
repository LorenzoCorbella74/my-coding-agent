import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { SessionStore } from "./sessionStore";

test("persists, resumes, restores, and replaces only the selected session", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "corbeagent-sessions-"));
    try {
        const store = new SessionStore(workspace);
        const first = store.resumeOrCreate();
        assert.ok(Number.isFinite(Date.parse(first.createdAt)));
        assert.deepEqual(first.approvedTools, []);
        assert.equal(first.title, "Nuova sessione");
        store.append(first.id, { role: "user", content: "first prompt" });
        store.append(first.id, { role: "assistant", content: "first reply" });
        store.approveTools(first.id, ["shell", "edit_file"]);

        const second = store.create();
        assert.deepEqual(second.approvedTools, []);
        const restarted = new SessionStore(workspace).resumeOrCreate();
        assert.equal(restarted.id, second.id);
        assert.deepEqual(restarted.messages, []);

        const restored = store.restore(first.id.slice(0, 8));
        assert.deepEqual(restored.approvedTools, ["shell", "edit_file"]);
        assert.equal(restored.title, "first prompt");
        assert.deepEqual(restored.messages, [
            { role: "user", content: "first prompt" },
            { role: "assistant", content: "first reply" },
        ]);
        assert.equal(store.list().length, 2);

        store.replace(restored.id, [{ role: "user", content: "compressed summary" }]);
        assert.deepEqual(store.restore(first.id).messages, [
            { role: "user", content: "compressed summary" },
        ]);
        assert.deepEqual(store.restore(second.id).messages, []);

        const activeState = JSON.parse(readFileSync(path.join(workspace, ".corbeagent", "active-session"), "utf8"));
        assert.equal(activeState.version, 1);
        assert.equal(activeState.activeSessionId, second.id);
        assert.equal(activeState.sessions[first.id].title, "first prompt");
        assert.deepEqual(activeState.sessions[first.id].approvedTools, ["shell", "edit_file"]);

        const ignoreRules = readFileSync(path.join(workspace, ".corbeagent", ".gitignore"), "utf8");
        assert.match(ignoreRules, /sessions\//);
        assert.match(ignoreRules, /active-session/);
    } finally {
        rmSync(workspace, { recursive: true, force: true });
    }
});

test("migrates the legacy active-session pointer to JSON", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "corbeagent-migration-"));
    try {
        const store = new SessionStore(workspace);
        const session = store.create();
        store.append(session.id, { role: "user", content: "legacy title" });
        writeFileSync(path.join(workspace, ".corbeagent", "active-session"), session.id);

        const resumed = new SessionStore(workspace).resumeOrCreate();
        const state = JSON.parse(readFileSync(path.join(workspace, ".corbeagent", "active-session"), "utf8"));
        assert.equal(resumed.id, session.id);
        assert.equal(state.activeSessionId, session.id);
        assert.equal(state.sessions[session.id].title, "legacy title");
    } finally {
        rmSync(workspace, { recursive: true, force: true });
    }
});