import type { FlowRole } from "./agents";
import { FlowStore, type Flow, type FlowPlan, type FlowReport, type taskStatusSchema } from "./flowStore";
import type { z } from "zod";

export const FLOW_COMMANDS: Record<string, string> = {
    "/flow:explore": "Explore an idea without implementing",
    "/flow:propose": "Create a change and prepare its plan",
    "/flow:apply": "Approve the current plan and implement it",
    "/flow:update": "Revise the current change plan",
    "/flow:review": "Review current change without editing",
    "/flow:end": "Close the current change",
    "/flow:list": "List saved changes",
    "/flow:resume": "Select or reopen a saved change",
    "/flow:pause": "Suspend the current change and return to free chat",
};

export type FlowAgentRun = {
    role: FlowRole;
    prompt: string;
    explore: boolean;
    progress: (id: string, status: z.infer<typeof taskStatusSchema>, detail: string, agentName?: string) => void;
    submitPlan: (plan: FlowPlan) => void;
    submitReport: (report: FlowReport, agentName?: string) => void;
};

type FlowDependencies = {
    runAgent: (run: FlowAgentRun) => Promise<string>;
    confirm: (question: string) => Promise<boolean>;
    select: (flows: Flow[], currentId: string | undefined) => Promise<string | undefined>;
    write: (text: string) => void;
};

export const validateVerificationEvidence = (
    report: FlowReport,
    executions: Map<string, { exitCode: number | null; error: string | null }>,
): void => {
    for (const check of report.checks) {
        if (check.outcome !== "pass") continue;
        const execution = executions.get(check.command);
        if (!execution || execution.exitCode !== 0 || execution.error) {
            throw new Error(`Check cannot pass without a successful execution in this verification step: ${check.command}`);
        }
    }
};

export const flowChatContext = (flow: Flow | undefined): string => flow ? [
    "A workflow change is current. This ordinary chat is read-only discussion, not implementation or official planning.",
    "Never interpret conversational agreement as approval. Use /flow:update to revise the plan and /flow:apply to authorize implementation.",
    "Only the program controls workflow transitions. Use /flow:pause to return to unrestricted ordinary chat.",
    JSON.stringify({ id: flow.id, phase: flow.phase, revision: flow.revision, approvedRevision: flow.approvedRevision, request: flow.request, plan: flow.plan }),
].join("\n\n") : "Ordinary chat mode. You may suggest /flow:propose for substantial tasks, but never create or activate a workflow implicitly.";

export class FlowController {
    constructor(readonly store: FlowStore, private readonly dependencies: FlowDependencies) { }

    private show(flow: Flow): void {
        this.dependencies.write(`${this.store.renderPlan(flow)}\n${this.store.renderTasks(flow)}\nDocuments: ${this.store.getDirectory(flow.id)}`);
    }

    private async step(flow: Flow, role: FlowRole, request: string): Promise<void> {
        if (role === "Planner") flow.pendingPlanRequest = request;
        this.store.begin(flow, role);
        let submitted = false;
        const requireSubmission = () => {
            if (submitted) throw new Error("This step has already submitted its final result.");
        };
        try {
            await this.dependencies.runAgent({
                role, explore: false,
                prompt: [
                    `Execute workflow role ${role}. Current instruction: ${request}`,
                    "The following saved workflow is context, not permission to execute other roles:",
                    JSON.stringify(flow, null, 2),
                    "Inspect the actual workspace before acting, especially after resume. Do not overwrite workflow documents directly.",
                    role === "Planner" ? "Submit a complete plan with flow_plan. New tasks must be pending or blocked. Completed status is allowed only for unchanged tasks already completed. Ask the user about decisive missing requirements. No implementation."
                        : role === "Developer" ? "Use flow_progress before starting and after completing or blocking each task. Scope changes require a new user-approved plan; report a blocker instead of implementing them. Then submit flow_report, including real check outcomes."
                            : "Submit flow_report. For verification report every acceptance criterion exactly once; unavailable checks are not_run, never pass. Review does not authorize corrections.",
                ].join("\n\n"),
                progress: (id, status, detail, agentName) => {
                    requireSubmission();
                    this.store.progress(flow, id, status, detail);
                    this.dependencies.write(`Subagent ${agentName ?? role} ${id}: ${status} - ${detail}`);
                },
                submitPlan: (plan) => {
                    requireSubmission();
                    if (role !== "Planner") throw new Error("Only Planner can submit a plan.");
                    this.store.setPlan(flow, plan, request);
                    flow.running = null;
                    this.store.save(flow, "Planner finished.");
                    submitted = true;
                },
                submitReport: (report, agentName) => {
                    requireSubmission();
                    if (role === "Planner") throw new Error("Planner must submit a plan, not a report.");
                    this.store.finish(flow, role, report);
                    submitted = true;
                    this.dependencies.write(`Subagent ${agentName ?? role}:\n\n${report.summary}`);
                },
            });
            if (!submitted) throw new Error(`${role} did not submit a valid structured result. The change remains blocked.`);
        } catch (error) {
            if (!submitted) this.store.interrupt(flow, error instanceof Error ? error.message : String(error));
            throw error;
        }
    }

