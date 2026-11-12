import * as fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { parseFrontmatter } from "./frontmatter";

const agentSchema = z.object({
    name: z.string().trim().min(1).optional(),
    description: z.string().trim().min(1),
    "user-invocable": z.boolean().optional(),
    tools: z.union([
        z.array(z.string().trim().min(1)),
        z.string().transform((value) => value.split(",").map((tool) => tool.trim()).filter(Boolean)),
    ]).optional(),
}).strict();

export type CustomAgent = {
    name: string;
    description: string;
    tools: string[] | undefined;
    body: string;
};

export const FLOW_ROLES = ["Planner", "Developer", "Verifier", "Reviewer"] as const;
export type FlowRole = typeof FLOW_ROLES[number];

export const DEFAULT_AGENTS: Record<FlowRole, CustomAgent> = {
    Planner: {
        name: "Planner", description: "Analyze requests and prepare or revise implementation plans without editing code.",
        tools: ["read", "search", "skill_get"],
        body: "Inspect the actual workspace. Clarify decisive unknowns. Define scope, exclusions, risks, acceptance criteria and concrete tasks. Preserve completed tasks that remain valid when revising a plan; reopen affected tasks. Do not implement or approve your own plan.",
    },
    Developer: {
        name: "Developer", description: "Implement approved tasks and report progress, evidence and blockers.",
        tools: ["read", "search", "edit", "execute", "skill_get"],
        body: "Implement only the approved plan. Inspect existing work before continuing interrupted tasks. Preserve unrelated user changes. Report task progress during execution. Run focused checks and report actual results, deviations and blockers. Do not expand scope or declare verification passed.",
    },
    Verifier: {
        name: "Verifier", description: "Independently verify acceptance criteria and execute checks without correcting code.",
        tools: ["read", "search", "execute", "skill_get"],
        body: "Inspect implementation independently of the developer report. Check every acceptance criterion and run relevant tests. Report commands, actual outcomes, failures and checks that could not run. Missing evidence is not a pass. Do not modify source code or fix findings. Shell is for checks only, not implementation.",
    },
    Reviewer: {
        name: "Reviewer", description: "Review change-related code for concrete bugs, security risks and maintainability issues without editing.",
        tools: ["read", "search", "skill_get"],
        body: "Review the current change against its approved scope and repository conventions. Inspect changed files and relevant callers. Report concrete findings with severity, file, line and reasoning. Distinguish pre-existing issues. Do not modify files or start corrections. State explicitly when no findings are found and describe remaining gaps.",
    },
};

const TOOL_ALIASES: Record<string, string[]> = {
    read: ["read_file", "read_files"],
    search: ["explore_workspace", "searchCode"],
    edit: ["edit_file", "write_file"],
    execute: ["shell"],
    bash: ["shell"],
    powershell: ["shell"],
    grep: ["explore_workspace", "searchCode"],
    glob: ["explore_workspace", "searchCode"],
    multiedit: ["edit_file", "write_file"],
    write: ["edit_file", "write_file"],
};

export const selectAgentTools = <T>(tools: Record<string, T>, allowed: string[] | undefined): Record<string, T> => {
    if (!allowed || allowed.includes("*")) return tools;
    const names = new Set(allowed.flatMap((name) => TOOL_ALIASES[name.toLowerCase()] ?? [name]));
    for (const name of names) {
        if (!Object.hasOwn(tools, name)) throw new Error(`Unknown or unavailable agent tool: ${name}`);
    }
    return Object.fromEntries(Object.entries(tools).filter(([name]) => names.has(name)));
};

export const selectFlowTools = <T>(tools: Record<string, T>, role: FlowRole, agent: CustomAgent): Record<string, T> => {
    const roleTools = selectAgentTools(tools, DEFAULT_AGENTS[role].tools);
    const agentTools = selectAgentTools(tools, agent.tools);
    return Object.fromEntries(Object.entries(roleTools).filter(([name]) => Object.hasOwn(agentTools, name)));
};

export const selectDiscussionTools = <T>(tools: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(tools).filter(([name]) => ["read_file", "read_files", "explore_workspace", "searchCode", "skill_get", "ask_user_input"].includes(name)));

export class AgentLoader {
    private readonly agents = new Map<string, CustomAgent>(Object.entries(DEFAULT_AGENTS));

    constructor(workspace: string, tools: Record<string, unknown>, globalDataDirectory?: string) {
        const directories = [
            ...(globalDataDirectory ? [path.join(globalDataDirectory, "agents")] : []),
            path.join(workspace, ".corbecode", "agents"),
        ];
        for (const directory of directories) {
            fs.mkdirSync(directory, { recursive: true });
            const customNames = new Set<string>();
            for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
                if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
                const file = path.join(directory, entry.name);
                try {
                    const { meta, body } = parseFrontmatter(fs.readFileSync(file, "utf8"));
                    const metadata = agentSchema.parse(meta);
                    const name = metadata.name ?? entry.name.replace(/(?:\.agent)?\.md$/, "");
                    if (!body.trim()) throw new Error("Agent instructions must not be empty");
                    if (customNames.has(name)) throw new Error(`Duplicate agent name: ${name}`);
                    selectAgentTools(tools, metadata.tools);
                    customNames.add(name);
                    this.agents.set(name, { name, description: metadata.description, tools: metadata.tools, body });
                } catch (error) {
                    throw new Error(`Invalid custom agent ${file}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
                }
            }
        }
    }

    getDescriptions(): string {
        return [...this.agents.values()].map((agent) =>
            `  - ${agent.name}: ${agent.description} (tools: ${agent.tools === undefined ? "*" : agent.tools.join(", ") || "none"})`
        ).join("\n") || "(no custom agents available)";
    }

    has(name: string): boolean {
        return this.agents.has(name);
    }

    get(name: string): CustomAgent {
        const agent = this.agents.get(name);
        if (!agent) throw new Error(`Custom agent not found: ${name}`);
        return agent;
    }

    getFlowAgent(role: FlowRole, workspace: string): CustomAgent {
        const file = path.join(workspace, ".corbecode", "flow-agents.json");
        if (!fs.existsSync(file)) return this.get(role);
        const mapping = z.object({
            Planner: z.string().min(1).optional(), Developer: z.string().min(1).optional(),
            Verifier: z.string().min(1).optional(), Reviewer: z.string().min(1).optional(),
        }).strict().parse(JSON.parse(fs.readFileSync(file, "utf8")));
        return this.get(mapping[role] ?? role);
    }
}
