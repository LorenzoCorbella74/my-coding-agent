import { parseDocument } from "yaml";
import { z } from "zod";

export const parseFrontmatter = (text: string) => {
    const match = text.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
    if (!match) {
        if (/^\uFEFF?---\r?\n/.test(text)) throw new Error("Unclosed YAML frontmatter");
        return { meta: {}, body: text };
    }
    const document = parseDocument(match[1] ?? "");
    if (document.errors.length) throw new Error(document.errors.map((error) => error.message).join("\n"));
    const meta = z.record(z.string(), z.unknown()).parse(document.toJS() ?? {});
    return { meta, body: (match[2] ?? "").trim() };
};
