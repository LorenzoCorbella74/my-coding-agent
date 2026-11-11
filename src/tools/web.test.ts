import assert from "node:assert/strict";
import { test } from "node:test";
import { webExtract, webSearch } from "./web";

const executeTool = async (tool: { execute?: (...args: never[]) => unknown }, input: object) =>
    tool.execute!(input as never) as Promise<unknown>;

test("webSearch sends a Tavily search request", async () => {
    const oldKey = process.env.TAVILY_API_KEY;
    const oldFetch = globalThis.fetch;
    process.env.TAVILY_API_KEY = "test-key";
    let request: { url: string; init?: RequestInit | undefined } | undefined;
    globalThis.fetch = (async (input, init) => {
        request = { url: String(input), init };
        return Response.json({ results: [] });
    }) as typeof fetch;

    try {
        await executeTool(webSearch, { query: "AI SDK updates" });
        assert.equal(request?.url, "https://api.tavily.com/search");
        assert.equal(new Headers(request?.init?.headers).get("authorization"), "Bearer test-key");
        assert.deepEqual(JSON.parse(String(request?.init?.body)), {
            query: "AI SDK updates",
            search_depth: "basic",
            max_results: 5,
        });
    } finally {
        globalThis.fetch = oldFetch;
        if (oldKey === undefined) delete process.env.TAVILY_API_KEY;
        else process.env.TAVILY_API_KEY = oldKey;
    }
});

test("webExtract maps URLs and extraction depth to Tavily", async () => {
    const oldKey = process.env.TAVILY_API_KEY;
    const oldFetch = globalThis.fetch;
    process.env.TAVILY_API_KEY = "test-key";
    let request: { url: string; init?: RequestInit | undefined } | undefined;
    globalThis.fetch = (async (input, init) => {
        request = { url: String(input), init };
        return Response.json({ results: [] });
    }) as typeof fetch;

    try {
        await executeTool(webExtract, { urls: ["https://example.com"], extractDepth: "advanced" });
        assert.equal(request?.url, "https://api.tavily.com/extract");
        assert.deepEqual(JSON.parse(String(request?.init?.body)), {
            urls: ["https://example.com"],
            extract_depth: "advanced",
            format: "markdown",
        });
    } finally {
        globalThis.fetch = oldFetch;
        if (oldKey === undefined) delete process.env.TAVILY_API_KEY;
        else process.env.TAVILY_API_KEY = oldKey;
    }
});

test("web tools report Tavily API errors", async () => {
    const oldKey = process.env.TAVILY_API_KEY;
    const oldFetch = globalThis.fetch;
    process.env.TAVILY_API_KEY = "test-key";
    globalThis.fetch = (async () => Response.json({ detail: "Unauthorized" }, { status: 401 })) as typeof fetch;

    try {
        await assert.rejects(executeTool(webSearch, { query: "test" }), /Tavily search failed \(401\)/);
    } finally {
        globalThis.fetch = oldFetch;
        if (oldKey === undefined) delete process.env.TAVILY_API_KEY;
        else process.env.TAVILY_API_KEY = oldKey;
    }
});