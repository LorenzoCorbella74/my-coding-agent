import type { ModelMessage } from "ai";
import { generateText } from "ai";
import { MODEL, api, CONTEXT_LIMIT } from "./config";

const KEEP_RECENT = 3;
const PRESERVE_TOOLS = new Set(["read_file"]);

type Part = {
    type?: string;
    toolCallId?: string;
    toolName?: string;
    content?: unknown;
};

export const estimateTokens = (messages: ModelMessage[]): number => {
    return JSON.stringify(messages).length / 4;
};

const collectToolResults = (messages: ModelMessage[]): { part: { content: unknown; }; toolName: string; }[] => {
    const names = new Map();

    return messages
        .flatMap(m => (Array.isArray(m.content) ? (m.content as Part[]) : []))
        .reduce((acc, p) => {
            if (p.type === 'tool_use' && p.toolCallId) {
                names.set(p.toolCallId, p.toolName);
            }
            if (p.type === 'tool_result' && p.toolCallId) {
                acc.push({
                    part: p as { content: unknown; },
                    toolName: names.get(p.toolCallId) ?? 'unknown'
                });
            }
            return acc;

        }, [] as { part: { content: unknown; }; toolName: string; }[]
        );

};

export const microCompact = (messages: ModelMessage[]): void => {
    collectToolResults(messages)
        .slice(0, -KEEP_RECENT)
        .forEach(({ part, toolName }) => {
            if (
                !PRESERVE_TOOLS.has(toolName) &&
                typeof part.content === 'string' &&
                part.content.length > 100
            ) {
                part.content = [`Previous: used ${toolName}`];
            }
        });
};

export const autoCompact = async (messages: ModelMessage[]):
    Promise<ModelMessage[]> => {
    const { text } = await generateText({
        model: api.chat(MODEL),
        messages: [
            {
                role: "user",
                content: `
        Summarize this conversation for continuity.
        Include:
        1) What was accomplished,
        2) Current state,
        3) Key decisions made.
        Be concise.

        ${JSON.stringify(messages).slice(-CONTEXT_LIMIT)}
        `,
            }
        ]
    });

    return [
        {
            role: "user",
            content: `[Conversation compressed]\n\n${text || "No summary."}`,
        }
    ];
};