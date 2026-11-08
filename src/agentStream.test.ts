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
