import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { generateText, LanguageModel } from "ai";
import { CONTEXT_LIMIT, GLOBAL_DATA_DIR } from "../config";
import { discoverModels, knownModelInfo, inspectOllamaModel, validateProvider } from "./modelCatalog";
import { writePrivateFile } from "../utils/paths";

const providerSchema = z.object({
    type: z.enum(["openrouter", "openai", "anthropic", "google", "openai-compatible", "ollama"]),
    name: z.string().trim().min(1).max(100),
    apiKey: z.string().trim().min(1).optional(),
    baseURL: z.string().refine((value) => {
        try {
            const url = new URL(value);
            return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
        } catch { return false; }
    }, "Use an HTTP(S) base URL without credentials, query or fragment.").optional(),
    contextWindow: z.number().int().min(1024).optional(),
}).refine((provider) => !["ollama", "openai-compatible"].includes(provider.type) || provider.baseURL, "A base URL is required.");

const controlSchema = z.object({
    kind: z.enum(["effort", "toggle", "google-level", "google-budget", "anthropic-budget", "anthropic-adaptive"]),
    levels: z.array(z.string().regex(/^[a-z0-9_-]+$/)).min(1),
});
const modelInfoSchema = z.object({
    id: z.string().trim().min(1),
    name: z.string().min(1),
    contextWindow: z.number().int().positive().optional(),
    tools: z.boolean().optional(),
    control: controlSchema.optional(),
});
const selectionSchema = modelInfoSchema.omit({ id: true, name: true, tools: true }).extend({
    provider: z.string().min(1),
    model: z.string().trim().min(1),
    reasoning: z.string().default("default"),
});
const cycleSchema = z.array(selectionSchema.omit({ reasoning: true })).refine(
    (entries) => new Set(entries.map(({ provider, model }) => JSON.stringify([provider, model]))).size === entries.length,
    "Duplicate provider/model in modelCycle.",
);
const settingsSchema = z.object({
    providers: z.record(z.string().regex(/^[a-z0-9_-]+$/), providerSchema).default({}),
    current: selectionSchema.optional(),
    modelCycle: cycleSchema.default([]),
}).passthrough();

export type ProviderConfig = z.infer<typeof providerSchema>;
export type ModelInfo = z.infer<typeof modelInfoSchema>;
export type ModelSelection = z.infer<typeof selectionSchema>;
export type ModelCycleEntry = z.infer<typeof cycleSchema>[number];
type Settings = z.infer<typeof settingsSchema>;
type ProviderOptions = NonNullable<Parameters<typeof generateText>[0]["providerOptions"]>;

export const BUILTIN_PROVIDERS: Record<string, ProviderConfig> = {
    openrouter: { type: "openrouter", name: "OpenRouter" },
    openai: { type: "openai", name: "OpenAI" },
    anthropic: { type: "anthropic", name: "Anthropic" },
    google: { type: "google", name: "Google Gemini" },
    ollama: { type: "ollama", name: "Ollama locale", baseURL: "http://localhost:11434/v1", contextWindow: 4096 },
};
const KEY_ENV: Partial<Record<ProviderConfig["type"], string>> = {
    openrouter: "OPENROUTER_API_KEY", openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY", google: "GOOGLE_GENERATIVE_AI_API_KEY",
};

export class ModelSettings {
    private readonly catalogs = new Map<string, ModelInfo[]>();

    constructor(
        readonly file: string,
        private readonly env: NodeJS.ProcessEnv = process.env,
        private readonly fetcher: typeof fetch = fetch,
    ) { }

