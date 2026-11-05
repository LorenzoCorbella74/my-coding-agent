import { tool, zodSchema } from "ai";
import { z } from "zod";

import path from "path";
import fs from "fs";
import { runAskUserInput } from "./tools/ask";
import { executeCommand } from "./tools/commands";
import { runRead, runReadMany } from "./tools/read";
import { runEdit } from "./tools/edit";
import { runWrite } from "./tools/write";
import { runExploreWorkspace } from "./tools/explore";
import { runSearchCode } from "./tools/search";

export const WORKDIR = process.cwd();
export const MAX_READ_CHARS = 50000;
export const MAX_BATCH_READ_FILES = 20;
export const MAX_SEARCH_FILE_BYTES = 2_000_000;
export const DEFAULT_EXCLUDED_DIRS = new Set([
    ".git", "node_modules", "dist", "build", "coverage", "out", "target", ".next", ".nuxt", ".cache", ".angular"
]);

export const safePath = (p: string) => {
    const resolved = path.resolve(WORKDIR, p);
    const relative = path.relative(WORKDIR, resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`Path is not in ${WORKDIR}`);
    }
    return resolved;
};

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


const askUserInputSchema = z.object({
    question: z.string().trim().min(1).describe("A single, concise clarification question"),
    options: z.array(z.string().trim().min(1)).min(1).optional().describe("Non-empty choices when the answer is a bounded decision"),
    defaultValue: z.string().trim().min(1).optional().describe("Default used only when the user submits a blank answer"),
}).superRefine(({ options, defaultValue }, context) => {
    if (options && new Set(options.map((option) => option.toLowerCase())).size !== options.length) {
        context.addIssue({ code: "custom", path: ["options"], message: "Options must be unique" });
    }
    if (defaultValue && options && !options.some((option) => option.toLowerCase() === defaultValue.toLowerCase())) {
        context.addIssue({ code: "custom", path: ["defaultValue"], message: "The default value must match one of the options" });
    }
});

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
    ask_user_input: tool({
        description: "Ask one concise question only when missing information blocks a correct implementation or a material user preference cannot be inferred. First inspect the workspace for discoverable facts. Do not ask about routine implementation details, reversible low-risk choices, or permission to inspect files; choose a sensible default and proceed. Use options for bounded decisions, and only provide a default that is one of those options.",
        inputSchema: zodSchema(askUserInputSchema),
        execute: async ({ question, options, defaultValue }) => runAskUserInput({ question, options: options ?? undefined, defaultValue: defaultValue ?? undefined }),
    }),
};
