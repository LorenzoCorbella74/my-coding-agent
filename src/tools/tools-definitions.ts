import { tool, zodSchema } from "ai";
import { z } from "zod";

import path from "path";
import fs from "fs";

import { executeCommand } from "./commands";
import { runRead, runReadMany } from "./read";
import { runEdit } from "./edit";
import { runWrite } from "./write";
import { runExploreWorkspace } from "./explore";
import { runSearchCode } from "./search";
import { GLOBAL_DATA_DIR, WORKDIR } from "../config";
import { SkillLoader } from "../features/skills";
import { runSubagent } from "./subagents";
import type { Session } from "../features/sessionStore";
import type { createSpinner } from "../UI/spinner";
import { AgentLoader, selectDiscussionTools } from "../features/agents";
import { webSearch, webExtract } from "./web";
import { createMemoryTool, memoryStore } from "../features/memory";

export const MAX_READ_CHARS = 50000;
export const MAX_BATCH_READ_FILES = 20;
export const MAX_SEARCH_FILE_BYTES = 2_000_000;
export const DEFAULT_EXCLUDED_DIRS = new Set([
    ".git", ".corbecode", "node_modules", "dist", "build", "coverage", "out", "target", ".next", ".nuxt", ".cache", ".angular"
]);


const SKILLS = new SkillLoader([path.join(GLOBAL_DATA_DIR, "skills"), path.join(WORKDIR, ".corbecode", "skills")]);
export const SKILLS_DESCRIPTIONS = SKILLS.getDescriptions();
export const getSkillsTable = () => SKILLS.getTable();

export { safePath } from "../utils/paths";

export const normalizeGlob = (pattern: string) => pattern.replaceAll("\\", "/").replace(/^\/+/, "");

export const getProjectExclusions = () => {
    try {
        return fs.readFileSync(path.join(WORKDIR, ".gitignore"), "utf8")
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("!"))
            .flatMap((line) => {
                const pattern = normalizeGlob(line).replace(/\/$/, "");
                return pattern.includes("/")
                    ? [pattern, `${pattern}/**`]
                    : [pattern, `**/${pattern}`, `${pattern}/**`, `**/${pattern}/**`];
            });
    } catch {
        return [];
    }
};


export const isExcludedWorkspacePath = (relativePath: string, isDirectory: boolean, exclusions: string[]) => {
    const normalizedPath = normalizeGlob(relativePath);
    if (normalizedPath.split("/").some((part) => DEFAULT_EXCLUDED_DIRS.has(part))) return true;
    return exclusions.some((pattern) =>
        path.matchesGlob(normalizedPath, pattern) ||
        (isDirectory && path.matchesGlob(`${normalizedPath}/__entry__`, pattern))
    );
};

export const TOOLS = {
    explore_workspace: tool({
        description: "List workspace files and directories without reading contents. Defaults to direct children; increase maxDepth for recursive searches. Respects .gitignore and default build/dependency exclusions.",
        inputSchema: zodSchema(z.object({
            path: z.string().default("."),
            patterns: z.array(z.string()).min(1).default(["**/*"]),
            type: z.enum(["files", "directories", "both"]).default("both"),
            maxDepth: z.number().int().min(1).max(25).default(1),
            exclude: z.array(z.string()).default([]),
            limit: z.number().int().min(1).max(1000).default(200),
        })),
        execute: async (options) => runExploreWorkspace(options),
    }),
    searchCode: tool({
        description: "Search workspace file contents using a literal query or regular expression. Returns matching paths, line numbers, and surrounding context without changing files. Respects .gitignore and default dependency/build exclusions.",
        inputSchema: zodSchema(z.object({
            query: z.string().min(1).max(500),
            isRegex: z.boolean().default(false),
            root: z.string().default("."),
            glob: z.string().optional(),
            caseSensitive: z.boolean().default(false),
            contextLines: z.number().int().min(0).max(10).default(2),
            maxResults: z.number().int().min(1).max(200).default(100),
        })),
        execute: async (options) => runSearchCode(options),
    }),
    shell: tool({
        description: `Run a shell command using ${process.platform === "win32" ? "PowerShell" : "sh"}`,
        inputSchema: zodSchema(z.object({ command: z.string() })),
        execute: async ({ command }: { command: string; }) => {
            const output = executeCommand(command);
            return output;
        }
    }),
    read_file: tool({
        description: "Read a file",
        inputSchema: zodSchema(
            z.object({ filePath: z.string(), limit: z.number().int().positive().optional() }),
        ),
        execute: async ({ filePath, limit }) => runRead(filePath, limit),
    }),
    read_files: tool({
        description: `Read multiple workspace files in one call (up to ${MAX_BATCH_READ_FILES}); use this when several files are needed.`,
        inputSchema: zodSchema(z.object({
            filePaths: z.array(z.string()).min(1).max(MAX_BATCH_READ_FILES),
            limit: z.number().int().positive().optional(),
        })),
        execute: async ({ filePaths, limit }) => runReadMany(filePaths, limit),
    }),
    edit_file: tool({
        description: "Edit a file",
        inputSchema: zodSchema(
            z.object({
                filePath: z.string(),
                oldText: z.string(),
                newText: z.string(),
            }),
        ),
        execute: async ({ filePath, oldText, newText }) =>
            runEdit(filePath, oldText, newText),
    }),
    write_file: tool({
        description: "Write a file",
        inputSchema: zodSchema(
            z.object({ filePath: z.string(), content: z.string() }),
        ),
        execute: async ({ filePath, content }) => runWrite(filePath, content),
    }),
    skill_get: tool({
        description: "Load specialized knowledge by name",
        inputSchema: zodSchema(z.object({ name: z.string() })),
        execute: async ({ name }) => SKILLS.getContent(name),
    }),
    webSearch,
    webExtract,

};

export const AGENTS = new AgentLoader(WORKDIR, TOOLS, GLOBAL_DATA_DIR);
export const AGENTS_DESCRIPTIONS = AGENTS.getDescriptions();
const GENERAL_PURPOSE_AGENT = "general-purpose";
const resolveAgent = (name: string | undefined) => {
    if (name === undefined) return undefined;
    if (name === GENERAL_PURPOSE_AGENT && !AGENTS.has(name)) return undefined;
    return AGENTS.get(name);
};


export const createParentTools = (
    activeSession: Session,
    spinner: ReturnType<typeof createSpinner>,
    approveTools: (tools: string[]) => void,
    abortSignal?: AbortSignal,
    discussionOnly = false,
) => ({
    memory: createMemoryTool(memoryStore, abortSignal),
    ...(discussionOnly ? selectDiscussionTools(TOOLS) : {
        ...TOOLS,
        task: tool({
            description:
                "Spawn a subagent with fresh context, it shares the file system, but not the conversation history",
            inputSchema: zodSchema(
                z.object({
                    task: z.string(),
                    agent: z.string().optional().describe("Name of a custom agent from the available agents list; omit for a general-purpose subagent"),
                }),
            ),
            execute: async ({ task, agent }) => runSubagent(task, activeSession, spinner, approveTools, resolveAgent(agent), abortSignal),
        }),
    }),
});
