import fs from "fs";
import { safePath } from "./tools-definitions";

export const runEdit = (filePath: string, oldText: string, newText: string) => {
    try {
        const fp = safePath(filePath);
        const content = fs.readFileSync(fp, "utf8");
        if (!content.includes(oldText)) {
            return `Error: ${oldText} not found in ${fp}`;
        }
        fs.writeFileSync(fp, content.replaceAll(oldText, newText));
        return `Edited the file: ${fp}`;
    } catch (e) {
        return `Error ${e}`;
    }
};