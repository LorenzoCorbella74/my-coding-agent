import { readFile } from "node:fs/promises";
import path from "node:path";

export async function readWorkspaceInstructions(workspace: string): Promise<string> {
    try {
        return await readFile(path.join(workspace, "AGENTS.md"), "utf8");
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
        throw error;
    }
}
