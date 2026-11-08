import assert from "node:assert/strict";
import { test } from "node:test";
import type { TextStreamPart, ToolSet } from "ai";
import { consumeTextStream } from "./agentStream";

const streamOf = (parts: TextStreamPart<ToolSet>[]): AsyncIterable<TextStreamPart<ToolSet>> => ({
    async *[Symbol.asyncIterator]() {
        for (const part of parts) yield part;
    },
});

test("forwards text start and deltas in order", async () => {
    const events: string[] = [];
    await consumeTextStream(streamOf([
        { type: "text-start", id: "1" },
        { type: "text-delta", id: "1", text: "Ciao" },
        { type: "text-delta", id: "1", text: " mondo" },
        { type: "text-end", id: "1" },
    ] as TextStreamPart<ToolSet>[]), {
        onTextStart: () => events.push("start"),
        onTextDelta: (delta) => events.push(delta),
    });
    assert.deepEqual(events, ["start", "Ciao", " mondo"]);
});

test("forwards tool activity between streamed text blocks without execution callbacks", async () => {
    const events: string[] = [];
    await consumeTextStream(streamOf([
        { type: "text-start", id: "1" },
        { type: "text-delta", id: "1", text: "Inspecting files" },
        { type: "text-end", id: "1" },
        { type: "tool-call", toolCallId: "read-1", toolName: "read_file", input: { filePath: "src/index.ts" } },
        { type: "tool-result", toolCallId: "read-1", toolName: "read_file", input: { filePath: "src/index.ts" }, output: "contents" },
        { type: "text-start", id: "2" },
        { type: "text-delta", id: "2", text: "File inspected" },
    ] as TextStreamPart<ToolSet>[]), {
        onTextStart: () => events.push("text"),
        onTextDelta: (delta) => events.push(delta),
        onToolCall: (toolName: string, input: unknown) => events.push(`${toolName}: ${JSON.stringify(input)}`),
    });
    assert.deepEqual(events, ["text", "Inspecting files", 'read_file: {"filePath":"src/index.ts"}', "text", "File inspected"]);
});

test("throws when the stream reports an error part", async () => {
    await assert.rejects(
        consumeTextStream(streamOf([
            { type: "error", error: new Error("boom") },
        ] as TextStreamPart<ToolSet>[]), { onTextStart: () => undefined, onTextDelta: () => undefined }),
        /boom/,
    );
});

test("throws when the stream is aborted", async () => {
    await assert.rejects(
        consumeTextStream(streamOf([
            { type: "abort" },
        ] as TextStreamPart<ToolSet>[]), { onTextStart: () => undefined, onTextDelta: () => undefined }),
        /interrotta/,
    );
});
