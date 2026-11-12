import path from "path";
import { WORKDIR } from "../config";
import { safePath, normalizeGlob, getProjectExclusions, isExcludedWorkspacePath } from "./tools-definitions";
import fs from "fs";

export const runExploreWorkspace = ({
    path: startPath,
    patterns,
    type,
    maxDepth,
    exclude,
    limit,
}: {
    path: string;
    patterns: string[];
    type: "files" | "directories" | "both";
    maxDepth: number;
    exclude: string[];
    limit: number;
}) => {
    try {
        const basePath = safePath(startPath);
        const baseRelative = normalizeGlob(path.relative(WORKDIR, basePath));
        const exclusions = [
            ...getProjectExclusions(),
            ...exclude.map(normalizeGlob),
        ];

        if (baseRelative && isExcludedWorkspacePath(baseRelative, true, exclusions)) {
            return `Error: ${startPath} is excluded from workspace exploration`;
        }

        const results: string[] = [];
        let truncated = false;
        const walk = (directory: string, depth: number): void => {
            for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
                const absolutePath = path.join(directory, entry.name);
                const isDirectory = entry.isDirectory();
                if (!isDirectory && !entry.isFile()) continue;

                const relativePath = normalizeGlob(path.relative(WORKDIR, absolutePath));
                if (isExcludedWorkspacePath(relativePath, isDirectory, exclusions)) continue;

                const typeMatches = type === "both" || (type === "directories" ? isDirectory : entry.isFile());
                if (typeMatches && patterns.some((pattern) => path.matchesGlob(relativePath, normalizeGlob(pattern)))) {
                    if (results.length === limit) {
                        truncated = true;
                        return;
                    }
                    results.push(`${isDirectory ? "DIR " : "FILE"} ${relativePath}`);
                }

                if (isDirectory && depth < maxDepth) walk(absolutePath, depth + 1);
                if (truncated) return;
            }
        };

        walk(basePath, 1);
        const listing = results.length > 0 ? results.join("\n") : "No matches.";
        return truncated ? `${listing}\n[truncated: showing first ${limit} results]` : listing;
    } catch (e) {
        return `Error ${e}`;
    }
};