import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readWorkspaceInstructions } from "./workspaceInstructions";

test("reads AGENTS.md from the workspace and allows it to be absent", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "corbeagent-instructions-"));
    try {
        assert.equal(await readWorkspaceInstructions(workspace), "");
        writeFileSync(path.join(workspace, "AGENTS.md"), "Use tabs.");
        assert.equal(await readWorkspaceInstructions(workspace), "Use tabs.");
    } finally {
        rmSync(workspace, { recursive: true, force: true });
    }
});
