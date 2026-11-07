import path from "path";
import { WORKDIR } from "./config";

export const safePath = (p: string) => {
    const resolved = path.resolve(WORKDIR, p);
    const relative = path.relative(WORKDIR, resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`Path is not in ${WORKDIR}`);
    }
    return resolved;
};
