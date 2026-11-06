import { randomUUID } from "node:crypto";
import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import path from "node:path";
import type { ModelMessage } from "ai";

const MESSAGE_ROLES = new Set(["system", "developer", "user", "assistant", "tool"]);
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Session = { id: string; messages: ModelMessage[] };
export type SessionSummary = {
    id: string;
    updatedAt: number;
    messageCount: number;
    preview: string;
};

export class SessionStore {
    private readonly sessionsDirectory: string;
    private readonly activeFile: string;
    private readonly ignoreFile: string;

    constructor(workspaceRoot: string) {
        const dataDirectory = path.join(workspaceRoot, ".corbeagent");
        this.sessionsDirectory = path.join(dataDirectory, "sessions");
        this.activeFile = path.join(dataDirectory, "active-session");
        this.ignoreFile = path.join(dataDirectory, ".gitignore");
        mkdirSync(this.sessionsDirectory, { recursive: true });
        this.ensureGitIgnore();
    }

    resumeOrCreate(): Session {
        if (existsSync(this.activeFile)) {
            const activeId = readFileSync(this.activeFile, "utf8").trim();
            if (SESSION_ID_PATTERN.test(activeId) && existsSync(this.sessionPath(activeId))) {
                return { id: activeId, messages: this.readMessages(activeId) };
            }
        }
        return this.create();
    }

    create(): Session {
        const id = randomUUID();
        writeFileSync(this.sessionPath(id), "", { flag: "wx" });
        this.setActive(id);
        return { id, messages: [] };
    }

    restore(idPrefix: string): Session {
        const id = this.resolveId(idPrefix);
        const session = { id, messages: this.readMessages(id) };
        this.setActive(id);
        return session;
    }

    append(id: string, message: ModelMessage): void {
        appendFileSync(this.sessionPath(id), `${JSON.stringify(message)}\n`, "utf8");
        this.setActive(id);
    }

    replace(id: string, messages: ModelMessage[]): void {
        const sessionFile = this.sessionPath(id);
        const temporaryFile = `${sessionFile}.${randomUUID()}.tmp`;
        const contents = messages.map((message) => JSON.stringify(message)).join("\n");
        try {
            writeFileSync(temporaryFile, contents ? `${contents}\n` : "", "utf8");
            renameSync(temporaryFile, sessionFile);
        } finally {
            if (existsSync(temporaryFile)) unlinkSync(temporaryFile);
        }
        this.setActive(id);
    }

    list(): SessionSummary[] {
        return this.sessionIds()
            .map((id) => {
                const messages = this.readMessages(id);
                const firstUserMessage = messages.find((message) => message.role === "user");
                const content = firstUserMessage?.content;
                const preview = (typeof content === "string"
                    ? content
                    : Array.isArray(content)
                        ? content.map((part) => "text" in part && typeof part.text === "string" ? part.text : "").join(" ")
                        : "")
                    .replace(/\s+/g, " ")
                    .trim()
                    .slice(0, 100);

                return {
                    id,
                    updatedAt: statSync(this.sessionPath(id)).mtimeMs,
                    messageCount: messages.length,
                    preview,
                };
            })
            .sort((left, right) => right.updatedAt - left.updatedAt);
    }

    private readMessages(id: string): ModelMessage[] {
        const contents = readFileSync(this.sessionPath(id), "utf8");
        return contents.split(/\r?\n/).flatMap((line, index) => {
            if (!line.trim()) return [];

            let value: unknown;
            try {
                value = JSON.parse(line);
            } catch {
                throw new Error(`Invalid JSON in session ${id.slice(0, 8)} at line ${index + 1}`);
            }

            if (
                typeof value !== "object" || value === null ||
                !("role" in value) || typeof value.role !== "string" || !MESSAGE_ROLES.has(value.role) ||
                !("content" in value)
            ) {
                throw new Error(`Invalid message in session ${id.slice(0, 8)} at line ${index + 1}`);
            }
            return [value as ModelMessage];
        });
    }

    private resolveId(idPrefix: string): string {
        const prefix = idPrefix.trim().toLowerCase();
        if (prefix.length < 8) throw new Error("Use at least 8 characters of the session ID.");

        const matches = this.sessionIds().filter((id) => id.toLowerCase().startsWith(prefix));
        if (matches.length === 0) throw new Error(`Session not found: ${idPrefix}`);
        if (matches.length > 1) throw new Error(`Ambiguous session ID: ${idPrefix}`);
        return matches[0]!;
    }

    private sessionIds(): string[] {
        return readdirSync(this.sessionsDirectory)
            .filter((name) => name.endsWith(".jsonl"))
            .map((name) => name.slice(0, -".jsonl".length))
            .filter((id) => SESSION_ID_PATTERN.test(id));
    }

    private sessionPath(id: string): string {
        if (!SESSION_ID_PATTERN.test(id)) throw new Error(`Invalid session ID: ${id}`);
        return path.join(this.sessionsDirectory, `${id}.jsonl`);
    }

    private setActive(id: string): void {
        writeFileSync(this.activeFile, `${id}\n`, "utf8");
    }

    private ensureGitIgnore(): void {
        const requiredRules = ["sessions/", "active-session"];
        const existing = existsSync(this.ignoreFile) ? readFileSync(this.ignoreFile, "utf8") : "";
        const lines = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
        const missing = requiredRules.filter((rule) => !lines.has(rule));
        if (missing.length === 0) return;

        const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
        writeFileSync(this.ignoreFile, `${existing}${separator}${missing.join("\n")}\n`, "utf8");
    }
}