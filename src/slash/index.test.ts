import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ProcessTerminal, stripTerminalSequences } from "@earendil-works/pi-tui";
import { createSlashCommands, SLASH_COMMANDS, type ChatState } from "./index";
import { TerminalUi } from "../UI/terminalUi";
import { ModelSettings } from "./providers-models";
import { SessionStore } from "../features/sessionStore";
import { FlowStore } from "./flowStore";

class TestTerminal extends ProcessTerminal {
    input: ((data: string) => void) | undefined;
    override get columns() { return 100; }
    override get rows() { return 24; }
    override start(input: (data: string) => void): void { this.input = input; }
    override stop(): void { }
    override write(): void { }
    override moveBy(): void { }
    override hideCursor(): void { }
    override showCursor(): void { }
    override clearLine(): void { }
    override clearFromCursor(): void { }
    override clearScreen(): void { }
    override setProgress(): void { }
    override restoreOnExit(): void { }
}

const fixture = () => {
    const root = mkdtempSync(path.join(tmpdir(), "corbecode-slash-"));
    const sessionStore = new SessionStore(root);
    const flowStore = new FlowStore(root);
    const settings = new ModelSettings(path.join(root, "config.json"), {});
    const state: ChatState = { session: sessionStore.resumeOrCreate(), requestController: undefined, lastTurnUsage: "" };
    const terminal = new TestTerminal();
    const ui = new TerminalUi(root, SLASH_COMMANDS, terminal);
    let updates = 0;
    const commands = createSlashCommands({ ui, settings, sessionStore, flowStore, state, updateFooter: () => { updates++; } });
    ui.onInterrupt = () => state.requestController?.abort();
    ui.start();
    return {
        commands, settings, sessionStore, flowStore, state, ui, terminal,
        get updates() { return updates; },
        transcript: () => ui.transcript.render(100).map(stripTerminalSequences).join("\n"),
        close: () => { ui.close(); rmSync(root, { recursive: true, force: true }); },
    };
};

test("dispatches commands and restores durable session state without consuming normal chat", async () => {
    const f = fixture();
    try {
        assert.equal(await f.commands.execute("A normal chat message"), undefined);
        const original = f.state.session.id;
        f.sessionStore.append(original, { role: "user", content: "Previous message" });
        f.state.lastTurnUsage = "Input: 100";
        assert.equal(await f.commands.execute("  /NeW  "), false);
        assert.notEqual(f.state.session.id, original);
        assert.equal(f.state.session.messages.length, 0);
        assert.equal(f.state.lastTurnUsage, "");
        await f.commands.execute("/compress");
        assert.match(f.transcript(), /Nothing to compress/);
        await f.commands.execute(`/RESTORE ${original.slice(0, 8)}`);
        assert.equal(f.state.session.id, original);
        assert.equal(f.state.session.messages[0]?.content, "Previous message");
        assert.equal(f.updates, 2);
        await f.commands.execute("/VERBOSE");
        assert.equal(f.ui.verbose, true);
        await f.commands.execute("/unknown");
        await f.commands.execute("/models unsupported");
        await f.commands.execute("/restore unknown");
        assert.match(f.transcript(), /Unknown command: \/unknown/);
        assert.match(f.transcript(), /Usage: \/models/);
        assert.equal(f.state.session.id, original);
        assert.equal(await f.commands.execute("QuIt"), true);
    } finally {
        f.close();
    }
});

test("routes model controls and clears the shared abort controller after cancelling a picker", async () => {
    const f = fixture();
    try {
        f.settings.saveProvider("local", { type: "ollama", name: "Local", baseURL: "http://localhost:11434/v1" });
        f.settings.select("local", { id: "first", name: "First" });
        f.settings.saveModelCycle([{ provider: "local", model: "first" }, { provider: "local", model: "second" }]);
        await f.commands.execute("/models next");
        assert.equal(f.settings.current()?.model, "second");
        assert.equal(f.state.requestController?.signal.aborted, undefined);
        const pending = f.commands.execute("/models favorites");
        const controller = f.state.requestController;
        assert.ok(controller);
        f.terminal.input?.("\x03");
        await pending;
        assert.equal(controller.signal.aborted, true);
        assert.equal(f.state.requestController, undefined);
        assert.equal(f.settings.modelCycle().length, 2);
        const login = f.commands.execute("/login");
        f.terminal.input?.("\x1b");
        await login;
        assert.equal(f.state.requestController, undefined);
        assert.equal(Object.keys(f.settings.providers()).length, 1);
        assert.deepEqual(f.state.session.messages, []);
    } finally {
        f.close();
    }
});

test("routes workflow selection and errors without running agents or retaining request state", async () => {
    const f = fixture();
    try {
        const flow = f.flowStore.create("Test change");
        f.flowStore.pause();
        await f.commands.execute(`/flow:resume ${flow.id.slice(0, 8)}`);
        assert.equal(f.flowStore.current()?.id, flow.id);
        assert.match(f.transcript(), /No execution started/);
        await f.commands.execute("/flow:apply");
        assert.match(f.transcript(), /No plan available/);
        assert.equal(f.state.requestController, undefined);
        await f.commands.execute("/flow:pause");
        assert.equal(f.flowStore.current(), undefined);
        const selection = f.commands.execute("/flow:resume");
        f.terminal.input?.("\x1b");
        await selection;
        assert.equal(f.flowStore.current(), undefined);
        assert.equal(f.state.requestController, undefined);
        assert.ok(f.updates >= 4);
    } finally {
        f.close();
    }
});
