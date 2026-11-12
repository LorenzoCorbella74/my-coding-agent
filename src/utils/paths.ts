import path from "path";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { WORKDIR } from "../config";

export const safePath = (p: string) => {
    const resolved = path.resolve(WORKDIR, p);
    const relative = path.relative(WORKDIR, resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`Path is not in ${WORKDIR}`);
    }
    return resolved;
};

export const writePrivateFile = (file: string, content: string): void => {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
        writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
        renameSync(temporary, file);
    } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
    }
};
