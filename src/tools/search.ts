import path from "path";
import { WORKDIR } from "..";
import { safePath, MAX_SEARCH_FILE_BYTES, MAX_READ_CHARS, getProjectExclusions, normalizeGlob, isExcludedWorkspacePath } from "../tools";
import fs from "fs";

export const runSearchCode = ({
    query,
    isRegex,
    root,
    glob,
    caseSensitive,
    contextLines,
    maxResults,
}: {
    query: string;
    isRegex: boolean;
    root: string;
    glob?: string | undefined;
    caseSensitive: boolean;
    contextLines: number;
    maxResults: number;
}) => {
    try {
        const workspaceRoot = fs.realpathSync(WORKDIR);
        const rootPath = fs.realpathSync(safePath(root));
        const rootRelative = normalizeGlob(path.relative(workspaceRoot, rootPath));
        if (rootRelative === ".." || rootRelative.startsWith("../") || path.isAbsolute(rootRelative)) {
            return `Error: Search root must be inside ${WORKDIR}`;
        }
        if (!fs.statSync(rootPath).isDirectory()) return `Error: ${root} is not a directory`;

        const exclusions = getProjectExclusions();
        if (rootRelative && isExcludedWorkspacePath(rootRelative, true, exclusions)) {
            return `Error: ${root} is excluded from workspace search`;
        }
        const normalizedGlob = glob ? normalizeGlob(glob) : undefined;
        const expression = new RegExp(
            isRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
            caseSensitive ? "" : "i"
        );
        const results: string[] = [];
        let resultCount = 0;
        let truncated = false;
        let outputSize = 0;

        const walk = (directory: string): void => {
            for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
                const filePath = path.join(directory, entry.name);
                const relativePath = normalizeGlob(path.relative(workspaceRoot, filePath));
                if (isExcludedWorkspacePath(relativePath, entry.isDirectory(), exclusions)) continue;
                if (entry.isDirectory()) {
                    walk(filePath);
                    if (truncated) return;
                    continue;
                }
                const pathFromRoot = normalizeGlob(path.relative(rootPath, filePath));
                if (!entry.isFile() || (normalizedGlob && !path.matchesGlob(pathFromRoot, normalizedGlob))) continue;
                if (fs.statSync(filePath).size > MAX_SEARCH_FILE_BYTES) continue;

                const content = fs.readFileSync(filePath, "utf8");
                if (content.includes("\0")) continue;
                const lines = content.split(/\r?\n/);
                for (let index = 0; index < lines.length; index++) {
                    if (!expression.test(lines[index] ?? "")) continue;
                    if (resultCount === maxResults) {
                        truncated = true;
                        return;
                    }

                    const start = Math.max(0, index - contextLines);
                    const end = Math.min(lines.length, index + contextLines + 1);
                    const snippet = lines.slice(start, end).map((line, offset) => {
                        const lineNumber = start + offset + 1;
                        return `${lineNumber === index + 1 ? ">" : " "} ${lineNumber}: ${line}`;
                    }).join("\n");
                    const result = `${relativePath}:${index + 1}\n${snippet}`;
                    if (outputSize + result.length > MAX_READ_CHARS) {
                        truncated = true;
                        return;
                    }
                    results.push(result);
                    outputSize += result.length;
                    resultCount++;
                }
            }
        };

        walk(rootPath);
        const listing = results.length > 0 ? results.join("\n\n") : "No matches.";
        return truncated ? `${listing}\n[truncated: showing first ${resultCount} matches]` : listing;
    } catch (error) {
        return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
};