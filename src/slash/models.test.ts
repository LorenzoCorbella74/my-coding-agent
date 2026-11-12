import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { generateText, isStepCount, streamText, tool } from "ai";
import { z } from "zod";
import { ModelSettings, type ModelInfo, type ProviderConfig } from "./providers-models";
import { discoverModels, inspectOllamaModel, knownModelInfo } from "./modelCatalog";
import { consumeTextStream } from "../agentStream";

test("persists multiple providers and reasoning atomically, respects overrides, and rejects corrupt settings", () => {
    const root = mkdtempSync(path.join(tmpdir(), "corbecode-models-"));
    const file = path.join(root, "config.json");
    try {
        const settings = new ModelSettings(file, {});
        assert.equal(settings.current(), undefined);
        assert.throws(() => settings.request(), /\/login/);
        settings.saveProvider("openai", { type: "openai", name: "OpenAI", apiKey: "saved-test-key" });
        settings.saveProvider("local", { type: "ollama", name: "Local", baseURL: "http://localhost:11434/v1", contextWindow: 4096 });
        settings.select("openai", knownModelInfo(settings.provider("openai"), "gpt-5.2"));
        settings.setReasoning("high");
        const restored = new ModelSettings(file, {});
        assert.equal(restored.current()?.reasoning, "high");
        assert.equal(Object.keys(restored.providers()).length, 2);
        assert.throws(() => restored.setReasoning("made-up"), /not supported/);
        const overridden = new ModelSettings(file, { OPENAI_API_KEY: "env-test-key", MODEL: "gpt-4o" });
        assert.equal(overridden.provider("openai").apiKey, "env-test-key");
        assert.equal(overridden.current()?.model, "gpt-4o");
        assert.equal(overridden.current()?.reasoning, "default");
        assert.equal(restored.provider("openai").apiKey, "saved-test-key");
        assert.equal(restored.select("local", { id: "local-model", name: "Local", contextWindow: 4096 }), true);
        assert.equal(restored.current()?.reasoning, "default");
        assert.equal(restored.contextLimit(), 2457);
        assert.throws(() => restored.select("local", { id: "no-tools", name: "No tools", tools: false }), /tools/);
        assert.equal(restored.current()?.model, "local-model");
        assert.throws(() => restored.saveProvider("bad", { type: "openai-compatible", name: "Bad", baseURL: "https://user:password@example.com/v1" }), /Invalid provider/);
        assert.deepEqual(readdirSync(root), ["config.json"]);
        if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
        writeFileSync(file, '{"providers":');
        assert.throws(() => restored.current(), /Invalid JSON/);
        assert.throws(() => restored.saveProvider("another", { type: "openai", name: "Another" }), /Invalid JSON/);
        assert.equal(readFileSync(file, "utf8"), '{"providers":');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("cycles ordered favorites across providers without network, preserving metadata and compatible reasoning", () => {
    const root = mkdtempSync(path.join(tmpdir(), "corbecode-model-cycle-"));
    try {
        const file = path.join(root, "config.json");
        const noNetwork: typeof fetch = async () => { throw new Error("Cycling must not fetch catalogs"); };
        const settings = new ModelSettings(file, {}, noNetwork);
        settings.saveProvider("remote", { type: "openrouter", name: "Remote", apiKey: "test-key" });
        settings.saveProvider("local", { type: "ollama", name: "Local", baseURL: "http://localhost:11434/v1", contextWindow: 4096 });
        settings.select("remote", { id: "org/coder", name: "Coder", contextWindow: 128000, control: { kind: "effort", levels: ["low", "high"] } });
        const { reasoning: _, ...remote } = settings.current()!;
        settings.saveModelCycle([remote, { provider: "local", model: "coder:8b", contextWindow: 4096, control: { kind: "effort", levels: ["high"] } }]);
        settings.setReasoning("high");
        const restored = new ModelSettings(file, {}, noNetwork);
        assert.deepEqual(restored.cycleModel(), { changed: true, reasoningReset: false });
        assert.equal(restored.current()?.provider, "local");
        assert.equal(restored.current()?.reasoning, "high");
        assert.equal(restored.contextLimit(), 2457);
        restored.cycleModel();
        assert.equal(restored.current()?.model, "org/coder");
        assert.equal(restored.current()?.reasoning, "high");
        assert.equal(restored.contextLimit(), 50000);
        restored.select("local", { id: "coder:8b", name: "Coder", contextWindow: 2048 });
        assert.equal(restored.current()?.reasoning, "default");
        assert.equal(restored.modelCycle()[1]?.contextWindow, 2048);
        assert.equal(restored.modelCycle()[1]?.control, undefined);
        restored.select("remote", { id: "outside-list", name: "Other" });
        restored.setReasoning("default");
        restored.cycleModel();
        assert.equal(restored.current()?.model, "org/coder");
        restored.setReasoning("high");
        assert.deepEqual(restored.cycleModel(), { changed: true, reasoningReset: true });
        restored.saveModelCycle([restored.modelCycle()[1]!]);
        const before = readFileSync(file, "utf8");
        assert.deepEqual(restored.cycleModel(), { changed: false, reasoningReset: false });
        assert.equal(readFileSync(file, "utf8"), before);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("rejects empty cycles, duplicates, environment overrides and unusable favorites without changing the selection", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "corbecode-model-cycle-errors-"));
    try {
        const file = path.join(root, "config.json");
        const settings = new ModelSettings(file, {}, async () => Response.json({
            data: [{ id: "org/cached", supported_parameters: ["tools"], context_length: 32000, reasoning: { supported_efforts: ["high"] } }],
        }));
        assert.throws(() => settings.cycleModel(), /Nessun modello preferito/);
        settings.saveProvider("remote", { type: "openrouter", name: "Remote", apiKey: "test-key" });
        settings.select("remote", { id: "current", name: "Current" });
        const favorite = { provider: "remote", model: "org/next" };
        settings.saveModelCycle([favorite]);
        const before = readFileSync(file, "utf8");
        assert.throws(() => settings.saveModelCycle([favorite, favorite]), /Duplicate/);
        assert.equal(readFileSync(file, "utf8"), before);
        for (const env of [{ MODEL: "other" }, { CORBECODE_PROVIDER: "openai" }]) {
            assert.throws(() => new ModelSettings(file, env).cycleModel(), /override/);
            assert.equal(readFileSync(file, "utf8"), before);
        }
        settings.saveModelCycle([{ provider: "openai", model: "gpt-5.2" }]);
        assert.throws(() => settings.cycleModel(), /API key/);
        assert.equal(settings.current()?.model, "current");
        settings.saveModelCycle([{ provider: "missing", model: "model" }]);
        assert.throws(() => settings.cycleModel(), /Unknown provider/);
        assert.equal(settings.current()?.model, "current");
        settings.saveModelCycle([{ provider: "remote", model: "org/manual" }]);
        settings.cycleModel();
        assert.equal(settings.current()?.contextWindow, 8192);
        await settings.list("remote");
        settings.saveModelCycle([{ provider: "remote", model: "org/cached" }]);
        settings.cycleModel();
        assert.equal(settings.current()?.contextWindow, 32000);
        assert.deepEqual(settings.current()?.control?.levels, ["high"]);
        settings.saveModelCycle([{ provider: "remote", model: "org/cached", contextWindow: 4096 }]);
        settings.select("remote", { id: "org/manual", name: "Manual" });
        settings.cycleModel();
        assert.equal(settings.current()?.contextWindow, 4096);
        writeFileSync(file, JSON.stringify({ providers: {}, modelCycle: [favorite, favorite] }));
        assert.throws(() => settings.modelCycle(), /Invalid configuration.*modelCycle/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("discovers authenticated paginated catalogs and rejects unsafe pages and malformed responses", async () => {
    const requests: { url: string; headers: Headers }[] = [];
    const provider: ProviderConfig = { type: "anthropic", name: "Anthropic", apiKey: "test-key" };
    const fetcher: typeof fetch = async (input, init) => {
        const url = String(input);
        requests.push({ url, headers: new Headers(init?.headers) });
        return Response.json(url.includes("after_id") ? {
            data: [{ id: "second", display_name: "Second" }], has_more: false,
        } : {
            data: [{
                id: "first", display_name: "First", max_input_tokens: 200000,
                capabilities: {
                    thinking: { supported: true, types: { adaptive: { supported: true } } },
                    effort: { supported: true, low: { supported: true }, high: { supported: true }, max: { supported: false } }
                },
            }], has_more: true, last_id: "first",
        });
    };
    const models = await discoverModels(provider, fetcher);
    assert.equal(models.length, 2);
    assert.deepEqual(models[0]?.control, { kind: "anthropic-adaptive", levels: ["low", "high"] });
    assert.equal(requests[0]?.headers.get("x-api-key"), "test-key");
    assert.match(requests[1]!.url, /after_id=first/);
    const openrouter: ProviderConfig = { type: "openrouter", name: "OpenRouter", apiKey: "router-test" };
    const routed = await discoverModels(openrouter, async () => Response.json({
        data: [
            { id: "text", supported_parameters: [], context_length: 8192 },
            { id: "coding", supported_parameters: ["tools", "reasoning"], reasoning: { supported_efforts: ["none", "low", "high"], mandatory: true } },
        ],
    }));
    assert.equal(routed.length, 1);
    assert.deepEqual(routed[0]?.control?.levels, ["low", "high"]);
    await assert.rejects(discoverModels(openrouter, async () => Response.json({
        data: [], links: { next: "https://untrusted.example/models" },
    })), /unsafe/);
    await assert.rejects(discoverModels(provider, async () => Response.json({ bad: [] })), /format/);
    await assert.rejects(discoverModels(provider, async () => new Response("do-not-log-this", { status: 401 })), /authentication.*401/);
    const google = await discoverModels({ type: "google", name: "Gemini", apiKey: "test" }, async (_input, init) => {
        assert.equal(new Headers(init?.headers).get("x-goog-api-key"), "test");
        return Response.json({
            models: [
                { name: "models/gemini-2.5-pro", inputTokenLimit: 1048576, supportedGenerationMethods: ["generateContent"] },
                { name: "models/embedding", supportedGenerationMethods: ["embedContent"] },
            ]
        });
    });
    assert.equal(google.length, 1);
    assert.equal(google[0]?.id, "gemini-2.5-pro");
    assert.equal(google[0]?.contextWindow, 1048576);
});

test("caches local catalogs and discovers Ollama tool and thinking capabilities without a key", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "corbecode-ollama-"));
    try {
        let calls = 0;
        const provider: ProviderConfig = { type: "ollama", name: "Ollama", baseURL: "http://localhost:11434/v1" };
        const fetcher: typeof fetch = async (input, init) => {
            calls++;
            assert.equal(new Headers(init?.headers).has("Authorization"), false);
            assert.equal(init?.redirect, "error");
            if (String(input).endsWith("/api/show")) {
                assert.equal(JSON.parse(String(init?.body)).model, "local-model");
                return Response.json({ capabilities: ["completion", "tools", "thinking"], thinking: { values: [false, true] } });
            }
            assert.equal(String(input), "http://localhost:11434/v1/models");
            return Response.json({ data: [{ id: "local-model" }] });
        };
        const settings = new ModelSettings(path.join(root, "config.json"), {}, fetcher);
        settings.saveProvider("local", provider);
        const models = await settings.list("local");
        await settings.list("local");
        assert.equal(calls, 1);
        await settings.list("local", true);
        assert.equal(calls, 2);
        const info = await settings.inspect("local", models[0]!);
        assert.equal(info.tools, true);
        assert.deepEqual(info.control, { kind: "toggle", levels: ["off", "on"] });
        const named = await inspectOllamaModel(provider, info, async () => Response.json({
            capabilities: ["completion"], thinking: { values: ["low", "high"] },
        }));
        assert.deepEqual(named.control?.levels, ["low", "high"]);
        assert.equal(named.tools, false);
        settings.select("local", info);
        settings.setReasoning("off");
        assert.deepEqual(settings.request().providerOptions, { local: { reasoningEffort: "none" } });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("sends selected models and reasoning to the actual SDK request format for every provider", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "corbecode-provider-wire-"));
    try {
        const cases: { provider: ProviderConfig; info: ModelInfo; level: string; path: string; expected: object }[] = [
            { provider: { type: "openrouter", name: "Router", apiKey: "test" }, info: { id: "coding", name: "Coding", control: { kind: "effort", levels: ["high"] } }, level: "high", path: "/api/v1/chat/completions", expected: { reasoning: { effort: "high" } } },
            { provider: { type: "openai", name: "OpenAI", apiKey: "test" }, info: knownModelInfo({ type: "openai", name: "OpenAI" }, "gpt-5.2"), level: "high", path: "/v1/responses", expected: { reasoning: { effort: "high" } } },
            { provider: { type: "anthropic", name: "Anthropic", apiKey: "test" }, info: { id: "claude-sonnet-4-6", name: "Claude", control: { kind: "anthropic-adaptive", levels: ["high"] } }, level: "high", path: "/v1/messages", expected: { thinking: { type: "adaptive" }, output_config: { effort: "high" } } },
            { provider: { type: "google", name: "Gemini", apiKey: "test" }, info: knownModelInfo({ type: "google", name: "Gemini" }, "gemini-2.5-pro"), level: "8192", path: "/v1beta/models/gemini-2.5-pro:generateContent", expected: { generationConfig: { thinkingConfig: { thinkingBudget: 8192 } } } },
            { provider: { type: "openai-compatible", name: "Custom", baseURL: "http://localhost:1234/v1" }, info: { id: "custom", name: "Custom" }, level: "default", path: "/v1/chat/completions", expected: {} },
            { provider: { type: "ollama", name: "Ollama", baseURL: "http://localhost:11434/v1" }, info: { id: "local", name: "Local", control: { kind: "toggle", levels: ["off", "on"] } }, level: "on", path: "/v1/chat/completions", expected: { reasoning_effort: "high" } },
        ];
        for (const [index, entry] of cases.entries()) {
            let called = false;
            const fetcher: typeof fetch = async (input, init) => {
                called = true;
                assert.equal(new URL(String(input)).pathname, entry.path);
                const body = JSON.parse(String(init?.body));
                if (entry.provider.type !== "google") assert.equal(body.model, entry.info.id);
                assert.partialDeepStrictEqual(body, entry.expected);
                if (!entry.provider.apiKey) assert.equal(new Headers(init?.headers).has("Authorization"), false);
                if (entry.provider.type === "openai") return Response.json({
                    id: "resp_test", created_at: 0, model: entry.info.id,
                    output: [{ id: "msg_test", type: "message", role: "assistant", content: [{ type: "output_text", text: "ok", annotations: [] }] }],
                    usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
                });

                if (entry.provider.type === "anthropic") return Response.json({
                    id: "msg_test", type: "message", role: "assistant", model: entry.info.id,
                    content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 2, output_tokens: 1 },
                });
                if (entry.provider.type === "google") return Response.json({
                    candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
                    usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 },
                });
                return Response.json({
                    id: "chat_test", created: 0, model: entry.info.id,
                    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
                });
            };
            const settings = new ModelSettings(path.join(root, `${index}.json`), {}, fetcher);
            settings.saveProvider("selected", entry.provider);
            settings.select("selected", entry.info);
            settings.setReasoning(entry.level);
            const result = await generateText({ ...settings.request(), prompt: "test", maxRetries: 0 });
            assert.equal(called, true);
            assert.equal(result.text, "ok");
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("streams OpenRouter reasoning details before the answer without exposing encrypted metadata", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "corbecode-router-reasoning-"));
    try {
        const fetcher: typeof fetch = async () => {
            const deltas = [
                { reasoning_details: [{ type: "reasoning.text", text: "Planning" }] },
                { reasoning_details: [{ type: "reasoning.summary", summary: "Ready" }] },
                { reasoning_details: [{ type: "reasoning.encrypted", data: "opaque-test-data" }] },
                { content: "Answer" },
            ];
            const events = deltas.map((delta) => ({
                id: "chat_reasoning", created: 0, model: "test-model",
                choices: [{ index: 0, delta, finish_reason: null }],
            }));
            return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")
                + `data: ${JSON.stringify({ id: "chat_reasoning", created: 0, model: "test-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`
                + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
        };
        const settings = new ModelSettings(path.join(root, "config.json"), {}, fetcher);
        settings.saveProvider("remote", { type: "openrouter", name: "Remote", apiKey: "test-key" });
        settings.select("remote", { id: "test-model", name: "Test" });
        const result = streamText({ ...settings.request(), prompt: "test", maxRetries: 0 });
        const events: string[] = [];
        await consumeTextStream(result.fullStream, {
            onReasoningStart: () => events.push("reasoning"),
            onReasoningDelta: (delta) => events.push(delta),
            onTextStart: () => events.push("answer"),
            onTextDelta: (delta) => events.push(delta),
        });
        assert.deepEqual(events, ["reasoning", "Planning", "Ready", "answer", "Answer"]);
        assert.equal(await result.text, "Answer");
        assert.equal((await result.usage).totalTokens, 15);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("streams a local model through a complete tool-call round trip", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "corbecode-local-stream-"));
    try {
        let calls = 0;
        const fetcher: typeof fetch = async (_input, init) => {
            calls++;
            const body = JSON.parse(String(init?.body));
            assert.equal(body.stream, true);
            assert.equal(body.tools[0].function.name, "inspect");
            if (calls === 2) assert.ok(body.messages.some((message: { role: string; content: string }) => message.role === "tool" && message.content.includes("local result")));
            const delta = calls === 1
                ? { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "inspect", arguments: "{}" } }] }
                : { content: "ok" };
            const events = [
                { id: "chat_test", created: 0, model: "local", choices: [{ index: 0, delta, finish_reason: null }] },
                { id: "chat_test", created: 0, model: "local", choices: [{ index: 0, delta: {}, finish_reason: calls === 1 ? "tool_calls" : "stop" }] },
            ];
            return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", {
                headers: { "Content-Type": "text/event-stream" },
            });
        };
        const settings = new ModelSettings(path.join(root, "config.json"), {}, fetcher);
        settings.saveProvider("local", { type: "ollama", name: "Local", baseURL: "http://localhost:11434/v1" });
        settings.select("local", { id: "local", name: "Local" });
        const result = streamText({
            ...settings.request(), prompt: "test", maxRetries: 0, stopWhen: isStepCount(2),
            tools: { inspect: tool({ description: "Inspect", inputSchema: z.object({}), execute: async () => "local result" }) },
        });
        let text = "";
        for await (const delta of result.textStream) text += delta;
        assert.equal(text, "ok");
        assert.equal(calls, 2);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
