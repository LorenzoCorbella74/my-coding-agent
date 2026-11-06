import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { SessionStore } from "./sessionStore";

test("persists, resumes, restores, and replaces only the selected session", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "corbeagent-sessions-"));
    try {
        const store = new SessionStore(workspace);
        const first = store.resumeOrCreate();
        store.append(first.id, { role: "user", content: "first prompt" });
        store.append(first.id, { role: "assistant", content: "first reply" });

        const second = store.create();
        const restarted = new SessionStore(workspace).resumeOrCreate();
        assert.equal(restarted.id, second.id);
        assert.deepEqual(restarted.messages, []);

        const restored = store.restore(first.id.slice(0, 8));
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

        const ignoreRules = readFileSync(path.join(workspace, ".corbeagent", ".gitignore"), "utf8");
        assert.match(ignoreRules, /sessions\//);
        assert.match(ignoreRules, /active-session/);
    } finally {
        rmSync(workspace, { recursive: true, force: true });
    }
});