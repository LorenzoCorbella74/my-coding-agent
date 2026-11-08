import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { FlowStore, type FlowPlan, type FlowReport } from "./flowStore";

const plan = (): FlowPlan => ({ analysis: "Inspect auth", scope: "Login", exclusions: "SSO", risks: "Sessions", criteria: [{ id: "AC1", text: "Login works" }], tasks: [{ id: "T1", title: "Add login", status: "pending", detail: "" }] });
const report = (): FlowReport => ({ outcome: "completed", summary: "Checked login", changedFiles: ["src/auth.ts"], checks: [{ command: "npm test", outcome: "pass", detail: "1 passed" }], criteria: [{ id: "AC1", outcome: "pass", evidence: "Login test passes" }], findings: [] });

test("workflow approval, live progress, verification, update and durable resume", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "corbecode-flow-"));
    try {
        const store = new FlowStore(workspace);
        const flow = store.create("Add login", "Considered SSO");
        assert.throws(() => store.create("Second"), /Pause or close/);
        store.setPlan(flow, plan(), flow.request);
        assert.throws(() => store.begin(flow, "Developer"), /not approved/);
        store.approve(flow);
        store.begin(flow, "Developer");
        assert.throws(() => store.pause(), /Interrupt/);
        store.progress(flow, "T1", "in_progress", "Implementing login");
        assert.equal(new FlowStore(workspace).current()?.plan?.tasks[0]?.status, "in_progress");
        store.progress(flow, "T1", "completed", "Login implemented and tested");
        store.finish(flow, "Developer", report());
        store.begin(flow, "Verifier");
        store.finish(flow, "Verifier", report());
        assert.equal(flow.phase, "completed");
        assert.throws(() => store.approve(flow), /Already completed/);
        store.begin(flow, "Reviewer");
        store.finish(flow, "Reviewer", report());
        assert.equal(flow.phase, "completed");
        const updated = structuredClone(flow.plan!);
        updated.tasks.push({ id: "T2", title: "Add password recovery", status: "pending", detail: "" });
        store.setPlan(flow, updated, "Add recovery");
        assert.equal(flow.approvedRevision, null);
        assert.equal(flow.plan?.tasks[0]?.status, "completed");
        assert.equal(flow.reports.every((entry) => entry.stale), true);
        assert.throws(() => store.begin(flow, "Developer"), /not approved/);
        assert.throws(() => store.end(flow), /confirmation/);
        store.end(flow, true);
        assert.equal(store.current(), undefined);
        const resumed = new FlowStore(workspace).resume(flow.id.slice(0, 8));
        assert.equal(resumed.closed, false);
        assert.equal(resumed.running, null);
        assert.equal(resumed.revision, 2);
        assert.equal(resumed.revisions.length, 2);
        assert.match(readFileSync(path.join(store.getDirectory(flow.id), "tasks.md"), "utf8"), /T2.*pending/);
        store.pause();
        const second = store.create("Another change");
        store.resume(flow.id);
        assert.equal(store.current()?.id, flow.id);
        assert.equal(store.load(second.id).closed, false);
        assert.throws(() => store.load("../escape"));
    } finally {
        rmSync(workspace, { recursive: true, force: true });
    }
});

test("rejects manufactured completion, missing evidence and invalid task updates", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "corbecode-flow-validation-"));
    try {
        const store = new FlowStore(workspace);
        const flow = store.create("Login");
        const invalid = plan();
        invalid.tasks[0]!.status = "completed";
        assert.throws(() => store.setPlan(flow, invalid, "Login"), /cannot mark/);
        store.setPlan(flow, plan(), "Login");
        assert.throws(() => store.progress(flow, "T1", "completed", "Fake"), /Only the approved/);
        store.approve(flow);
        store.begin(flow, "Developer");
        assert.throws(() => store.progress(flow, "T2", "completed", "Unknown"), /Unknown task/);
        store.progress(flow, "T1", "completed", "Done");
        store.finish(flow, "Developer", report());
        store.begin(flow, "Verifier");
        assert.throws(() => store.finish(flow, "Verifier", { ...report(), criteria: [] }), /each acceptance/);
        store.finish(flow, "Verifier", { ...report(), checks: [] });
        assert.equal(flow.phase, "awaiting_correction");
        store.approve(flow);
        store.begin(flow, "Developer");
        store.progress(flow, "T1", "in_progress", "Interrupted correction");
        const recovered = new FlowStore(workspace).recover()!;
        assert.equal(recovered.phase, "blocked");
        assert.equal(recovered.running, null);
        assert.equal(recovered.plan?.tasks[0]?.status, "in_progress");
    } finally {
        rmSync(workspace, { recursive: true, force: true });
    }
});