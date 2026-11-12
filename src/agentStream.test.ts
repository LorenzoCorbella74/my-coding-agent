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

test("forwards reasoning as it arrives, before the answer and across tool steps", async () => {
    const events: string[] = [];
    const handlers = {
        onReasoningStart: () => events.push("reasoning"),
        onReasoningDelta: (delta: string) => events.push(delta),
        onReasoningEnd: () => events.push("reasoning-end"),
        onTextStart: () => events.push("answer"),
        onTextDelta: (delta: string) => events.push(delta),
        onToolCall: (name: string) => events.push(name),
    };
    await consumeTextStream(streamOf([
        { type: "reasoning-start", id: "r1" },
        { type: "reasoning-delta", id: "r1", text: "Check " },
        { type: "reasoning-delta", id: "r1", text: "the file" },
        { type: "reasoning-end", id: "r1" },
        { type: "tool-call", toolCallId: "read-1", toolName: "read_file", input: { filePath: "test.ts" } },
        { type: "reasoning-start", id: "r2" },
        { type: "reasoning-delta", id: "r2", text: "Ready" },
        { type: "reasoning-end", id: "r2" },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", text: "Here is the answer" },
        { type: "text-end", id: "t1" },
    ]), handlers);
    assert.deepEqual(events, ["reasoning", "Check ", "the file", "reasoning-end", "read_file", "reasoning", "Ready", "reasoning-end", "answer", "Here is the answer"]);
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