    private read(): Settings {
        let text: string;
        try {
            text = readFileSync(this.file, "utf8");
        } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return { providers: {}, modelCycle: [] };
            throw error;
        }
        let parsed: unknown;
        try { parsed = JSON.parse(text); }
        catch { throw new Error(`Invalid JSON in ${this.file}. Correct it before continuing.`); }
        const result = settingsSchema.safeParse(parsed);
        if (!result.success) throw new Error(`Invalid configuration in ${this.file}. Check providers, current model and modelCycle (no duplicate provider/model pairs).`);
        return result.data;
    }

    private write(settings: Settings): void {
        const validated = settingsSchema.parse(settings);
        writePrivateFile(this.file, JSON.stringify(validated, null, 2) + "\n");
    }

    keyEnvironment(provider: ProviderConfig): string | undefined {
        if (provider.type === "google" && !this.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() && this.env.GEMINI_API_KEY?.trim()) {
            return "GEMINI_API_KEY";
        }
        const variable = KEY_ENV[provider.type];
        return variable && this.env[variable]?.trim() ? variable : undefined;
    }

    effectiveProvider(provider: ProviderConfig): ProviderConfig {
        const variable = this.keyEnvironment(provider);
        return variable ? { ...provider, apiKey: this.env[variable]!.trim() } : provider;
    }

    providers(): Record<string, ProviderConfig> {
        const providers = this.read().providers;
        for (const [id, provider] of Object.entries(BUILTIN_PROVIDERS)) {
            if (!(id in providers) && this.keyEnvironment(provider)) providers[id] = provider;
        }
        return providers;
    }

    provider(id: string): ProviderConfig {
        const providers = this.providers();
        const provider = Object.hasOwn(providers, id) ? providers[id]
            : Object.hasOwn(BUILTIN_PROVIDERS, id) ? BUILTIN_PROVIDERS[id] : undefined;
        if (!provider) throw new Error(`Unknown provider: ${id}. Use /login.`);
        return this.effectiveProvider(provider);
    }

    saveProvider(id: string, provider: ProviderConfig): void {
        if (!/^[a-z0-9_-]+$/.test(id)) throw new Error("Provider ID must contain only lowercase letters, digits, _ or -.");
        const parsed = providerSchema.safeParse(provider);
        if (!parsed.success) throw new Error("Invalid provider configuration. Check name, base URL and context window.");
        const settings = this.read();
        settings.providers[id] = parsed.data;
        this.write(settings);
        this.catalogs.delete(id);
    }

    current(): ModelSelection | undefined {
        const saved = this.read().current;
        const model = this.env.MODEL?.trim() || saved?.model;
        if (!model) return undefined;
        const provider = this.env.CORBECODE_PROVIDER?.trim() || saved?.provider || "openrouter";
        if (saved?.provider === provider && saved.model === model) return saved;
        const info = knownModelInfo(this.provider(provider), model);
        return { provider, model, reasoning: "default", ...this.selectionDetails(info) };
    }

    environmentOverrides(): string[] {
        return ["CORBECODE_PROVIDER", "MODEL"].filter((key) => this.env[key]?.trim());
    }

    modelCycle(): ModelCycleEntry[] {
        return this.read().modelCycle;
    }

    saveModelCycle(entries: ModelCycleEntry[]): void {
        this.write({ ...this.read(), modelCycle: cycleSchema.parse(entries) });
    }

    cycleModel(): { changed: boolean; reasoningReset: boolean } {
        const overrides = this.environmentOverrides();
        if (overrides.length) throw new Error(`Ciclo modelli bloccato da ${overrides.join(", ")}. Rimuovi gli override d'ambiente.`);
        const entries = this.modelCycle();
        if (!entries.length) throw new Error("Nessun modello preferito. Usa /models favorites per aggiungere il modello corrente.");
        const current = this.current();
        const index = entries.findIndex((entry) => entry.provider === current?.provider && entry.model === current.model);
        const next = entries[(index + 1) % entries.length]!;
        if (next.provider === current?.provider && next.model === current.model) return { changed: false, reasoningReset: false };
        const provider = this.provider(next.provider);
        if (!["ollama", "openai-compatible"].includes(provider.type) && !provider.apiKey) {
            throw new Error(`No API key for ${provider.name}. Use /login.`);
        }
        const cached = this.catalogs.get(next.provider)?.find((info) => info.id === next.model);
        const info: ModelInfo = {
            contextWindow: 8192,
            ...knownModelInfo(provider, next.model),
            ...cached,
            ...next,
        };
        return { changed: true, reasoningReset: this.select(next.provider, info) };
    }

    private selectionDetails(info: ModelInfo): Pick<ModelSelection, "contextWindow" | "control"> {
        return {
            ...(info.contextWindow && { contextWindow: info.contextWindow }),
            ...(info.control && { control: info.control }),
        };
    }

    select(provider: string, info: ModelInfo): boolean {
        this.provider(provider);
        const parsed = modelInfoSchema.parse(info);
        if (parsed.tools === false) throw new Error("This model does not support the tools required by the coding agent.");
        const settings = this.read();
        const previous = settings.current?.reasoning ?? "default";
        const reasoning = parsed.control?.levels.includes(previous) ? previous : "default";
        settings.current = { provider, model: parsed.id, reasoning, ...this.selectionDetails(parsed) };
        settings.modelCycle = settings.modelCycle.map((entry) => entry.provider === provider && entry.model === parsed.id
            ? { provider, model: parsed.id, ...this.selectionDetails(parsed) } : entry);
        this.write(settings);
        return previous !== "default" && reasoning === "default";
    }

    setReasoning(reasoning: string): void {
        const current = this.current();
        if (!current) throw new Error("Select a model with /models first.");
        if (reasoning !== "default" && !current.control?.levels.includes(reasoning)) {
            throw new Error("This reasoning level is not supported by the current model.");
        }
        this.write({ ...this.read(), current: { ...current, reasoning } });
    }

    async list(id: string, refresh = false, signal?: AbortSignal): Promise<ModelInfo[]> {
        if (!refresh && this.catalogs.has(id)) return this.catalogs.get(id)!;
        const models = await discoverModels(this.provider(id), this.fetcher, signal);
        this.catalogs.set(id, models);
        return models;
    }

    async validate(provider: ProviderConfig, signal?: AbortSignal): Promise<void> {
        await validateProvider(provider, this.fetcher, signal);
    }

    async inspect(id: string, info: ModelInfo, signal?: AbortSignal): Promise<ModelInfo> {
        const provider = this.provider(id);
        return provider.type === "ollama" ? inspectOllamaModel(provider, info, this.fetcher, signal) : info;
    }

    contextLimit(): number {
        const current = this.current();
        const provider = current && this.provider(current.provider);
        const window = Math.min(provider?.contextWindow ?? Infinity, current?.contextWindow ?? Infinity);
        return Math.min(CONTEXT_LIMIT, Math.floor(window * 0.6));
    }

    request(): { model: LanguageModel; providerOptions: ProviderOptions; maxOutputTokens?: number } {
        const current = this.current();
        if (!current) throw new Error("No model configured. Use /login, then /models.");
        const provider = this.provider(current.provider);
        if (!["ollama", "openai-compatible"].includes(provider.type) && !provider.apiKey) {
            throw new Error(`No API key for ${provider.name}. Use /login.`);
        }
        const options: ProviderOptions = {};
        let maxOutputTokens: number | undefined;
        if (current.reasoning !== "default") {
            if (!current.control?.levels.includes(current.reasoning)) throw new Error("Invalid reasoning selection. Use Alt+R.");
            const level = current.reasoning;
            switch (current.control.kind) {
                case "google-level": options.google = { thinkingConfig: { thinkingLevel: level } }; break;
                case "google-budget": options.google = { thinkingConfig: { thinkingBudget: Number(level) } }; break;
                case "anthropic-adaptive": options.anthropic = { thinking: { type: "adaptive" }, effort: level }; break;
                case "anthropic-budget":
                    options.anthropic = { thinking: { type: "enabled", budgetTokens: Number(level) } };
                    maxOutputTokens = Number(level) + 4096;
                    break;
                default: {
                    const effort = current.control.kind === "toggle" ? (level === "on" ? "high" : "none") : level;
                    if (provider.type === "openrouter") options.openrouter = { reasoning: { effort } };
                    else options[provider.type === "openai" ? "openai" : current.provider] = { reasoningEffort: effort };
                }
            }
        }
        const apiKey = provider.apiKey;
        let model: LanguageModel;
        switch (provider.type) {
            case "openrouter": model = createOpenRouter({ apiKey: apiKey!, fetch: this.fetcher }).chat(current.model); break;
            case "openai": {
                const openai = createOpenAI({ apiKey: apiKey!, baseURL: "https://api.openai.com/v1", fetch: this.fetcher });
                model = /^(gpt-3\.5-|gpt-4(?:-|$)|gpt-4o|chatgpt-)/.test(current.model) ? openai.chat(current.model) : openai(current.model);
                break;
            }
            case "anthropic": model = createAnthropic({ apiKey: apiKey!, fetch: this.fetcher })(current.model); break;
            case "google": model = createGoogleGenerativeAI({ apiKey: apiKey!, fetch: this.fetcher })(current.model); break;
            default:
                model = createOpenAICompatible({
                    name: current.provider, baseURL: provider.baseURL!,
                    fetch: this.fetcher,
                    ...(apiKey && { apiKey }),
                })(current.model);
        }
        return { model, providerOptions: options, ...(maxOutputTokens && { maxOutputTokens }) };
    }
}

export const modelSettings = new ModelSettings(path.join(GLOBAL_DATA_DIR, "config.json"));
