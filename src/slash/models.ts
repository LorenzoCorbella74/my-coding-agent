import { randomUUID } from "node:crypto";
import { BUILTIN_PROVIDERS, ModelSettings, type ModelInfo, type ProviderConfig } from "./providers-models";
import { knownModelInfo } from "./modelCatalog";
import type { TerminalUi } from "../UI/terminalUi";

export function createModelCommands(ui: TerminalUi, settings: ModelSettings, updateFooter: () => void) {
    const showOverrides = () => {
        const overrides = settings.environmentOverrides();
        if (overrides.length) ui.write(`Override attivi: ${overrides.join(", ")}. La scelta salvata avra' effetto rimuovendo questi override.`);
    };

    const login = async (signal?: AbortSignal): Promise<void> => {
        const providers = settings.providers();
        const entries = { ...BUILTIN_PROVIDERS, ...providers };
        const selected = await ui.select("Configura un provider", [
            ...Object.entries(entries).map(([id, provider]) => ({
                value: id, label: `${provider.name}${id in providers ? " (configurato)" : ""}`,
            })),
            { value: "__add", label: "Aggiungi endpoint OpenAI-compatible..." },
        ]);
        if (!selected) return;
        const id = selected === "__add" ? `custom-${randomUUID().slice(0, 8)}` : selected;
        let provider: ProviderConfig;
        if (selected === "__add") {
            const name = await ui.input("Nome del provider (Esc annulla)");
            if (name === undefined) return;
            if (!name.trim()) throw new Error("Il nome del provider non puo' essere vuoto.");
            provider = { type: "openai-compatible", name: name.trim() };
        } else {
            provider = { ...entries[id]! };
        }
        if (provider.type === "ollama" || provider.type === "openai-compatible") {
            const baseURL = await ui.input("URL base OpenAI-compatible (includi /v1, Esc annulla)", { initial: provider.baseURL ?? "" });
            if (baseURL === undefined) return;
            let url: URL;
            try { url = new URL(baseURL.trim()); }
            catch { throw new Error("URL base non valido."); }
            if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
                throw new Error("Usa un URL HTTP(S) senza credenziali, query o frammento.");
            }
            provider.baseURL = baseURL.trim().replace(/\/+$/, "");
            const window = await ui.input("Finestra contesto configurata sul server, in token (Esc annulla)", {
                initial: String(provider.contextWindow ?? 4096),
            });
            if (window === undefined) return;
            const contextWindow = Number(window);
            if (!Number.isSafeInteger(contextWindow) || contextWindow < 1024) throw new Error("Il contesto deve essere un intero di almeno 1024 token.");
            provider.contextWindow = contextWindow;
        }
        const optionalKey = provider.type === "ollama" || provider.type === "openai-compatible";
        const key = await ui.input(
            `API key per ${provider.name}${optionalKey ? " (facoltativa)" : ""}${provider.apiKey ? "; vuoto conserva quella salvata" : ""}. Esc annulla`,
            { secret: true },
        );
        if (key === undefined) return;
        if (key.trim()) provider.apiKey = key.trim();
        if (!optionalKey && !provider.apiKey) throw new Error("API key obbligatoria. Nessuna modifica salvata.");
        if (provider.apiKey && provider.baseURL?.startsWith("http:") && !["localhost", "127.0.0.1", "[::1]"].includes(new URL(provider.baseURL).hostname)) {
            const confirm = await ui.select("La chiave sara' inviata senza HTTPS. Continuare?", [
                { value: "no", label: "Annulla" }, { value: "yes", label: "Continua" },
            ]);
            if (confirm !== "yes") return;
        }
        ui.setStatus(`Verifica ${provider.name}`);
        let verified = false;
        try {
            await settings.validate(provider, signal);
            verified = true;
        } catch (error) {
            ui.write(error instanceof Error ? error.message : String(error));
            if (signal?.aborted) return;
            if (error instanceof Error && /HTTP (401|403)/.test(error.message)) return;
        } finally {
            ui.clearStatus();
        }
        if (!verified) {
            const save = await ui.select("Verifica non riuscita. Salvare comunque la configurazione?", [
                { value: "no", label: "Annulla" }, { value: "yes", label: "Salva senza verifica" },
            ]);
            if (save !== "yes") return;
        }
        settings.saveProvider(id, provider);
        ui.write(`${provider.name}: configurazione salvata${verified ? " e verificata" : ", non verificata"}. /models per scegliere il modello.`);
        const variable = settings.keyEnvironment(provider);
        if (variable) ui.write(`Attenzione: ${variable} prevale sulla chiave salvata.`);
        updateFooter();
    };

    const models = async (refresh = false, signal?: AbortSignal): Promise<void> => {
        const providers = settings.providers();
        if (!Object.keys(providers).length) {
            ui.write("Nessun provider configurato. Usa /login.");
            return;
        }
        const results = new Map<string, { provider: string; info: ModelInfo }>();
        ui.setStatus("Caricamento modelli");
        try {
            await Promise.all(Object.entries(providers).map(async ([id, provider]) => {
                try {
                    const models = await settings.list(id, refresh, signal);
                    for (const info of models) results.set(`${id}/${info.id}`, { provider: id, info });
                    if (!models.length) ui.write(`${provider.name}: nessun modello compatibile nel catalogo.`);
                } catch (error) {
                    ui.write(error instanceof Error ? error.message : String(error));
                }
            }));
        } finally {
            ui.clearStatus();
        }
        if (signal?.aborted) return;
        const current = settings.current();
        const items = [...results].map(([value, { provider, info }]) => ({
            value, label: `${providers[provider]!.name} / ${info.name}${current?.provider === provider && current.model === info.id ? " (corrente)" : ""}`,
            description: `${info.id}${info.contextWindow ? ` | contesto ${info.contextWindow}` : ""}${info.tools === undefined ? " | supporto tool da verificare" : ""}`,
        })).sort((a, b) => a.label.localeCompare(b.label));
        items.push({ value: "__manual", label: "Inserisci ID modello manualmente...", description: "Per endpoint senza catalogo o modelli non elencati" });
        const selected = await ui.select("Seleziona modello (scrivi per cercare)", items,
            Math.max(0, items.findIndex((item) => item.value === `${current?.provider}/${current?.model}`)), true);
        if (!selected) return;
        let choice = results.get(selected);
        if (selected === "__manual") {
            const provider = await ui.select("Provider del modello", Object.entries(providers).map(([value, entry]) => ({ value, label: entry.name })));
            if (!provider) return;
            const model = await ui.input("ID esatto del modello (Esc annulla)");
            if (model === undefined) return;
            if (!model.trim()) throw new Error("ID modello obbligatorio.");
            const info = knownModelInfo(settings.provider(provider), model.trim());
            const window = await ui.input("Limite contesto del modello, in token (Esc annulla)", { initial: String(info.contextWindow ?? 8192) });
            if (window === undefined) return;
            const contextWindow = Number(window);
            if (!Number.isSafeInteger(contextWindow) || contextWindow < 1024) throw new Error("Contesto non valido: minimo 1024 token.");
            info.contextWindow = contextWindow;
            choice = { provider, info };
        }
        if (!choice) return;
        const info = await settings.inspect(choice.provider, choice.info, signal);
        if (info.tools === undefined) ui.write("Supporto tool non dichiarato dal catalogo: la compatibilita' dipende dal modello e dal server.");
        const reset = settings.select(choice.provider, info);
        if (reset) ui.write("Il precedente livello di reasoning non e' compatibile: ripristinato Default.");
        showOverrides();
        updateFooter();
        ui.write("Modello salvato. La selezione effettiva nel footer vale dalla prossima richiesta.");
    };

    const next = async (): Promise<void> => {
        const result = settings.cycleModel();
        if (result.reasoningReset) ui.write("Il precedente livello di reasoning non e' compatibile: ripristinato Default.");
        updateFooter();
        const current = settings.current()!;
        ui.write(result.changed
            ? `Modello: ${settings.provider(current.provider).name} / ${current.model}. Dalla prossima richiesta il contesto sara' inviato a questo provider.`
            : "Il modello corrente e' l'unico preferito.");
    };

    const favorites = async (): Promise<void> => {
        while (true) {
            const entries = settings.modelCycle();
            const action = await ui.select(`Modelli preferiti (${entries.length}, ordine di Alt+M)`, [
                { value: "add", label: "Aggiungi o aggiorna il modello corrente" },
                ...entries.map((entry, index) => ({ value: String(index), label: `${index + 1}. ${entry.provider} / ${entry.model}` })),
            ]);
            if (action === undefined) return;
            if (action === "add") {
                const current = settings.current();
                if (!current) throw new Error("Seleziona prima un modello con /models.");
                const { reasoning: _, ...entry } = current;
                const index = entries.findIndex((item) => item.provider === entry.provider && item.model === entry.model);
                if (index < 0) entries.push(entry);
                else entries[index] = entry;
                settings.saveModelCycle(entries);
                ui.write(`Preferito salvato: ${entry.provider} / ${entry.model}.`);
                continue;
            }
            const index = Number(action);
            const entry = entries[index]!;
            const edit = await ui.select(`${entry.provider} / ${entry.model}`, [
                { value: "remove", label: "Rimuovi dai preferiti" },
                ...(index > 0 ? [{ value: "up", label: "Sposta prima" }] : []),
                ...(index < entries.length - 1 ? [{ value: "down", label: "Sposta dopo" }] : []),
            ]);
            if (edit === undefined) continue;
            entries.splice(index, 1);
            if (edit !== "remove") entries.splice(index + (edit === "up" ? -1 : 1), 0, entry);
            settings.saveModelCycle(entries);
            ui.write(edit === "remove" ? "Preferito rimosso; modello corrente invariato." : "Ordine dei preferiti salvato.");
        }
    };

    const reasoning = async (): Promise<void> => {
        const current = settings.current();
        if (!current) { ui.write("Seleziona prima un modello con /models."); return; }
        if (!current.control) {
            ui.write("Questo modello non espone controlli di reasoning noti. Verranno usati i default del provider.");
            return;
        }
        const budget = current.control.kind.endsWith("budget");
        const levels = ["default", ...current.control.levels];
        const selected = await ui.select("Reasoning", levels.map((value) => ({
            value, label: value === "default" ? "Default del provider" : budget ? `${value} token di thinking` : value,
        })), Math.max(0, levels.indexOf(current.reasoning)));
        if (selected === undefined) return;
        settings.setReasoning(selected);
        updateFooter();
    };

    return { login, models, reasoning, next, favorites };
}
