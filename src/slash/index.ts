import chalk from "chalk";
import { autoCompact } from "../features/compact";
import { getSkillsTable } from "../tools/tools-definitions";
import { lavender } from "../UI/palette";
import { withSpinner } from "../UI/spinner";
import type { ModelSettings } from "./providers-models";
import type { Session, SessionStore } from "../features/sessionStore";
import type { FlowStore } from "./flowStore";
import type { TerminalUi } from "../UI/terminalUi";
import { FLOW_COMMANDS, FlowController } from "./flow";
import { runFlowAgent } from "./flowRuntime";
import { createModelCommands } from "./models";

export type ChatState = {
    session: Session;
    requestController: AbortController | undefined;
    lastTurnUsage: string;
};

const descriptions: Record<string, string> = {
    "/login": "Configure provider credentials",
    "/models": "Select model; refresh catalogs; next/favorites for quick cycling",
    "/verbose": "Toggle tool execution details",
    "/quit": "Quit",
    "/exit": "Quit",
    "/new": "Start a new session",
    "/sessions": "List sessions",
    "/skills": "List available skills",
    "/restore": "Restore a session",
    "/compress": "Compress the conversation",
    ...FLOW_COMMANDS,
};

export const SLASH_COMMANDS = Object.entries(descriptions).map(([command, description]) => ({
    name: command.slice(1), description,
}));

export function createSlashCommands({ ui, settings, sessionStore, flowStore, state, updateFooter }: {
    ui: TerminalUi;
    settings: ModelSettings;
    sessionStore: SessionStore;
    flowStore: FlowStore;
    state: ChatState;
    updateFooter: () => void;
}) {
    const reportError = (error: unknown) => ui.write(chalk.red(error instanceof Error ? error.message : String(error)));
    const models = createModelCommands(ui, settings, updateFooter);
    ui.onReasoning = () => { void models.reasoning().catch(reportError); };
    ui.onNextModel = () => { void models.next().catch(reportError); };

    const withRequest = async (run: (signal: AbortSignal) => Promise<void>): Promise<boolean> => {
        state.requestController = new AbortController();
        try {
            await run(state.requestController.signal);
        } finally {
            state.requestController = undefined;
        }
        return false;
    };
    const selectSession = (session: Session) => {
        state.session = session;
        state.lastTurnUsage = "";
        updateFooter();
    };
    const exit = async () => {
        ui.write(chalk.gray("Exiting chat..."));
        ui.close();
        return true;
    };
    const handlers: Record<string, (args: string) => Promise<boolean>> = {
        "/login": () => withRequest((signal) => models.login(signal)),
        "/models": (args) => {
            if (args === "next") return withRequest(() => models.next());
            if (args === "favorites") return withRequest(() => models.favorites());
            if (args && args !== "refresh") throw new Error("Usage: /models [refresh|next|favorites]");
            return withRequest((signal) => models.models(args === "refresh", signal));
        },
        "/verbose": async () => {
            ui.verbose = !ui.verbose;
            ui.write(chalk.cyan(`Verbose: ${ui.verbose ? "ON" : "OFF"}`));
            return false;
        },
        "/quit": exit,
        "/exit": exit,
        "/new": async () => {
            selectSession(sessionStore.create());
            ui.write(chalk.cyan(`Started session ${state.session.id.slice(0, 8)}.`));
            return false;
        },
        "/sessions": async () => {
            const sessions = sessionStore.list();
            if (sessions.length === 0) {
                ui.write(lavender("No sessions found."));
                return false;
            }
            const selected = await ui.select("Seleziona una sessione", sessions.map((session) => ({
                value: session.id,
                label: `${session.id.slice(0, 8)} ${session.title || session.preview}${session.id === state.session.id ? " (corrente)" : ""}`,
                description: `${new Date(session.updatedAt).toLocaleString()} | ${session.messageCount} messaggi`,
            })), sessions.findIndex((session) => session.id === state.session.id));
            if (selected) {
                selectSession(sessionStore.restore(selected));
                ui.write(chalk.cyan(`Restored session ${state.session.id.slice(0, 8)}.`));
            }
            return false;
        },
        "/skills": async () => {
            ui.write(getSkillsTable(), "markdown");
            return false;
        },
        "/restore": async (idPrefix) => {
            if (!idPrefix) {
                ui.write(lavender("Usage: /restore <sessionId>"));
                return false;
            }
            selectSession(sessionStore.restore(idPrefix));
            ui.write(chalk.cyan(`Restored session ${state.session.id.slice(0, 8)}.`));
            return false;
        },
        "/compress": async () => {
            const messages = state.session.messages;
            if (messages.length === 0) {
                ui.write(lavender("Nothing to compress."));
                return false;
            }
            return withRequest(async (signal) => {
                const compacted = await withSpinner("Compressing context", () => autoCompact(messages, signal));
                sessionStore.replace(state.session.id, compacted);
                messages.splice(0, messages.length, ...compacted);
                ui.write(chalk.cyan("Conversation compressed."));
            });
        },
    };

    const flowController = new FlowController(flowStore, {
        runAgent: (run) => runFlowAgent(run, state.session, (tools) => {
            sessionStore.approveTools(state.session.id, tools);
            state.session.approvedTools = tools;
        }, state.requestController?.signal),
        confirm: async (question) => {
            const answer = await ui.select(question, [
                { value: "no", label: "Annulla" },
                { value: "yes", label: "Conferma" },
            ], 0);
            state.requestController?.signal.throwIfAborted();
            return answer === "yes";
        },
        select: async (flows, currentId) => {
            if (flows.length === 0) {
                ui.write("Nessuna change salvata.");
                return undefined;
            }
            return ui.select("Seleziona una change", flows.map((flow) => ({
                value: flow.id,
                label: `${flow.id.slice(0, 8)} ${flow.title}${flow.id === currentId ? " (corrente)" : ""}`,
                description: `${flow.closed ? "chiusa" : "aperta"} | ${flow.phase} | revisione ${flow.revision}`,
            })), Math.max(0, flows.findIndex((flow) => flow.id === currentId)));
        },
        write: (text) => ui.write(text, "markdown"),
    });
    for (const command of Object.keys(FLOW_COMMANDS)) {
        handlers[command] = async (args) => {
            try {
                return await withRequest(() => flowController.execute(command, args));
            } finally {
                updateFooter();
            }
        };
    }

    return {
        async execute(query: string): Promise<boolean | undefined> {
            const input = query.trim();
            if (["exit", "quit"].includes(input.toLowerCase())) return exit();
            if (!input.startsWith("/")) return undefined;
            const [command = "", ...args] = input.split(/\s+/);
            try {
                const handler = handlers[command.toLowerCase()];
                if (!handler) ui.write(lavender(`Unknown command: ${command}`));
                else if (await handler(args.join(" "))) return true;
            } catch (error) {
                reportError(error);
            }
            ui.write();
            return false;
        },
    };
}
