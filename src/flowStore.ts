import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { FlowRole } from "./agents";

export const taskStatusSchema = z.enum(["pending", "in_progress", "completed", "blocked"]);
const taskSchema = z.object({ id: z.string().min(1), title: z.string().min(1), status: taskStatusSchema, detail: z.string() }).strict();
export const planSchema = z.object({
    analysis: z.string().min(1), scope: z.string().min(1), exclusions: z.string(), risks: z.string(),
    criteria: z.array(z.object({ id: z.string().min(1), text: z.string().min(1) }).strict()).min(1),
    tasks: z.array(taskSchema).min(1),
}).strict();
export type FlowPlan = z.infer<typeof planSchema>;
export const reportSchema = z.object({
    outcome: z.enum(["completed", "blocked", "failed"]), summary: z.string().min(1),
    changedFiles: z.array(z.string().min(1)),
    checks: z.array(z.object({ command: z.string().min(1), outcome: z.enum(["pass", "fail", "not_run"]), detail: z.string().min(1) }).strict()),
    criteria: z.array(z.object({ id: z.string().min(1), outcome: z.enum(["pass", "fail", "not_run"]), evidence: z.string().min(1) }).strict()),
    findings: z.array(z.object({ severity: z.enum(["high", "medium", "low"]), file: z.string(), line: z.number().int().nonnegative(), detail: z.string().min(1) }).strict()),
}).strict();
export type FlowReport = z.infer<typeof reportSchema>;
const phaseSchema = z.enum(["planning", "awaiting_approval", "developing", "verifying", "awaiting_correction", "completed", "blocked"]);
const flowSchema = z.object({
    version: z.literal(1), id: z.uuid(), title: z.string().min(1), request: z.string().min(1),
    createdAt: z.string(), updatedAt: z.string(), closed: z.boolean(), phase: phaseSchema,
    revision: z.number().int().nonnegative(), approvedRevision: z.number().int().nonnegative().nullable(),
    pendingPlanRequest: z.string().nullable(),
    plan: planSchema.nullable(), exploration: z.string(),
    discussions: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string() }).strict()),
    revisions: z.array(z.object({ revision: z.number().int(), request: z.string(), plan: planSchema }).strict()),
    reports: z.array(z.object({ role: z.enum(["Developer", "Verifier", "Reviewer"]), revision: z.number().int(), at: z.string(), report: reportSchema, stale: z.boolean() }).strict()),
    events: z.array(z.object({ at: z.string(), text: z.string() }).strict()),
    running: z.enum(["Planner", "Developer", "Verifier", "Reviewer"]).nullable(),
}).strict();
export type Flow = z.infer<typeof flowSchema>;

export class FlowStore {
    private readonly directory: string;
    private readonly activeFile: string;

    constructor(workspace: string) {
        this.directory = path.join(workspace, ".corbecode", "workflows");
        this.activeFile = path.join(workspace, ".corbecode", "active-flow.json");
        mkdirSync(this.directory, { recursive: true });
    }

    private atomicWrite(file: string, content: string): void {
        if (existsSync(file) && readFileSync(file, "utf8") === content) return;
        const temporary = `${file}.${randomUUID()}.tmp`;
        try {
            writeFileSync(temporary, content, "utf8");
            for (let attempt = 0; ; attempt += 1) {
                try {
                    renameSync(temporary, file);
                    break;
                } catch (error) {
                    const code = (error as NodeJS.ErrnoException).code;
                    if (process.platform !== "win32" || attempt >= 3 || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) throw error;
                    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
                }
            }
        } finally {
            if (existsSync(temporary)) unlinkSync(temporary);
        }
    }

    getDirectory(id: string): string {
        return path.join(this.directory, z.uuid().parse(id));
    }

    load(id: string): Flow {
        const flow = flowSchema.parse(JSON.parse(readFileSync(path.join(this.getDirectory(id), "state.json"), "utf8")));
        if (flow.id !== id) throw new Error("Workflow ID does not match its directory");
        return flow;
    }

    current(): Flow | undefined {
        if (!existsSync(this.activeFile)) return undefined;
        const id = z.object({ id: z.uuid().nullable() }).strict().parse(JSON.parse(readFileSync(this.activeFile, "utf8"))).id;
        return id ? this.load(id) : undefined;
    }

    list(): Flow[] {
        return readdirSync(this.directory, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && z.uuid().safeParse(entry.name).success)
            .map((entry) => this.load(entry.name)).sort((first, second) => second.updatedAt.localeCompare(first.updatedAt));
    }

    readExploration(): string {
        const file = path.join(this.directory, "exploration.json");
        return existsSync(file) ? z.string().parse(JSON.parse(readFileSync(file, "utf8"))) : "";
    }

    appendExploration(text: string): void {
        this.atomicWrite(path.join(this.directory, "exploration.json"), JSON.stringify([this.readExploration(), text].filter(Boolean).join("\n\n")));
    }

    clearExploration(): void {
        this.atomicWrite(path.join(this.directory, "exploration.json"), JSON.stringify(""));
    }

