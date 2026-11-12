import { createHash, randomUUID } from "node:crypto";
import {
    appendFileSync,
    copyFileSync,
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

export type Session = { id: string; messages: ModelMessage[] } & SessionMetadata;
export type SessionSummary = {
    id: string;
    createdAt: string;
    approvedTools: string[];
    title: string;
    updatedAt: number;
    messageCount: number;
    preview: string;
};

type SessionMetadata = Pick<SessionSummary, "createdAt" | "approvedTools" | "title">;
type SessionState = {
    version: 1;
    activeSessionId: string;
    sessions: Record<string, SessionMetadata>;
};

export class SessionStore {
    private readonly sessionsDirectory: string;
    private readonly activeFile: string;
    private readonly ignoreFile: string;

    constructor(workspaceRoot: string, globalDataDirectory?: string) {
        const dataDirectory = globalDataDirectory
            ? this.getGlobalWorkspaceDirectory(workspaceRoot, globalDataDirectory)
            : path.join(workspaceRoot, ".corbecode");
        this.sessionsDirectory = globalDataDirectory ? dataDirectory : path.join(dataDirectory, "sessions");
        this.activeFile = path.join(dataDirectory, "active-session");
        this.ignoreFile = path.join(dataDirectory, ".gitignore");
        mkdirSync(this.sessionsDirectory, { recursive: true });
        if (!globalDataDirectory) this.ensureGitIgnore();
    }

    private getGlobalWorkspaceDirectory(workspaceRoot: string, globalDataDirectory: string): string {
        const resolvedWorkspace = path.resolve(workspaceRoot);
        const workspaceKey = createHash("sha256")
            .update(process.platform === "win32" ? resolvedWorkspace.toLowerCase() : resolvedWorkspace)
            .digest("hex");
        const workspaceName = path.basename(resolvedWorkspace)
            .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
            .replace(/[. ]+$/g, "")
            .slice(0, 64) || "workspace";
        const sessionsDirectory = path.join(globalDataDirectory, "sessions");
        const dataDirectory = path.join(sessionsDirectory, `${workspaceName}-${workspaceKey}`);
        const legacyDirectory = path.join(workspaceRoot, ".corbecode");
        const globalState = path.join(dataDirectory, "active-session");
        if (!existsSync(globalState)) {
            mkdirSync(dataDirectory, { recursive: true });
            const previousGlobalDirectory = path.join(sessionsDirectory, workspaceKey);
            for (const source of [
                { directory: previousGlobalDirectory, sessions: previousGlobalDirectory },
                { directory: legacyDirectory, sessions: path.join(legacyDirectory, "sessions") },
            ]) {
                if (!existsSync(source.directory)) continue;
                this.copySessionFiles(source.sessions, dataDirectory);
                const sourceState = path.join(source.directory, "active-session");
                if (existsSync(sourceState) && !existsSync(globalState)) copyFileSync(sourceState, globalState);
            }
        }
        return dataDirectory;
    }

    private copySessionFiles(sourceDirectory: string, targetDirectory: string): void {
        if (!existsSync(sourceDirectory)) return;
        for (const entry of readdirSync(sourceDirectory, { withFileTypes: true })) {
            const target = path.join(targetDirectory, entry.name);
            if (
                entry.isFile() && entry.name.endsWith(".jsonl") &&
                SESSION_ID_PATTERN.test(entry.name.slice(0, -6)) && !existsSync(target)
            ) {
                copyFileSync(path.join(sourceDirectory, entry.name), target);
            }
        }
    }

    resumeOrCreate(): Session {
        const state = this.readState();
        if (state && existsSync(this.sessionPath(state.activeSessionId))) {
            return this.loadSession(state, state.activeSessionId);
        }
        return this.create();
    }

    create(): Session {
        const id = randomUUID();
        writeFileSync(this.sessionPath(id), "", { flag: "wx" });
        const state = this.readState() ?? this.emptyState();
        const metadata = this.newMetadata();
        state.sessions[id] = metadata;
        state.activeSessionId = id;
        this.writeState(state);
        return { id, messages: [], ...metadata };
    }

    restore(idPrefix: string): Session {
        const id = this.resolveId(idPrefix);
        const state = this.readState() ?? this.emptyState();
        this.ensureMetadata(state, id);
        state.activeSessionId = id;
        this.writeState(state);
        return this.loadSession(state, id);
    }

    append(id: string, message: ModelMessage): void {
        appendFileSync(this.sessionPath(id), `${JSON.stringify(message)}\n`, "utf8");
        const state = this.readState() ?? this.emptyState();
        const metadata = this.ensureMetadata(state, id);
        if (message.role === "user" && metadata.title === "Nuova sessione") {
            const content = typeof message.content === "string"
                ? message.content
                : message.content.map((part) => part.type === "text" ? part.text : "").join(" ");
            metadata.title = content.replace(/\s+/g, " ").trim().slice(0, 100) || metadata.title;
        }
        state.activeSessionId = id;
        this.writeState(state);
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
        const state = this.readState() ?? this.emptyState();
        this.ensureMetadata(state, id);
        state.activeSessionId = id;
        this.writeState(state);
    }

    approveTools(id: string, tools: string[]): void {
        const state = this.readState() ?? this.emptyState();
        this.ensureMetadata(state, id).approvedTools = [...new Set(tools)];
        state.activeSessionId = id;
        this.writeState(state);
    }

    list(): SessionSummary[] {
        const state = this.readState() ?? this.emptyState();
        const sessions = this.sessionIds()
            .map((id) => {
                const messages = this.readMessages(id);
                const metadata = this.ensureMetadata(state, id);
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
                    ...metadata,
                    updatedAt: statSync(this.sessionPath(id)).mtimeMs,
                    messageCount: messages.length,
                    preview,
                };
            })
            .sort((left, right) => right.updatedAt - left.updatedAt);
        if (state.activeSessionId) this.writeState(state);
        return sessions;
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

    private loadSession(state: SessionState, id: string): Session {
        const metadata = this.ensureMetadata(state, id);
        this.writeState(state);
        return { id, messages: this.readMessages(id), ...metadata };
    }

    private readState(): SessionState | undefined {
        if (!existsSync(this.activeFile)) return undefined;
        const contents = readFileSync(this.activeFile, "utf8").trim();
        if (SESSION_ID_PATTERN.test(contents)) {
            const state = this.emptyState(contents);
            this.ensureMetadata(state, contents);
            this.writeState(state);
            return state;
        }

        let value: unknown;
        try {
            value = JSON.parse(contents);
        } catch {
            throw new Error(`Invalid session metadata in ${this.activeFile}`);
        }
        if (
            typeof value !== "object" || value === null ||
            !("version" in value) || value.version !== 1 ||
            !("activeSessionId" in value) || typeof value.activeSessionId !== "string" ||
            !SESSION_ID_PATTERN.test(value.activeSessionId) ||
            !("sessions" in value) || typeof value.sessions !== "object" || value.sessions === null
        ) {
            throw new Error(`Invalid session metadata in ${this.activeFile}`);
        }

        const sessions: Record<string, SessionMetadata> = {};
        for (const [id, metadata] of Object.entries(value.sessions)) {
            if (
                !SESSION_ID_PATTERN.test(id) || typeof metadata !== "object" || metadata === null ||
                !("createdAt" in metadata) || typeof metadata.createdAt !== "string" ||
                !("approvedTools" in metadata) || !Array.isArray(metadata.approvedTools) ||
                !metadata.approvedTools.every((tool: unknown): tool is string => typeof tool === "string") ||
                !("title" in metadata) || typeof metadata.title !== "string"
            ) {
                throw new Error(`Invalid metadata for session ${id}`);
            }
            sessions[id] = {
                createdAt: metadata.createdAt,
                approvedTools: metadata.approvedTools,
                title: metadata.title,
            };
        }
        return { version: 1, activeSessionId: value.activeSessionId, sessions };
    }

    private emptyState(activeSessionId = ""): SessionState {
        return { version: 1, activeSessionId, sessions: {} };
    }

    private newMetadata(): SessionMetadata {
        return { createdAt: new Date().toISOString(), approvedTools: [], title: "Nuova sessione" };
    }

    private ensureMetadata(state: SessionState, id: string): SessionMetadata {
        if (!state.sessions[id]) {
            const file = this.sessionPath(id);
            const firstUserMessage = existsSync(file)
                ? this.readMessages(id).find((message) => message.role === "user")
                : undefined;
            const content = firstUserMessage?.content;
            const title = typeof content === "string"
                ? content
                : Array.isArray(content)
                    ? content.map((part) => part.type === "text" ? part.text : "").join(" ")
                    : "";
            state.sessions[id] = {
                createdAt: existsSync(file) ? statSync(file).birthtime.toISOString() : new Date().toISOString(),
                approvedTools: [],
                title: title.replace(/\s+/g, " ").trim().slice(0, 100) || "Nuova sessione",
            };
        }
        return state.sessions[id]!;
    }

    private writeState(state: SessionState): void {
        writeFileSync(this.activeFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    }

    private ensureGitIgnore(): void {
        const requiredRules = ["sessions/", "active-session", "workflows/", "active-flow.json"];
        const existing = existsSync(this.ignoreFile) ? readFileSync(this.ignoreFile, "utf8") : "";
        const lines = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
        const missing = requiredRules.filter((rule) => !lines.has(rule));
        if (missing.length === 0) return;

        const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
        writeFileSync(this.ignoreFile, `${existing}${separator}${missing.join("\n")}\n`, "utf8");
    }
}