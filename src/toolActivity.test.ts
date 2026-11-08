import assert from "node:assert/strict";
import { test } from "node:test";
import { formatToolActivity } from "./toolActivity";

test("describes each tool action with an icon and a readable label", () => {
    assert.equal(formatToolActivity("read_file", { filePath: "src/a.ts" }), "▤ read: src/a.ts");
    assert.equal(formatToolActivity("read_files", { filePaths: ["a.ts", "b.ts"] }), "▦ read: a.ts, b.ts");
    assert.equal(formatToolActivity("edit_file", { filePath: "a.ts", oldText: "", newText: "" }), "✎ edit: a.ts");
    assert.equal(formatToolActivity("write_file", { filePath: "notes.md", content: "" }), "✚ write: notes.md");
    assert.equal(formatToolActivity("shell", { command: "npm test" }), "❯ bash: npm test");
    assert.equal(formatToolActivity("explore_workspace", {}), "⌕ explore: .");
    assert.equal(formatToolActivity("skill_get", { name: "pdf" }), "◈ skill: pdf");
    assert.equal(formatToolActivity("task", { task: "find routes", agent: "explore" }), "◎ subagent (explore): find routes");
    assert.equal(formatToolActivity("task", { task: "summarize" }), "◎ subagent: summarize");
});

test("keeps activity labels on one line and truncates long commands", () => {
    assert.equal(formatToolActivity("shell", { command: "echo a\n   echo b" }), "❯ bash: echo a echo b");
    const long = formatToolActivity("shell", { command: "x".repeat(500) });
    assert.ok(long.endsWith("…"));
    assert.ok(long.length < 140);
});

test("falls back to the tool name for unknown tools", () => {
    assert.equal(formatToolActivity("custom_tool", {}), "• custom_tool");
    assert.equal(formatToolActivity("toString", {}), "• toString");
});