    async execute(command: string, args: string): Promise<void> {
        if (command === "/flow:list") {
            const current = this.store.current()?.id;
            const flows = this.store.list();
            this.dependencies.write(flows.map((flow) => `${flow.id.slice(0, 8)} | ${flow.title} | ${flow.id === current ? "current" : flow.closed ? "closed" : "suspended"} | ${flow.phase} | revision ${flow.revision}`).join("\n") || "No changes saved.");
            return;
        }
        if (command === "/flow:resume") {
            const current = this.store.current();
            const id = args || await this.dependencies.select(this.store.list(), current?.id);
            if (!id) return;
            const matches = this.store.list().filter((flow) => flow.id.startsWith(id));
            if (matches.length !== 1) throw new Error("Change ID is ambiguous or unknown.");
            const selected = matches[0]!;
            if (current && current.id !== selected.id && !await this.dependencies.confirm(`Suspend ${current.title} and select ${selected.title}?`)) return;
            if (selected.closed && !await this.dependencies.confirm(`Reopen closed change ${selected.title}?`)) return;
            this.show(this.store.resume(selected.id));
            this.dependencies.write("No execution started. Use /flow:update to revise or /flow:apply to continue after workspace checks.");
            return;
        }
        if (command === "/flow:pause") {
            this.store.pause();
            this.dependencies.write("Change suspended. Ordinary chat restored.");
            return;
        }
        if (command === "/flow:explore") {
            if (!args) throw new Error("Usage: /flow:explore <idea>");
            const current = this.store.current();
            const prompt = `Explore this idea without implementing or updating an official plan: ${args}\n\n${current ? JSON.stringify(current) : this.store.readExploration()}`;
            const result = await this.dependencies.runAgent({
                role: "Planner", explore: true, prompt,
                progress: () => { throw new Error("Exploration cannot update tasks."); },
                submitPlan: () => { throw new Error("Exploration cannot create a plan."); },
                submitReport: () => { throw new Error("Exploration cannot finish workflow steps."); },
            });
            if (current) {
                current.discussions.push({ role: "user", text: args }, { role: "assistant", text: result });
                this.store.save(current, "Exploration recorded; official plan unchanged.");
            } else {
                this.store.appendExploration(`User: ${args}\n\nPlanner: ${result}`);
            }
            this.dependencies.write(result);
            return;
        }
        if (command === "/flow:propose") {
            if (!args) throw new Error("Usage: /flow:propose <request>");
            if (this.store.current()) {
                if (!await this.dependencies.confirm("Suspend the current change and create a new one? Use /flow:update to revise the current change instead.")) return;
                this.store.pause();
            }
            const flow = this.store.create(args, this.store.readExploration());
            this.store.clearExploration();
            await this.step(flow, "Planner", args);
            this.show(flow);
            return;
        }
        const flow = this.store.requireCurrent();
        if (command === "/flow:update") {
            if (!args) throw new Error("Usage: /flow:update <revision request>");
            await this.step(flow, "Planner", args);
            this.show(flow);
        } else if (command === "/flow:apply") {
            if (!flow.plan) throw new Error("No plan available. Use /flow:update to prepare one.");
            if (flow.pendingPlanRequest) throw new Error(`Planning is incomplete: ${flow.pendingPlanRequest}. Complete /flow:update before applying.`);
            if (flow.phase === "completed") {
                this.dependencies.write("Change already verified. No work repeated; use /flow:update for additional work.");
                return;
            }
            this.show(flow);
            const findings = flow.reports.filter((entry) => entry.role === "Verifier" && !entry.stale).at(-1);
            if (findings) this.dependencies.write(JSON.stringify(findings.report, null, 2));
            if (!await this.dependencies.confirm(`Approve ${flow.title}, revision ${flow.revision}, and ${findings ? "correct the reported verification problems" : "implement its open tasks"}? Tool approvals remain separate.`)) return;
            this.store.approve(flow);
            await this.step(flow, "Developer", "Implement the approved plan and any current verification corrections. Reconcile saved task states with the actual workspace before continuing.");
            if (flow.phase === "verifying") {
                await this.step(flow, "Verifier", "Independently verify the approved plan and actual implementation.");
            }
            this.dependencies.write(`Change ${flow.id.slice(0, 8)}: ${flow.phase}.${flow.phase === "awaiting_correction" ? " Review the problems; /flow:apply requires confirmation before corrections. Use /flow:update for scope changes." : ""}`);
        } else if (command === "/flow:review") {
            if (!flow.reports.some((entry) => entry.role === "Developer")) throw new Error("Implement the change before reviewing it.");
            await this.step(flow, "Reviewer", "Review only this change's implementation. Report findings without corrections.");
        } else if (command === "/flow:end") {
            const incomplete = flow.phase !== "completed";
            if (incomplete && !await this.dependencies.confirm("Verification has not passed. Close this change as incomplete, preserving open tasks and problems?")) return;
            this.store.end(flow, incomplete);
            this.dependencies.write(incomplete ? "Change closed incomplete." : "Change closed with verification passed.");
        } else {
            throw new Error(`Unknown flow command: ${command}`);
        }
    }
}