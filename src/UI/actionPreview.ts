import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { safePath } from "../utils/paths";

const writeSchema = z.object({ filePath: z.string(), content: z.string() });
const editSchema = z.object({ filePath: z.string(), oldText: z.string(), newText: z.string() });

const CONTEXT_LINES = 3;
const MAX_DIFF_CELLS = 4_000_000;

const languageOf = (filePath: string): string => {
    const extension = path.extname(filePath).slice(1).toLowerCase();
    return {
        ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
        mjs: "javascript", cjs: "javascript", md: "markdown", yml: "yaml",
        sh: "bash", ps1: "powershell", cs: "csharp", py: "python",
        html: "html", css: "css", scss: "scss", java: "java",
    }[extension] ?? extension.replace(/[^a-z0-9]/g, "");
};

const fenced = (language: string, content: string): string => {
    const longestFence = Math.max(2, ...(content.match(/`+/g) ?? []).map((run) => run.length));
    const fence = "`".repeat(longestFence + 1);
    return `${fence}${language}\n${content}\n${fence}`;
};

type DiffOp = { type: " " | "-" | "+"; line: string };

const diffLines = (before: string[], after: string[]): DiffOp[] => {
    let start = 0;
    while (start < before.length && start < after.length && before[start] === after[start]) start++;
    let endBefore = before.length;
    let endAfter = after.length;
    while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
        endBefore--;
        endAfter--;
    }
    const prefix: DiffOp[] = before.slice(0, start).map((line) => ({ type: " ", line }));
    const suffix: DiffOp[] = before.slice(endBefore).map((line) => ({ type: " ", line }));
    const middleBefore = before.slice(start, endBefore);
    const middleAfter = after.slice(start, endAfter);
    const n = middleBefore.length;
    const m = middleAfter.length;

    if (n * m > MAX_DIFF_CELLS) {
        return [
            ...prefix,
            ...middleBefore.map((line): DiffOp => ({ type: "-", line })),
            ...middleAfter.map((line): DiffOp => ({ type: "+", line })),
            ...suffix,
        ];
    }

    const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    const cell = (i: number, j: number): number => lcs[i]?.[j] ?? 0;
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            lcs[i]![j] = middleBefore[i] === middleAfter[j]
                ? cell(i + 1, j + 1) + 1
                : Math.max(cell(i + 1, j), cell(i, j + 1));
        }
    }

    const middle: DiffOp[] = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        const beforeLine = middleBefore[i] ?? "";
        const afterLine = middleAfter[j] ?? "";
        if (beforeLine === afterLine) {
            middle.push({ type: " ", line: beforeLine });
            i++;
            j++;
        } else if (cell(i + 1, j) >= cell(i, j + 1)) {
            middle.push({ type: "-", line: beforeLine });
            i++;
        } else {
            middle.push({ type: "+", line: afterLine });
            j++;
        }
    }
    while (i < n) middle.push({ type: "-", line: middleBefore[i++] ?? "" });
    while (j < m) middle.push({ type: "+", line: middleAfter[j++] ?? "" });

    return [...prefix, ...middle, ...suffix];
};

const unifiedDiff = (before: string, after: string): string => {
    const ops = diffLines(before.split("\n"), after.split("\n"));
    const changed = ops.flatMap((op, index) => (op.type === " " ? [] : [index]));
    if (changed.length === 0) return "";

    const visible = new Set<number>();
    for (const index of changed) {
        for (let k = Math.max(0, index - CONTEXT_LINES); k <= Math.min(ops.length - 1, index + CONTEXT_LINES); k++) {
            visible.add(k);
        }
    }

    const lines: string[] = [];
    let oldLine = 0;
    let newLine = 0;
    let previousVisible = -2;
    ops.forEach((op, index) => {
        if (visible.has(index)) {
            if (index !== previousVisible + 1) lines.push(`@@ -${oldLine + 1} +${newLine + 1} @@`);
            lines.push(`${op.type}${op.line}`);
            previousVisible = index;
        }
        if (op.type !== "+") oldLine++;
        if (op.type !== "-") newLine++;
    });
    return lines.join("\n");
};

const readCurrentFile = (filePath: string): string | undefined => {
    try {
        return fs.readFileSync(safePath(filePath), "utf8");
    } catch {
        return undefined;
    }
};

export const getActionPreview = (toolName: string, input: unknown): { filePath: string; markdown: string } | undefined => {
    if (toolName === "write_file") {
        const { filePath, content } = writeSchema.parse(input);
        return { filePath, markdown: fenced(languageOf(filePath), content) };
    }
    if (toolName === "edit_file") {
        const { filePath, oldText, newText } = editSchema.parse(input);
        const current = readCurrentFile(filePath);
        const hasTarget = current !== undefined && current.includes(oldText);
        const before = hasTarget ? current : oldText;
        const after = hasTarget ? current.replaceAll(oldText, newText) : newText;
        return { filePath, markdown: fenced("diff", unifiedDiff(before, after) || "(nessuna modifica)") };
    }
    return undefined;
};
