import { safePath } from "../tools";
import fs from "fs";
import path from "path";

export const runWrite = (filePath: string, content: string) => {
    try {
        const fp = safePath(filePath);
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, content);
        return `Wrote the file: ${fp}`;
    } catch (e) {
        return `Error ${e}`;
    }
};
