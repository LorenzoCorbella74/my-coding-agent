import { z } from "zod";
import type { ModelInfo, ProviderConfig } from "./providers-models";

const support = z.object({ supported: z.boolean() });
const catalogEntry = z.object({
    id: z.string().min(1), name: z.string().optional(), display_name: z.string().optional(),
    context_length: z.number().positive().nullish(), max_input_tokens: z.number().positive().nullish(),
    supported_parameters: z.array(z.string()).optional(),
    reasoning: z.object({ supported_efforts: z.array(z.string()).nullish(), mandatory: z.boolean().optional() }).optional(),
    capabilities: z.object({
        effort: z.object({
            supported: z.boolean(), low: support.optional(), medium: support.optional(),
            high: support.optional(), xhigh: support.nullish(), max: support.optional(),
        }).optional(),
        thinking: z.object({
            supported: z.boolean(),
            types: z.object({ adaptive: support.optional(), enabled: support.optional() }).optional(),
        }).optional(),
    }).nullish(),
});
const catalogPage = z.object({
    data: z.array(catalogEntry), has_more: z.boolean().optional(), last_id: z.string().nullish(),
    links: z.object({ next: z.string().nullish() }).optional(),
});
const googlePage = z.object({
    models: z.array(z.object({
        name: z.string().min(1), displayName: z.string().optional(),
        inputTokenLimit: z.number().positive().optional(), supportedGenerationMethods: z.array(z.string()),
    })),
    nextPageToken: z.string().optional(),
});

const BASE_URLS: Partial<Record<ProviderConfig["type"], string>> = {
    openrouter: "https://openrouter.ai/api/v1", openai: "https://api.openai.com/v1",
    anthropic: "https://api.anthropic.com/v1", google: "https://generativelanguage.googleapis.com/v1beta",
};

async function getJson(provider: ProviderConfig, url: string, fetcher: typeof fetch, signal?: AbortSignal, body?: object): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (provider.type === "anthropic") {
        headers["anthropic-version"] = "2023-06-01";
        if (provider.apiKey) headers["x-api-key"] = provider.apiKey;
    } else if (provider.type === "google") {
        if (provider.apiKey) headers["x-goog-api-key"] = provider.apiKey;
    } else if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
    if (body) headers["Content-Type"] = "application/json";
    let response: Response;
    try {
        response = await fetcher(url, {
            headers, redirect: "error",
            signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
            ...(body && { method: "POST", body: JSON.stringify(body) }),
        });
    } catch (error) {
        if (signal?.aborted) throw new Error("Model discovery cancelled.");
        throw new Error(`${provider.name}: connection failed or timed out. Check the server and base URL.`, { cause: error });
    }
    if (!response.ok) {
        const reason = response.status === 401 || response.status === 403 ? "authentication or permission denied"
            : response.status === 429 ? "rate limit exceeded" : "catalog request failed";
        throw new Error(`${provider.name}: ${reason} (HTTP ${response.status}).`);
    }
    try { return await response.json(); }
    catch { throw new Error(`${provider.name}: the model endpoint did not return valid JSON.`); }
}

function parse<T>(schema: z.ZodType<T>, value: unknown, name: string): T {
    const result = schema.safeParse(value);
    if (!result.success) throw new Error(`${name}: unexpected model catalog format.`);
    return result.data;
}

export function knownModelInfo(provider: ProviderConfig, id: string): ModelInfo {
    const info: ModelInfo = { id, name: id };
    if (provider.type === "openai") {
        // ponytail: only documented model families; unknown models keep provider defaults.
        if (/^(o3(?:-mini)?|o4-mini|o1)(-\d{4}-\d{2}-\d{2})?$/.test(id)) {
            info.control = { kind: "effort", levels: ["low", "medium", "high"] };
        } else {
            const levels = /^gpt-5\.1(-\d{4}-\d{2}-\d{2})?$/.test(id) ? ["none", "low", "medium", "high"]
                : /^gpt-5\.[245](-\d{4}-\d{2}-\d{2})?$/.test(id) ? ["none", "low", "medium", "high", "xhigh"]
                    : /^gpt-5(-mini|-nano)?(-\d{4}-\d{2}-\d{2})?$/.test(id) ? ["minimal", "low", "medium", "high"] : [];
            if (levels.length) info.control = { kind: "effort", levels };
        }
        info.contextWindow = /^gpt-(4o|4\.1|5)/.test(id) || /^(o3|o4-mini)(-|$)/.test(id) ? 128000 : 8192;
    } else if (provider.type === "google") {
        if (/^gemini-3(-|\.1-)(pro|flash)(-|$)/.test(id) && !/(image|audio|tts)/.test(id)) {
            info.control = { kind: "google-level", levels: /flash/.test(id) ? ["minimal", "low", "medium", "high"] : /^gemini-3\.1-/.test(id) ? ["low", "medium", "high"] : ["low", "high"] };
        } else if (/^gemini-2\.5-(pro|flash)(-|$)/.test(id) && !/(image|audio|tts|lite)/.test(id)) {
            info.control = { kind: "google-budget", levels: /-pro/.test(id) ? ["128", "8192", "32768"] : ["0", "1024", "8192", "24576"] };
        }
    } else if (provider.type === "anthropic") {
        if (/^claude-(3-7-sonnet|sonnet-4(?:-5)?|opus-4(?:-1|-5)?|haiku-4-5)(-\d{8})?$/.test(id)) {
            info.control = { kind: "anthropic-budget", levels: ["1024", "8192", "16384"] };
        }
        info.contextWindow = 200000;
    } else if (provider.type === "ollama" || provider.type === "openai-compatible") {
        info.contextWindow = provider.contextWindow ?? 4096;
    }
    return info;
}

