import path from "node:path";
import { z } from "zod";

const writeSchema = z.object({ filePath: z.string(), content: z.string() });
const editSchema = z.object({ filePath: z.string(), oldText: z.string(), newText: z.string() });

const codeBlock = (filePath: string, content: string): string => {
    const extension = path.extname(filePath).slice(1).toLowerCase();
    const language = {
        ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
        mjs: "javascript", cjs: "javascript", md: "markdown", yml: "yaml",
        sh: "bash", ps1: "powershell", cs: "csharp", py: "python",
        html: "html", css: "css", scss: "scss", java: "java",
    }[extension] ?? extension.replace(/[^a-z0-9]/g, "");
    const longestFence = Math.max(2, ...(content.match(/`+/g) ?? []).map((run) => run.length));
    const fence = "`".repeat(longestFence + 1);
    return `${fence}${language}\n${content}\n${fence}`;
};

export const getActionPreview = (toolName: string, input: unknown): { filePath: string; markdown: string } | undefined => {
    if (toolName === "write_file") {
        const { filePath, content } = writeSchema.parse(input);
        return { filePath, markdown: codeBlock(filePath, content) };
    }
    if (toolName === "edit_file") {
        const { filePath, oldText, newText } = editSchema.parse(input);
        return {
            filePath,
            markdown: `**Prima**\n\n${codeBlock(filePath, oldText)}\n\n**Dopo**\n\n${codeBlock(filePath, newText)}`,
        };
    }
    return undefined;
};
