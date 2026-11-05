import { MAX_BATCH_READ_FILES, MAX_READ_CHARS, safePath, WORKDIR } from "../tools";
import fs from "fs";

export const runRead = (filePath: string, limit?: number) => {
    try {
        const fp = safePath(filePath);
        const lines = fs.readFileSync(fp, "utf8").split("\n");
        return (limit ? lines.slice(0, limit) : lines).join("\n").slice(0, MAX_READ_CHARS);
    } catch (e) {
        return `Error ${e}`;
    }
};

export const runReadMany = (filePaths: string[], limit?: number) => {
    if (filePaths.length > MAX_BATCH_READ_FILES) {
        return `Error: read_files accepts at most ${MAX_BATCH_READ_FILES} paths`;
    }
    const content = filePaths.map((filePath) => `--- ${filePath} ---\n${runRead(filePath, limit)}`).join("\n\n");
    const marker = "\n[truncated at 50000 characters]";
    return content.length > MAX_READ_CHARS
        ? `${content.slice(0, MAX_READ_CHARS - marker.length)}${marker}`
        : content;
};