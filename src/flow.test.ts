import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { FlowController, flowChatContext, validateVerificationEvidence, type FlowAgentRun } from "./flow";
import { FlowStore, type FlowPlan, type FlowReport } from "./flowStore";
import { executeCommandWithResult } from "./tools/commands";

const plan: FlowPlan = { analysis: "Analysis", scope: "Auth", exclusions: "SSO", risks: "Sessions", criteria: [{ id: "AC1", text: "Login" }], tasks: [{ id: "T1", title: "Implement", status: "pending", detail: "" }] };
const report: FlowReport = { outcome: "completed", summary: "Done", changedFiles: ["src/auth.ts"], checks: [{ command: "npm test", outcome: "pass", detail: "Passed" }], criteria: [{ id: "AC1", outcome: "pass", evidence: "Test" }], findings: [] };

test("explicit commands orchestrate agents; rejected apply never develops", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "corbecode-flow-commands-"));
    try {
        const store = new FlowStore(workspace);
        const roles: string[] = [];
        let accepted = false;
        let verificationPasses = false;
        const runAgent = async (run: FlowAgentRun) => {
            roles.push(run.role);
            if (run.explore) return "Consider password authentication";
            if (run.role === "Planner") run.submitPlan(structuredClone(plan));
            else if (run.role === "Developer") {
                run.progress("T1", "in_progress", "Working");
                run.progress("T1", "completed", "Implemented");
                run.submitReport(report);
            } else if (run.role === "Verifier") run.submitReport({ ...report, outcome: verificationPasses ? "completed" : "failed" });
            else run.submitReport(report);
            return "";
        };
        const controller = new FlowController(store, { runAgent, confirm: async () => accepted, select: async () => undefined, write: () => { } });
        await controller.execute("/flow:explore", "Auth options");
        assert.equal(store.current(), undefined);
        await controller.execute("/flow:propose", "Add login");
        assert.match(store.current()!.exploration, /password authentication/);
        assert.equal(store.current()!.phase, "awaiting_approval");
        await controller.execute("/flow:apply", "");
        assert.deepEqual(roles, ["Planner", "Planner"]);
        accepted = true;
        await controller.execute("/flow:apply", "");
        assert.equal(store.current()!.phase, "awaiting_correction");
        accepted = false;
        await controller.execute("/flow:apply", "");
        assert.equal(roles.length, 4);
        accepted = true;
        verificationPasses = true;
        await controller.execute("/flow:apply", "");
        assert.equal(store.current()!.phase, "completed");
        await controller.execute("/flow:apply", "");
        assert.equal(roles.length, 6);
        await controller.execute("/flow:review", "");
        assert.equal(store.current()!.phase, "completed");
        await controller.execute("/flow:update", "Change auth");
        assert.equal(store.current()!.approvedRevision, null);
        assert.match(flowChatContext(store.current()), /not implementation/);
        await controller.execute("/flow:pause", "");
        assert.match(flowChatContext(store.current()), /Ordinary chat mode/);
        assert.deepEqual(roles, ["Planner", "Planner", "Developer", "Verifier", "Developer", "Verifier", "Reviewer", "Planner"]);
    } finally {
        rmSync(workspace, { recursive: true, force: true });
    }
});

test("invalid or interrupted subagent output blocks the change without advancing", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "corbecode-flow-failure-"));
    try {
        const store = new FlowStore(workspace);
        const controller = new FlowController(store, { runAgent: async () => "Plain text is not a plan", confirm: async () => true, select: async () => undefined, write: () => { } });
        await assert.rejects(controller.execute("/flow:propose", "Login"), /structured result/);
        assert.equal(store.current()!.phase, "blocked");
        assert.equal(store.current()!.running, null);
        await assert.rejects(controller.execute("/flow:apply", ""), /No plan/);
        await controller.execute("/flow:end", "");
        assert.equal(store.current(), undefined);
    } finally {
        rmSync(workspace, { recursive: true, force: true });
    }
});

test("interrupted planning revision persists the request and cannot apply the old plan", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "corbecode-flow-update-failure-"));
    try {
        const store = new FlowStore(workspace);
        const flow = store.create("Login");
        store.setPlan(flow, plan, "Login");
        store.approve(flow);
        const controller = new FlowController(store, {
            runAgent: async () => { throw new Error("Cancelled"); },
            confirm: async () => true, select: async () => undefined, write: () => { },
        });
        await assert.rejects(controller.execute("/flow:update", "Add password recovery"), /Cancelled/);
        const saved = new FlowStore(workspace).current()!;
        assert.equal(saved.pendingPlanRequest, "Add password recovery");
        assert.equal(saved.approvedRevision, null);
        assert.equal(saved.revision, 1);
        await assert.rejects(controller.execute("/flow:apply", ""), /Planning is incomplete/);
    } finally {
        rmSync(workspace, { recursive: true, force: true });
    }
});

test("verification cannot claim success for unexecuted or failing commands", async () => {
    const executions = new Map<string, { exitCode: number | null; error: string | null }>();
    assert.throws(() => validateVerificationEvidence(report, executions), /successful execution/);
    executions.set("npm test", { exitCode: 1, error: null });
    assert.throws(() => validateVerificationEvidence(report, executions), /successful execution/);
    executions.set("npm test", { exitCode: 0, error: null });
    assert.doesNotThrow(() => validateVerificationEvidence(report, executions));
    const result = await executeCommandWithResult('node -e "process.exit(7)"');
    assert.notEqual(result.exitCode, 0);
    assert.equal(result.error, null);
});