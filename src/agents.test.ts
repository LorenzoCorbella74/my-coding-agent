import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AgentLoader, DEFAULT_AGENTS, selectAgentTools, selectDiscussionTools, selectFlowTools } from "./agents";
import { parseFrontmatter } from "./frontmatter";

const tools = {
    read_file: {}, read_files: {}, explore_workspace: {}, searchCode: {},
    edit_file: {}, write_file: {}, shell: {}, skill_get: {},
};

test("loads Copilot-style YAML agents and enforces tool permissions", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "corbecode-agents-"));
    const directory = path.join(workspace, ".corbecode", "agents");
    mkdirSync(directory, { recursive: true });
    try {
        assert.match(new AgentLoader(workspace, tools).getDescriptions(), /Planner: Analyze requests/);
        writeFileSync(path.join(directory, "review.agent.md"), [
            "---", 'name: "Reviewer"', "description: >-", "  Review code:",
            "  find correctness bugs.", "tools:", "  - read", "  - search",
            "---", "Do not modify files.",
        ].join("\r\n"));
        writeFileSync(path.join(directory, "chat.md"), "---\ndescription: Chat only\ntools: []\n---\nAnswer questions.");
        const loader = new AgentLoader(workspace, tools);
        const agent = loader.get("Reviewer");
        assert.equal(agent.description, "Review code: find correctness bugs.");
        assert.equal(agent.body, "Do not modify files.");
        assert.match(loader.getDescriptions(), /Reviewer: Review code/);
        assert.deepEqual(Object.keys(selectAgentTools(tools, agent.tools)), ["read_file", "read_files", "explore_workspace", "searchCode"]);
        assert.deepEqual(selectAgentTools(tools, loader.get("chat").tools), {});
        assert.deepEqual(selectAgentTools(tools, undefined), tools);
        assert.deepEqual(selectAgentTools(tools, ["*"]), tools);
        assert.deepEqual(selectAgentTools(tools, ["shell"]), { shell: tools.shell });
        assert.deepEqual(Object.keys(selectAgentTools(tools, ["Read", "Grep"])), ["read_file", "read_files", "explore_workspace", "searchCode"]);
        assert.deepEqual(selectAgentTools(tools, ["Bash"]), { shell: tools.shell });
        assert.match(loader.getDescriptions(), /chat: Chat only \(tools: none\)/);
        assert.throws(() => loader.get("missing"), /not found/);
        assert.throws(() => selectAgentTools(tools, ["task"]), /unavailable/);
        assert.deepEqual(parseFrontmatter("---\ntools: read, search\n---\nInstructions").meta, { tools: "read, search" });
        writeFileSync(path.join(directory, "writer.md"), "---\ndescription: Write files\ntools: 'edit, execute'\n---\nImplement.");
        assert.deepEqual(new AgentLoader(workspace, tools).get("writer").tools, ["edit", "execute"]);
        writeFileSync(path.join(directory, "bad.md"), "---\ndescription: Invalid\ntools: [unknown]\n---\nAct.");
        assert.throws(() => new AgentLoader(workspace, tools), /bad.md.*Unknown or unavailable/s);
        writeFileSync(path.join(directory, "bad.md"), "---\nname: Reviewer\ndescription: Duplicate\n---\nAct.");
        assert.throws(() => new AgentLoader(workspace, tools), /Duplicate agent name/);
        writeFileSync(path.join(directory, "bad.md"), "---\ndescription: Invalid\ntools: [\n---\nAct.");
        assert.throws(() => new AgentLoader(workspace, tools), /Invalid custom agent/);
        writeFileSync(path.join(directory, "bad.md"), "---\ndescription: Invalid\nmodel: unsupported\n---\nAct.");
        assert.throws(() => new AgentLoader(workspace, tools), /Unrecognized key/);
        assert.throws(() => parseFrontmatter("---\nname: unfinished"), /Unclosed/);
        assert.deepEqual(parseFrontmatter("---\r\nname: test\r\ndescription: 'Use when: testing'\r\n---\r\nBody"), {
            meta: { name: "test", description: "Use when: testing" }, body: "Body",
        });

    } finally {
        rmSync(workspace, { recursive: true, force: true });
    }
});

test("accepts boolean user-invocable without disabling subagent discovery", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "corbecode-agent-invocation-"));
    const directory = path.join(workspace, ".corbecode", "agents");
    mkdirSync(directory, { recursive: true });
    const file = path.join(directory, "planner.md");
    try {
        for (const value of [true, false]) {
            writeFileSync(file, `---\nname: Planner\ndescription: Plan tasks\ntools: [read]\nuser-invocable: ${value}\n---\nPlan without editing files.`);
            const loader = new AgentLoader(workspace, tools);
            assert.equal(loader.get("Planner").name, "Planner");
            assert.match(loader.getDescriptions(), /Planner: Plan tasks/);
            assert.deepEqual(Object.keys(selectAgentTools(tools, loader.get("Planner").tools)), ["read_file", "read_files"]);
        }
        writeFileSync(file, "---\ndescription: Plan tasks\nuser-invocable: 'false'\n---\nPlan.");
        assert.throws(() => new AgentLoader(workspace, tools), /user-invocable/);
    } finally {
        rmSync(workspace, { recursive: true, force: true });
    }
});

test("ships four default agents and supports explicit workflow role mapping", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "corbecode-default-agents-"));
    try {
        const loader = new AgentLoader(workspace, tools);
        for (const role of ["Planner", "Developer", "Verifier", "Reviewer"] as const) {
            assert.equal(loader.getFlowAgent(role, workspace), DEFAULT_AGENTS[role]);
        }
        assert.equal(Object.hasOwn(selectAgentTools(tools, DEFAULT_AGENTS.Planner.tools), "shell"), false);
        assert.equal(Object.hasOwn(selectAgentTools(tools, DEFAULT_AGENTS.Verifier.tools), "edit_file"), false);
        writeFileSync(path.join(workspace, ".corbecode", "flow-agents.json"), JSON.stringify({ Planner: "Reviewer" }));
        assert.equal(loader.getFlowAgent("Planner", workspace).name, "Reviewer");
        writeFileSync(path.join(workspace, ".corbecode", "flow-agents.json"), JSON.stringify({ Planner: "missing" }));
        assert.throws(() => loader.getFlowAgent("Planner", workspace), /not found/);
    } finally {
        rmSync(workspace, { recursive: true, force: true });
    }
});

test("workflow role caps cannot be bypassed by custom agents or chat delegation", () => {
    const unrestricted = { ...DEFAULT_AGENTS.Developer, tools: ["*"] };
    assert.deepEqual(Object.keys(selectFlowTools(tools, "Planner", unrestricted)), ["read_file", "read_files", "explore_workspace", "searchCode", "skill_get"]);
    assert.equal(Object.hasOwn(selectFlowTools(tools, "Verifier", unrestricted), "edit_file"), false);
    assert.equal(Object.hasOwn(selectFlowTools(tools, "Reviewer", unrestricted), "shell"), false);
    const discussion = selectDiscussionTools({ ...tools, task: {} });
    for (const name of ["shell", "edit_file", "write_file", "task"]) assert.equal(Object.hasOwn(discussion, name), false);
});
