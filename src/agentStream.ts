import type { TextStreamPart, ToolSet } from "ai";

export type TextStreamHandlers = {
    onTextStart: () => void;
    onTextDelta: (delta: string) => void;
    onReasoningStart?: () => void;
    onReasoningDelta?: (delta: string) => void;
    onReasoningEnd?: () => void;
    onToolCall?: (toolName: string, input: unknown) => void;
};

export const consumeTextStream = async <TOOLS extends ToolSet>(
    fullStream: AsyncIterable<TextStreamPart<TOOLS>>,
    handlers: TextStreamHandlers,
): Promise<void> => {
    for await (const part of fullStream) {
        if (part.type === "text-start") handlers.onTextStart();
        else if (part.type === "text-delta") handlers.onTextDelta(part.text);
        else if (part.type === "reasoning-start") handlers.onReasoningStart?.();
        else if (part.type === "reasoning-delta") handlers.onReasoningDelta?.(part.text);
        else if (part.type === "reasoning-end") handlers.onReasoningEnd?.();
        else if (part.type === "tool-call") handlers.onToolCall?.(part.toolName, part.input);
        else if (part.type === "error") throw part.error instanceof Error ? part.error : new Error(String(part.error));
        else if (part.type === "abort") throw new Error("Richiesta interrotta.");
    }
};