    private select(id: string | null): void {
        this.atomicWrite(this.activeFile, JSON.stringify({ id }));
    }

    save(flow: Flow, event?: string): void {
        flow.updatedAt = new Date().toISOString();
        if (event) flow.events.push({ at: flow.updatedAt, text: event });
        flowSchema.parse(flow);
        const directory = this.getDirectory(flow.id);
        mkdirSync(directory, { recursive: true });
        this.atomicWrite(path.join(directory, "state.json"), JSON.stringify(flow, null, 2));
        this.atomicWrite(path.join(directory, "plan.md"), this.renderPlan(flow));
        this.atomicWrite(path.join(directory, "tasks.md"), this.renderTasks(flow));
        this.atomicWrite(path.join(directory, "reports.md"), this.renderReports(flow));
        this.atomicWrite(path.join(directory, "exploration.md"), `# Exploration\n\n${flow.exploration}\n\n${flow.discussions.map((entry) => `## ${entry.role}\n\n${entry.text}`).join("\n\n")}\n`);
    }

    create(request: string, exploration = ""): Flow {
        if (!request.trim()) throw new Error("Usage: /flow:propose <request>");
        if (this.current()) throw new Error("Pause or close the current change before proposing another.");
        const now = new Date().toISOString();
        const flow: Flow = {
            version: 1, id: randomUUID(), title: request.trim().replace(/\s+/g, " ").slice(0, 100), request: request.trim(),
            createdAt: now, updatedAt: now, closed: false, phase: "planning", revision: 0, approvedRevision: null,
            pendingPlanRequest: null,
            plan: null, exploration, discussions: [], revisions: [], reports: [], events: [], running: null,
        };
        this.save(flow, "Change created; implementation not authorized.");
        this.select(flow.id);
        return flow;
    }

    requireCurrent(): Flow {
        const flow = this.current();
        if (!flow || flow.closed) throw new Error("No current open change. Use /flow:propose or /flow:resume.");
        return flow;
    }

    resume(id: string): Flow {
        const matches = this.list().filter((flow) => flow.id.startsWith(id));
        if (matches.length !== 1) throw new Error("Change ID is missing, ambiguous or unknown.");
        const flow = matches[0]!;
        const current = this.current();
        if (current?.running) throw new Error("Interrupt the running subagent before switching changes.");
        flow.closed = false;
        if (flow.running) {
            flow.running = null;
            flow.phase = "blocked";
        }
        this.save(flow, "Resumed; inspect workspace before continuing. No execution started.");
        this.select(flow.id);
        return flow;
    }

    pause(): void {
        const flow = this.requireCurrent();
        if (flow.running) throw new Error("Interrupt the running subagent before pausing.");
        this.save(flow, "Paused.");
        this.select(null);
    }

    recover(): Flow | undefined {
        const flow = this.current();
        if (flow?.running) {
            flow.running = null;
            flow.phase = "blocked";
            this.save(flow, "Previous execution interrupted; no task assumed completed.");
        }
        return flow;
    }

    setPlan(flow: Flow, input: FlowPlan, request: string): void {
        const plan = planSchema.parse(input);
        for (const entries of [plan.tasks, plan.criteria]) {
            if (new Set(entries.map((entry) => entry.id)).size !== entries.length) throw new Error("Plan IDs must be unique.");
        }
        for (const task of plan.tasks) {
            const previous = flow.plan?.tasks.find((entry) => entry.id === task.id);
            if (task.status === "in_progress" || (task.status === "completed" && (previous?.status !== "completed" || previous.title !== task.title))) {
                throw new Error("Planner cannot mark new or changed tasks completed or in progress.");
            }
        }
        flow.revision += 1;
        flow.plan = plan;
        flow.revisions.push({ revision: flow.revision, request, plan: structuredClone(plan) });
        flow.approvedRevision = null;
        flow.pendingPlanRequest = null;
        flow.phase = "awaiting_approval";
        for (const report of flow.reports) report.stale = true;
        this.save(flow, `Plan revision ${flow.revision} prepared; /flow:apply required.`);
    }

    approve(flow: Flow): void {
        if (!flow.plan || flow.running || flow.closed) throw new Error("There is no idle open plan to approve.");
        if (flow.pendingPlanRequest) throw new Error("A planning request is unresolved. Complete /flow:update before applying.");
        if (flow.phase === "completed") throw new Error("Already completed. Use /flow:update to plan additional work.");
        flow.approvedRevision = flow.revision;
        this.save(flow, `User approved revision ${flow.revision} and its current correction findings.`);
    }

    begin(flow: Flow, role: FlowRole): void {
        if (flow.closed || flow.running) throw new Error("Change is closed or already running.");
        if (role !== "Planner" && !flow.plan) throw new Error("Prepare a plan first.");
        if ((role === "Developer" || role === "Verifier") && flow.approvedRevision !== flow.revision) throw new Error("Current plan is not approved.");
        if (role === "Verifier" && flow.phase !== "verifying") throw new Error("Verification must follow completed development.");
        flow.running = role;
        if (role === "Planner") flow.approvedRevision = null;
        if (role !== "Reviewer") flow.phase = role === "Planner" ? "planning" : role === "Developer" ? "developing" : "verifying";
        if (role === "Developer") for (const report of flow.reports) report.stale = true;
        this.save(flow, `${role} started.`);
    }

    progress(flow: Flow, id: string, status: z.infer<typeof taskStatusSchema>, detail: string): void {
        if (flow.running !== "Developer" || flow.approvedRevision !== flow.revision) throw new Error("Only the approved Developer can update tasks.");
        const task = flow.plan?.tasks.find((entry) => entry.id === id);
        if (!task) throw new Error(`Unknown task: ${id}`);
        task.status = status;
        task.detail = detail;
        this.save(flow, `${id}: ${status} - ${detail}`);
    }

    finish(flow: Flow, role: Exclude<FlowRole, "Planner">, input: FlowReport): void {
        if (flow.running !== role) throw new Error("Unexpected reporting agent.");
        const report = reportSchema.parse(input);
        if (role === "Verifier") {
            const expected = flow.plan!.criteria.map((entry) => entry.id);
            if (report.criteria.length !== expected.length || new Set(report.criteria.map((entry) => entry.id)).size !== expected.length || report.criteria.some((entry) => !expected.includes(entry.id))) {
                throw new Error("Verifier must report each acceptance criterion exactly once.");
            }
            const passed = report.outcome === "completed" && report.criteria.every((entry) => entry.outcome === "pass")
                && report.checks.length > 0 && report.checks.every((entry) => entry.outcome === "pass")
                && report.findings.length === 0 && flow.plan!.tasks.every((entry) => entry.status === "completed");
            flow.phase = passed ? "completed" : "awaiting_correction";
        } else if (role === "Developer") {
            flow.phase = report.outcome === "completed" && flow.plan!.tasks.every((entry) => entry.status === "completed") ? "verifying" : "blocked";
        }
        flow.reports.push({ role, revision: flow.revision, at: new Date().toISOString(), report, stale: false });
        flow.running = null;
        this.save(flow, `${role} finished: ${report.outcome}.`);
    }

    interrupt(flow: Flow, reason: string): void {
        const role = flow.running;
        flow.running = null;
        if (role !== "Reviewer") flow.phase = "blocked";
        this.save(flow, `Interrupted or blocked: ${reason}`);
    }

    end(flow: Flow, allowIncomplete = false): void {
        if (flow.running) throw new Error("Interrupt the running subagent before closing.");
        if (flow.phase !== "completed" && !allowIncomplete) throw new Error("Closing an incomplete change requires explicit confirmation.");
        flow.closed = true;
        this.save(flow, flow.phase === "completed" ? "Closed with verification passed." : "Closed incomplete by user confirmation.");
        if (this.current()?.id === flow.id) this.select(null);
    }

    renderPlan(flow: Flow): string {
        const plan = flow.plan;
        return `# ${flow.title}\n\nID: ${flow.id}\nRevision: ${flow.revision}\nApproved revision: ${flow.approvedRevision ?? "none"}\nPhase: ${flow.phase}\nClosed: ${flow.closed}\n\n## Request\n\n${flow.request}\n\n${plan ? `## Analysis\n\n${plan.analysis}\n\n## Scope\n\n${plan.scope}\n\n## Exclusions\n\n${plan.exclusions}\n\n## Risks\n\n${plan.risks}\n\n## Acceptance criteria\n\n${plan.criteria.map((entry) => `- ${entry.id}: ${entry.text}`).join("\n")}` : "Plan not available yet."}\n`;
    }

    renderTasks(flow: Flow): string {
        return `# Tasks - revision ${flow.revision}\n\n${flow.plan?.tasks.map((task) => `- [${task.status === "completed" ? "x" : " "}] ${task.id}: ${task.title} (${task.status})\n  ${task.detail}`).join("\n") ?? "No tasks yet."}\n`;
    }

    renderReports(flow: Flow): string {
        return `# Reports\n\n${flow.reports.map((entry) => `## ${entry.role} - revision ${entry.revision}${entry.stale ? " (outdated)" : ""}\n\n${entry.report.summary}\n\nOutcome: ${entry.report.outcome}\n\nFiles: ${entry.report.changedFiles.join(", ")}\n\n${entry.report.checks.map((check) => `- ${check.command}: ${check.outcome} - ${check.detail}`).join("\n")}\n\n${entry.report.criteria.map((criterion) => `- ${criterion.id}: ${criterion.outcome} - ${criterion.evidence}`).join("\n")}\n\n${entry.report.findings.map((finding) => `- ${finding.severity}: ${finding.file}:${finding.line} - ${finding.detail}`).join("\n")}`).join("\n\n")}\n\n## History\n\n${flow.events.map((event) => `- ${event.at}: ${event.text}`).join("\n")}\n`;
    }
}