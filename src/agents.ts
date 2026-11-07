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

export class AgentLoader {
    private readonly agents = new Map<string, CustomAgent>();

    constructor(workspace: string, tools: Record<string, unknown>) {
        const directory = path.join(workspace, ".corbecode", "agents");
        fs.mkdirSync(directory, { recursive: true });
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
            const file = path.join(directory, entry.name);
            try {
                const { meta, body } = parseFrontmatter(fs.readFileSync(file, "utf8"));
                const metadata = agentSchema.parse(meta);
                const name = metadata.name ?? entry.name.replace(/(?:\.agent)?\.md$/, "");
                if (!body.trim()) throw new Error("Agent instructions must not be empty");
                if (this.agents.has(name)) throw new Error(`Duplicate agent name: ${name}`);
                selectAgentTools(tools, metadata.tools);
                this.agents.set(name, { name, description: metadata.description, tools: metadata.tools, body });
            } catch (error) {
                throw new Error(`Invalid custom agent ${file}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
            }
        }
    }

    getDescriptions(): string {
        return [...this.agents.values()].map((agent) =>
            `  - ${agent.name}: ${agent.description} (tools: ${agent.tools === undefined ? "*" : agent.tools.join(", ") || "none"})`
        ).join("\n") || "(no custom agents available)";
    }

    get(name: string): CustomAgent {
        const agent = this.agents.get(name);
        if (!agent) throw new Error(`Custom agent not found: ${name}`);
        return agent;
    }
}
