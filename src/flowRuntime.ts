import path from "node:path";
import { tool, zodSchema, type ToolSet } from "ai";
import { z } from "zod";
import { AGENTS, TOOLS } from "./tools";
import { DEFAULT_AGENTS, selectFlowTools } from "./agents";
import { WORKDIR } from "./config";
import { askTerminal } from "./terminalInput";
import type { Session } from "./sessionStore";
import { withSpinner } from "./spinner";
import { runSubagent } from "./tools/subagents";
import { planSchema, reportSchema, taskStatusSchema } from "./flowStore";
import { validateVerificationEvidence, type FlowAgentRun } from "./flow";
import { executeCommandWithResult } from "./tools/commands";

export const runFlowAgent = async (
    run: FlowAgentRun,
    session: Session,
    approveTools: (tools: string[]) => void,
    abortSignal?: AbortSignal,
): Promise<string> => {
    const agent = AGENTS.getFlowAgent(run.role, WORKDIR);
    let submitted = false;
    const executions = new Map<string, { exitCode: number | null; error: string | null }>();
    const requireOpen = () => {
        if (submitted) throw new Error("Workflow step already finished; further tools are not authorized.");
        abortSignal?.throwIfAborted();
    };
    const tools: ToolSet = {};
    for (const [name, definition] of Object.entries(selectFlowTools(TOOLS, run.role, agent))) {
        tools[name] = {
            ...definition,
            execute: async (input, options) => {
                requireOpen();
                if (name === "shell" && run.role === "Verifier" && typeof input === "object" && input !== null && "command" in input) {
                    const command = String(input.command);
                    const result = await executeCommandWithResult(command);
                    executions.set(command, result);
                    return JSON.stringify(result);
                }
                if ((name === "write_file" || name === "edit_file") && typeof input === "object" && input !== null && "filePath" in input) {
                    const relative = path.relative(WORKDIR, path.resolve(WORKDIR, String(input.filePath)));
                    if (relative === ".corbecode" || relative.startsWith(`.corbecode${path.sep}`)) throw new Error("Workflow metadata is owned by the orchestrator; use flow_progress and flow_report.");
                }
                return definition.execute!(input as never, options);
            },
        };
    }
    tools.ask_user_input = tool({
        description: "Ask the user for a decisive missing requirement. Answers do not approve plans or change workflow phase.",
        inputSchema: zodSchema(z.object({ question: z.string().min(1) }).strict()),
        execute: async ({ question }) => {
            requireOpen();
            return askTerminal(`${question}\n> `);
        },
    });
    if (!run.explore && run.role === "Planner") {
        tools.flow_plan = tool({
            description: "Submit the final complete plan to the orchestrator. This ends planning, not approves it.",
            inputSchema: zodSchema(planSchema),
            execute: async (plan) => {
                requireOpen();
                run.submitPlan(plan);
                submitted = true;
                return "Plan saved. Awaiting explicit /flow:apply approval.";
            },
        });
    } else if (!run.explore) {
        if (run.role === "Developer") {
            tools.flow_progress = tool({
                description: "Persist a task's actual progress before starting and after completing or blocking it.",
                inputSchema: zodSchema(z.object({ id: z.string().min(1), status: taskStatusSchema, detail: z.string().min(1) }).strict()),
                execute: async ({ id, status, detail }) => {
                    requireOpen();
                    run.progress(id, status, detail, agent.name);
                    return "Progress saved.";
                },
            });
        }
        tools.flow_report = tool({
            description: "Submit final results and evidence to the orchestrator. Do not claim checks passed unless actually verified.",
            inputSchema: zodSchema(reportSchema),
            execute: async (report) => {
                requireOpen();
                if (run.role === "Verifier") validateVerificationEvidence(report, executions);
                run.submitReport(report, agent.name);
                submitted = true;
                return "Report saved. Step finished.";
            },
        });
    }
    return withSpinner(`Subagent ${agent.name} thinking...`, (spinner) => runSubagent(
        run.prompt, session, spinner, approveTools, agent, abortSignal,
        {
            tools,
            system: `Mandatory workflow role constraints, even for custom agents:\n${DEFAULT_AGENTS[run.role].body}\nNever edit .corbecode workflow metadata directly. Shell is not a sandbox; do not use it to bypass role restrictions.`,
            shouldStop: () => submitted,
            forceShellApproval: run.role === "Verifier",
        },
    ));
};