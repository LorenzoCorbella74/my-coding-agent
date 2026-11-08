const MAX_LABEL_LENGTH = 120;

type Activity = { icon: string; label: string };

const field = (input: unknown, key: string): unknown =>
    typeof input === "object" && input !== null ? (input as Record<string, unknown>)[key] : undefined;

const oneLine = (value: unknown): string => {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    return text.length > MAX_LABEL_LENGTH ? `${text.slice(0, MAX_LABEL_LENGTH - 1)}…` : text;
};

const ACTIVITIES = new Map<string, (input: unknown) => Activity>([
    ["read_file", (input) => ({ icon: "▤", label: `read: ${oneLine(field(input, "filePath"))}` })],
    ["read_files", (input) => {
        const paths = field(input, "filePaths");
        return { icon: "▦", label: `read: ${oneLine(Array.isArray(paths) ? paths.join(", ") : "")}` };
    }],
    ["edit_file", (input) => ({ icon: "✎", label: `edit: ${oneLine(field(input, "filePath"))}` })],
    ["write_file", (input) => ({ icon: "✚", label: `write: ${oneLine(field(input, "filePath"))}` })],
    ["shell", (input) => ({ icon: "❯", label: `bash: ${oneLine(field(input, "command"))}` })],
    ["explore_workspace", (input) => ({ icon: "⌕", label: `explore: ${oneLine(field(input, "path") ?? ".")}` })],
    ["skill_get", (input) => ({ icon: "◈", label: `skill: ${oneLine(field(input, "name"))}` })],
    ["task", (input) => {
        const agent = field(input, "agent");
        const name = typeof agent === "string" && agent ? ` (${agent})` : "";
        return { icon: "◎", label: `subagent${name}: ${oneLine(field(input, "task"))}` };
    }],
]);

export const formatToolActivity = (toolName: string, input: unknown): string => {
    const describe = ACTIVITIES.get(toolName);
    const { icon, label } = describe ? describe(input) : { icon: "•", label: toolName };
    return `${icon} ${label}`;
};