export async function discoverModels(provider: ProviderConfig, fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<ModelInfo[]> {
    if (!["ollama", "openai-compatible"].includes(provider.type) && !provider.apiKey) {
        throw new Error(`${provider.name}: no API key configured. Use /login.`);
    }
    const base = (BASE_URLS[provider.type] ?? provider.baseURL)?.replace(/\/+$/, "");
    if (!base) throw new Error(`${provider.name}: missing base URL.`);
    let next: string | undefined = `${base}/models`;
    const visited = new Set<string>();
    const models = new Map<string, ModelInfo>();
    while (next) {
        if (visited.has(next) || visited.size >= 100) throw new Error(`${provider.name}: invalid catalog pagination.`);
        const url = new URL(next);
        if (url.origin !== new URL(base).origin || !url.pathname.startsWith(new URL(base).pathname + "/")) {
            throw new Error(`${provider.name}: unsafe catalog pagination URL.`);
        }
        visited.add(next);
        const payload = await getJson(provider, next, fetcher, signal);
        next = undefined;
        if (provider.type === "google") {
            const page = parse(googlePage, payload, provider.name);
            for (const entry of page.models) {
                if (!entry.supportedGenerationMethods.includes("generateContent") || /(image|tts|audio|robotics)/.test(entry.name)) continue;
                const id = entry.name.replace(/^models\//, "");
                models.set(id, {
                    ...knownModelInfo(provider, id), name: entry.displayName ?? id,
                    ...(entry.inputTokenLimit && { contextWindow: entry.inputTokenLimit }),
                });
            }
            if (page.nextPageToken) next = `${base}/models?pageToken=${encodeURIComponent(page.nextPageToken)}`;
        } else {
            const page = parse(catalogPage, payload, provider.name);
            for (const entry of page.data) {
                const info = knownModelInfo(provider, entry.id);
                info.name = entry.name ?? entry.display_name ?? entry.id;
                const window = entry.context_length ?? entry.max_input_tokens;
                if (window) info.contextWindow = window;
                if (provider.type === "openrouter") {
                    if (entry.supported_parameters) info.tools = entry.supported_parameters.includes("tools");
                    if (entry.reasoning && "supported_efforts" in entry.reasoning) {
                        const levels = entry.reasoning.supported_efforts ?? ["none", "minimal", "low", "medium", "high", "xhigh"];
                        const supported = levels.filter((level) => !entry.reasoning?.mandatory || level !== "none");
                        if (supported.length) info.control = { kind: "effort", levels: supported };
                    }
                } else if (provider.type === "anthropic") {
                    const capabilities = entry.capabilities;
                    if (capabilities?.thinking?.types?.adaptive?.supported && capabilities.effort?.supported) {
                        const effort = capabilities.effort;
                        const levels = (["low", "medium", "high", "xhigh", "max"] as const).filter((level) => effort[level]?.supported);
                        if (levels.length) info.control = { kind: "anthropic-adaptive", levels };
                    } else if (capabilities?.thinking?.supported === false) {
                        delete info.control;
                    }
                } else if (provider.type === "openai") {
                    if (!/^(gpt-|o[134](?:-|$)|chatgpt-)/.test(entry.id) || /(audio|realtime|transcribe|tts|image|search|deep-research|instruct|0301|0314)/.test(entry.id)) continue;
                }
                if (info.tools !== false) models.set(info.id, info);
            }
            if (provider.type === "anthropic" && page.has_more) {
                if (!page.last_id) throw new Error(`${provider.name}: missing pagination cursor.`);
                next = `${base}/models?after_id=${encodeURIComponent(page.last_id)}`;
            } else if (page.links?.next) next = new URL(page.links.next, base + "/").href;
        }
    }
    return [...models.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function validateProvider(provider: ProviderConfig, fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<void> {
    if (provider.type === "openrouter") {
        await getJson(provider, "https://openrouter.ai/api/v1/key", fetcher, signal);
    } else {
        await discoverModels(provider, fetcher, signal);
    }
}

export async function inspectOllamaModel(provider: ProviderConfig, info: ModelInfo, fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<ModelInfo> {
    const base = provider.baseURL!.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
    const payload = await getJson(provider, `${base}/api/show`, fetcher, signal, { model: info.id });
    const result = parse(z.object({
        capabilities: z.array(z.string()).optional(),
        thinking: z.object({ values: z.array(z.union([z.string(), z.boolean()])) }).optional(),
    }), payload, provider.name);
    const inspected = { ...info, contextWindow: provider.contextWindow ?? 4096 };
    delete inspected.control;
    if (result.capabilities) inspected.tools = result.capabilities.includes("tools");
    const values = result.thinking?.values;
    if (values?.some((value) => typeof value === "string")) {
        inspected.control = { kind: "effort", levels: values.filter((value): value is string => typeof value === "string") };
    } else if (values?.includes(true)) {
        inspected.control = { kind: "toggle", levels: values.includes(false) ? ["off", "on"] : ["on"] };
    }
    return inspected;
}
