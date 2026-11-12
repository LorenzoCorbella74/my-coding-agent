import assert from "node:assert/strict";
import chalk from "chalk";
import { lavender } from "./palette";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ProcessTerminal, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { createAutocomplete, renderMarkdown, TerminalUi } from "./terminalUi";
import { getSKILLS_DIR, setSKILLS_DIR, SkillLoader } from "./skills";
import { getActionPreview } from "./actionPreview";
import { consumeTextStream } from "./agentStream";
import { formatToolActivity } from "./toolActivity";
import type { TextStreamPart, ToolSet } from "ai";
import { executeCommandWithResult } from "./tools/commands";
import { ModelSettings } from "./models";
import { createModelCommands } from "./modelCommands";

class TestTerminal extends ProcessTerminal {
    input: ((data: string) => void) | undefined;
    resize: (() => void) | undefined;
    output = "";
    width = 80;
    height = 24;
    stopped = false;
    override get columns() { return this.width; }
    override get rows() { return this.height; }
    override start(input: (data: string) => void, resize: () => void): void {
        this.input = input;
        this.resize = resize;
    }
    override stop(): void { this.stopped = true; }
    override write(data: string): void { this.output += data; }
    override moveBy(): void { }
    override hideCursor(): void { }
    override showCursor(): void { }
    override clearLine(): void { }
    override clearFromCursor(): void { }
    override clearScreen(): void { }
    override setProgress(): void { }
    override restoreOnExit(): void { }
}

test("toggles verbose tool details without hiding outputs or errors", () => {
    const ui = new TerminalUi(tmpdir(), [], new TestTerminal());
    try {
        ui.writeVerbose("Tool started: hidden");
        assert.equal(ui.transcript.render(80).length, 0);
        ui.verbose = !ui.verbose;
        for (const text of ["Tool started: visible", "Input: visible", "Tool completed: visible"]) {
            ui.writeVerbose(text);
        }
        ui.verbose = !ui.verbose;
        ui.writeVerbose("Tool completed: hidden");
        ui.writeToolOutput("result", 500);
        ui.write("Tool failed: error");
        const rendered = ui.transcript.render(80).map(stripTerminalSequences).join("\n");
        assert.doesNotMatch(rendered, /hidden/);
        assert.match(rendered, /Tool started: visible/);
        assert.match(rendered, /Input: visible/);
        assert.match(rendered, /Tool completed: visible/);
        assert.match(rendered, /result/);
        assert.match(rendered, /Tool failed: error/);
    } finally {
        ui.close();
    }
});

test("shows tool activity before its streamed result even with verbose disabled", async () => {
    const terminal = new TestTerminal();
    const ui = new TerminalUi(tmpdir(), [], terminal);
    let release = () => { };
    let activityReady = () => { };
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { activityReady = resolve; });
    let consumption: Promise<void> | undefined;
    try {
        ui.start();
        const stream: AsyncIterable<TextStreamPart<ToolSet>> = {
            async *[Symbol.asyncIterator]() {
                yield { type: "text-start", id: "1" };
                yield { type: "text-delta", id: "1", text: "Inspecting files" };
                yield { type: "text-end", id: "1" };
                yield { type: "tool-call", toolCallId: "read-1", toolName: "read_file", input: { filePath: "src/index.ts" } } as TextStreamPart<ToolSet>;
                await gate;
                yield { type: "text-start", id: "2" };
                yield { type: "text-delta", id: "2", text: "File inspected" };
            },
        };
        let appendDelta = (_delta: string) => { };
        consumption = consumeTextStream(stream, {
            onTextStart: () => { appendDelta = ui.startTextStream("CORBE CODE", true); },
            onTextDelta: (delta) => appendDelta(delta),
            onToolCall: (toolName, input) => {
                ui.write(chalk.bold(lavender(formatToolActivity(toolName, input))));
                activityReady();
            },
        });
        await ready;
        ui.tui.renderNow();
        const frame = ui.tui.getScreenLines().map(stripTerminalSequences).join("\n");
        assert.equal(ui.verbose, false);
        assert.match(frame, /read: src\/index\.ts/);
        assert.doesNotMatch(frame, /File inspected/);
        release();
        await consumption;
        const transcript = ui.transcript.render(80).map(stripTerminalSequences).join("\n");
        assert.equal(transcript.match(/read: src\/index\.ts/g)?.length, 1);
        assert.ok(transcript.indexOf("Inspecting files") < transcript.indexOf("read: src/index.ts"));
        assert.ok(transcript.indexOf("read: src/index.ts") < transcript.indexOf("File inspected"));
    } finally {
        release();
        await consumption;
        ui.close();
    }
});

test("spaces the header and separates hints from conversation messages", () => {
    const ui = new TerminalUi(tmpdir(), [], new TestTerminal());
    try {
        ui.writeHeader("CORBE CODE", "Enter: invia");
        ui.write("first message");
        const lines = ui.transcript.render(80).map(stripTerminalSequences).map((line) => line.trim());
        assert.equal(lines[0], "CORBE CODE");
        assert.equal(lines[1], "");
        assert.equal(lines[2], "Enter: invia");
        assert.equal(visibleWidth(ui.transcript.render(80)[2] ?? ""), 80);
        const message = lines.indexOf("first message");
        assert.ok(lines.slice(3, message).some((line) => /[─━-]{3}/.test(line)));
        assert.equal(lines[message - 1], "");
    } finally {
        ui.close();
    }
});

test("completes slash commands and @ paths including directories and spaces", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "corbecode-tui-files-"));
    try {
        mkdirSync(path.join(workspace, "src"));
        writeFileSync(path.join(workspace, "src", "main.ts"), "");
        writeFileSync(path.join(workspace, "a file.md"), "");
        const provider = createAutocomplete(workspace, [{ name: "restore", description: "Restore session" }, { name: "new" }]);
        const options = { signal: new AbortController().signal };
        const commands = await provider.getSuggestions(["/re"], 0, 3, options);
        assert.deepEqual(commands?.items.map((item) => item.value), ["restore"]);
        const files = await provider.getSuggestions(["@"], 0, 1, options);
        assert.ok(files?.items.some((item) => item.value === "@src/"));
        const directory = files?.items.find((item) => item.value === "@src/");
        assert.ok(directory);
        assert.equal(provider.applyCompletion(["@"], 0, 1, directory, "@").lines[0], "@src/");
        const nested = await provider.getSuggestions(["Read @src/ma"], 0, 12, options);
        assert.equal(nested?.items[0]?.value, "@src/main.ts");
        const windows = await provider.getSuggestions(["@src\\ma"], 0, 7, options);
        assert.equal(windows?.items[0]?.value, "@src/main.ts");
        const spaces = await provider.getSuggestions(['@"a '], 0, 4, options);
        assert.equal(spaces?.items[0]?.value, '@"a file.md"');
        await assert.rejects(provider.getSuggestions(["@../"], 0, 4, options), /inside the workspace/);
    } finally {
        rmSync(workspace, { recursive: true, force: true });
    }
});

test("renders Markdown and keeps the input below a scrolling transcript on resize", async () => {
    const terminal = new TestTerminal();
    const ui = new TerminalUi(tmpdir(), [{ name: "new" }], terminal);
    try {
        ui.start();
        ui.write("first");
        ui.write("second");
        assert.deepEqual(ui.transcript.render(80).map((line) => stripTerminalSequences(line).trim()), ["first", "second"]);
        ui.write("# Heading\n\n**Bold** and `code`\n\n- item\n\n```ts\nconst x = 1;\n```", "assistant");
        const markdown = renderMarkdown("# Heading\n\n**Bold** and `code`").render(40).map(stripTerminalSequences).join("\n");
        assert.match(markdown, /Heading/);
        assert.doesNotMatch(markdown, /\*\*Bold\*\*/);
        for (let index = 0; index < 60; index++) ui.write(`message ${index}`);
        const answer = ui.ask("YOU >");
        ui.setFooter("Version 0.0.2 | LLM test | Session abc");
        const inputLines = ui.editor.render(80).map(stripTerminalSequences);
        assert.match(inputLines[1] ?? "", /YOU > /);
        assert.equal(ui.editor.getText(), "");
        terminal.input?.("/");
        await new Promise((resolve) => setTimeout(resolve, 150));
        ui.tui.renderNow();
        assert.ok(ui.tui.getScreenLines().map(stripTerminalSequences).some((line) => line.includes("new")));
        ui.editor.setText("");
        ui.tui.renderNow();
        let frame = ui.tui.getScreenLines().map(stripTerminalSequences);
        assert.equal(frame.length, terminal.height);
        assert.match(frame.at(-1) ?? "", /Version 0.0.2/);
        assert.ok(frame.findIndex((line) => line.includes("message 59")) < frame.findIndex((line) => line.includes("YOU >")));
        terminal.width = 36;
        terminal.height = 12;
        terminal.resize?.();
        ui.tui.renderNow();
        frame = ui.tui.getScreenLines().map(stripTerminalSequences);
        assert.equal(frame.length, 12);
        assert.ok(frame.every((line) => visibleWidth(line) <= 36));
        terminal.input?.("hello");
        terminal.input?.("\r");
        assert.equal(await answer, "hello");
        assert.ok(ui.transcript.render(36).map(stripTerminalSequences).some((line) => line.includes("YOU > hello")));
        assert.equal(ui.editor.disableSubmit, true);
        ui.setStatus("Thinking");
        ui.tui.renderNow();
        const thinkingFrame = ui.tui.getScreenLines().map(stripTerminalSequences).join("\n");
        assert.match(thinkingFrame, /Thinking/);
        assert.doesNotMatch(thinkingFrame, /Attendere/);
        assert.ok(!ui.tui.getScreenLines().map(stripTerminalSequences).some((line) => line.trim() === "YOU >"));
        ui.clearStatus();
        const cancelled = ui.ask("Approve? [s/N/a]");
        ui.tui.renderNow();
        assert.match(ui.tui.getScreenLines().map(stripTerminalSequences).join("\n"), /Approve\?/);
        const rejection = assert.rejects(cancelled, /cancelled by user/);
        terminal.input?.("\x03");
        await rejection;
        ui.setStatus("Thinking");
        ui.clearStatus();
    } finally {
        ui.close();
    }
    assert.equal(terminal.stopped, true);
    await assert.rejects(ui.ask("Closed"), /closed/);
});

test("opens the @ completion menu in the editor without fd", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "corbecode-tui-menu-"));
    writeFileSync(path.join(workspace, "file.ts"), "");
    const terminal = new TestTerminal();
    const ui = new TerminalUi(workspace, [], terminal);
    try {
        ui.start();
        const pending = ui.ask("YOU >");
        const closed = assert.rejects(pending, /closed/);
        terminal.input?.("@");
        await new Promise((resolve) => setTimeout(resolve, 150));
        ui.tui.renderNow();
        assert.ok(ui.tui.getScreenLines().map(stripTerminalSequences).some((line) => line.includes("file.ts")));
        ui.close();
        await closed;
    } finally {
        ui.close();
        rmSync(workspace, { recursive: true, force: true });
    }
});

test("selects sessions with arrows and Enter and cancels with Escape", async () => {
    const terminal = new TestTerminal();
    const ui = new TerminalUi(tmpdir(), [], terminal);
    try {
        ui.start();
        const items = [{ value: "first", label: "First" }, { value: "second", label: "Second" }];
        for (let index = 0; index < 60; index += 1) ui.write(`message ${index}`);
        const selected = ui.select("Sessions", items);
        ui.tui.renderNow();
        const frame = ui.tui.getScreenLines().map(stripTerminalSequences);
        assert.equal(ui.tui.hasOverlay(), false);
        assert.ok(frame.findIndex((line) => line.includes("message 59")) < frame.findIndex((line) => line.includes("Sessions")));
        assert.ok(frame.findIndex((line) => line.includes("Sessions")) >= terminal.height - 6);
        terminal.input?.("\x1b[B");
        terminal.input?.("\r");
        assert.equal(await selected, "second");
        assert.match(ui.transcript.render(80).map(stripTerminalSequences).join("\n"), /Sessions: Second/);
        assert.equal(ui.tui.hasOverlay(), false);
        const cancelled = ui.select("Sessions", items);
        terminal.input?.("\x1b");
        assert.equal(await cancelled, undefined);
        const answer = ui.ask("YOU >");
        const pendingSelection = ui.select("Confirm", items);
        assert.equal(ui.editor.disableSubmit, true);
        terminal.input?.("\x1b");
        await pendingSelection;
        assert.equal(ui.editor.disableSubmit, false);
        terminal.input?.("next");
        terminal.input?.("\r");
        assert.equal(await answer, "next");
        const closed = ui.select("Sessions", items);
        ui.close();
        assert.equal(await closed, undefined);
    } finally {
        ui.close();
    }
});

test("masks credential input and never adds secrets to transcript or editor history, including cancellation", async () => {
    const terminal = new TestTerminal();
    const ui = new TerminalUi(tmpdir(), [], terminal);
    try {
        ui.start();
        const secret = "test-secret-that-must-not-leak";
        const input = ui.input("API key", { secret: true });
        terminal.input?.(`\x1b[200~${secret}\x1b[201~`);
        ui.tui.renderNow();
        assert.doesNotMatch(ui.tui.getScreenLines().join("\n"), new RegExp(secret));
        assert.match(ui.tui.getScreenLines().join("\n"), /\*{10}/);
        terminal.input?.("\r");
        assert.equal(await input, secret);
        const cancelled = ui.input("API key", { secret: true });
        terminal.input?.("cancelled-test-secret");
        terminal.input?.("\x1b");
        assert.equal(await cancelled, undefined);
        const chat = ui.ask("YOU >");
        terminal.input?.("\x1b[A");
        assert.doesNotMatch(ui.editor.getText(), /secret/);
        terminal.input?.("hello");
        terminal.input?.("\r");
        await chat;
        ui.tui.renderNow();
        assert.doesNotMatch(terminal.output, /test-secret-that-must-not-leak|cancelled-test-secret/);
        assert.doesNotMatch(ui.transcript.render(80).join("\n"), /secret/);
    } finally {
        ui.close();
    }
});

test("searches models by substring and Alt+R changes reasoning only at the chat prompt, preserving the draft", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "corbecode-model-controls-"));
    const terminal = new TestTerminal();
    const ui = new TerminalUi(root, [], terminal);
    try {
        const settings = new ModelSettings(path.join(root, "config.json"), {});
        settings.saveProvider("local", { type: "ollama", name: "Local", baseURL: "http://localhost:11434/v1" });
        settings.select("local", { id: "coding", name: "Coding", control: { kind: "effort", levels: ["low", "high"] } });
        ui.start();
        const models = ui.select("Models", [
            { value: "first", label: "OpenAI / General" }, { value: "second", label: "Ollama / Local coding model" },
        ], 0, true);
        terminal.input?.("coding");
        ui.tui.renderNow();
        assert.doesNotMatch(ui.tui.getScreenLines().join("\n"), /OpenAI/);
        terminal.input?.("\r");
        assert.equal(await models, "second");
        const commands = createModelCommands(ui, settings, () => { });
        let changed: Promise<void> | undefined;
        ui.onReasoning = () => { changed = commands.reasoning(); };
        terminal.input?.("\x1br");
        assert.equal(changed, undefined);
        const chat = ui.ask("YOU >");
        terminal.input?.("unfinished draft");
        terminal.input?.("\x1br");
        assert.ok(changed);
        terminal.input?.("\x1b[B");
        terminal.input?.("\r");
        await changed;
        assert.equal(settings.current()?.reasoning, "low");
        assert.equal(ui.editor.getText(), "unfinished draft");
        terminal.input?.("\r");
        assert.equal(await chat, "unfinished draft");
        changed = undefined;
        const approval = ui.ask("Execute? [s/N]");
        terminal.input?.("\x1br");
        assert.equal(changed, undefined);
        terminal.input?.("n");
        terminal.input?.("\r");
        assert.equal(await approval, "n");
    } finally {
        ui.close();
        rmSync(root, { recursive: true, force: true });
    }
});

test("logs in and selects a model through the real UI, without persisting rejected credentials", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "corbecode-login-"));
    const terminal = new TestTerminal();
    const ui = new TerminalUi(root, [], terminal);
    try {
        let valid = false;
        const key = "test-login-credential";
        const fetcher: typeof fetch = async (input, init) => {
            assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${key}`);
            if (String(input).endsWith("/key")) return new Response("{}", { status: valid ? 200 : 401 });
            return Response.json({ data: [{ id: "provider/coder", name: "Coding model", supported_parameters: ["tools"] }] });
        };
        const settings = new ModelSettings(path.join(root, "config.json"), {}, fetcher);
        const commands = createModelCommands(ui, settings, () => { });
        const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
        ui.start();
        const rejected = commands.login();
        terminal.input?.("\r");
        await tick();
        terminal.input?.(key);
        terminal.input?.("\r");
        await rejected;
        assert.deepEqual(settings.providers(), {});
        valid = true;
        const accepted = commands.login();
        terminal.input?.("\r");
        await tick();
        terminal.input?.(key);
        terminal.input?.("\r");
        await accepted;
        assert.equal(settings.provider("openrouter").apiKey, key);
        const selection = commands.models();
        await tick();
        terminal.input?.("coder");
        terminal.input?.("\r");
        await selection;
        assert.equal(new ModelSettings(settings.file, {}).current()?.model, "provider/coder");
        assert.doesNotMatch(ui.transcript.render(80).join("\n"), new RegExp(key));
        assert.doesNotMatch(terminal.output, new RegExp(key));
    } finally {
        ui.close();
        rmSync(root, { recursive: true, force: true });
    }
});

test("keeps loading visible after workflow and tool approval with a full transcript", async () => {
    const terminal = new TestTerminal();
    const ui = new TerminalUi(tmpdir(), [], terminal);
    try {
        ui.start();
        for (let index = 0; index < 60; index += 1) ui.write(`message ${index}`);
        const command = ui.ask("YOU >");
        terminal.input?.("/flow:apply");
        terminal.input?.("\r");
        await command;
        const approval = ui.select("Approve the plan?", [{ value: "yes", label: "Confirm" }]);
        ui.tui.renderNow();
        terminal.input?.("\r");
        assert.equal(await approval, "yes");
        ui.setStatus("Developer thinking");
        ui.tui.renderNow();
        assert.match(ui.tui.getScreenLines().map(stripTerminalSequences).join("\n"), /Developer thinking/);
        ui.clearStatus();
        const toolApproval = ui.ask("Execute? [s/N]");
        ui.tui.renderNow();
        terminal.input?.("s");
        terminal.input?.("\r");
        assert.equal(await toolApproval, "s");
        ui.setStatus("Subagent thinking");
        ui.tui.renderNow();
        assert.match(ui.tui.getScreenLines().map(stripTerminalSequences).join("\n"), /Subagent thinking/);
        assert.equal(ui.editor.disableSubmit, true);
        ui.clearStatus();
        const next = ui.ask("YOU >");
        terminal.input?.("next");
        terminal.input?.("\r");
        assert.equal(await next, "next");
    } finally {
        ui.close();
    }
});

test("resizes inline selections while preserving the selected item and transcript scrolling", async () => {
    const terminal = new TestTerminal();
    const ui = new TerminalUi(tmpdir(), [], terminal);
    try {
        ui.start();
        for (let index = 0; index < 60; index += 1) ui.write(`message ${index}`);
        ui.setFooter("Session abc | Flow xyz");
        const items = Array.from({ length: 12 }, (_, index) => ({ value: String(index), label: `Choice ${index}` }));
        const selected = ui.select("Confirm this change and preserve all the existing implementation tasks and verification results?", items, 8);
        ui.tui.renderNow();
        terminal.width = 36;
        terminal.height = 12;
        terminal.resize?.();
        ui.tui.renderNow();
        let frame = ui.tui.getScreenLines().map(stripTerminalSequences);
        assert.equal(frame.length, 12);
        assert.ok(frame.every((line) => visibleWidth(line) <= 36));
        assert.ok(frame.some((line) => line.includes("message 59")));
        assert.ok(frame.some((line) => line.includes("Choice 8")));
        assert.match(frame.at(-1) ?? "", /Session abc/);
        terminal.input?.("\x1b[5~");
        ui.tui.renderNow();
        frame = ui.tui.getScreenLines().map(stripTerminalSequences);
        assert.ok(!frame.some((line) => line.includes("message 59")));
        assert.ok(frame.some((line) => line.includes("Choice 8")));
        terminal.input?.("\x1b[B");
        terminal.input?.("\r");
        assert.equal(await selected, "9");
        assert.equal(ui.tui.hasOverlay(), false);
    } finally {
        ui.close();
    }
});

test("renders loading and receives interrupts while an approved shell command runs", async () => {
    const terminal = new TestTerminal();
    const ui = new TerminalUi(tmpdir(), [], terminal);
    let execution: Promise<Awaited<ReturnType<typeof executeCommandWithResult>>> | undefined;
    try {
        ui.start();
        const approval = ui.ask("Execute? [s/N]");
        terminal.input?.("s");
        terminal.input?.("\r");
        assert.equal(await approval, "s");
        ui.setStatus("Subagent running shell");
        let completed = false;
        execution = Promise.resolve(executeCommandWithResult('node -e "setTimeout(() => console.log(123), 600)"'));
        void execution.then(() => { completed = true; });
        await new Promise((resolve) => setTimeout(resolve, 120));
        assert.equal(completed, false, "Shell execution must yield to the TUI while the command is still running");
        ui.tui.renderNow();
        const firstFrame = ui.tui.getScreenLines().map(stripTerminalSequences).join("\n");
        assert.match(firstFrame, /Subagent running shell/);
        await new Promise((resolve) => setTimeout(resolve, 120));
        ui.tui.renderNow();
        const secondFrame = ui.tui.getScreenLines().map(stripTerminalSequences).join("\n");
        assert.notEqual(secondFrame, firstFrame, "Loading must animate during shell execution");
        let interrupted = false;
        ui.onInterrupt = () => { interrupted = true; };
        terminal.input?.("\x03");
        assert.equal(interrupted, true);
        assert.equal(completed, false);
        const result = await execution;
        assert.equal(result.exitCode, 0);
        assert.match(result.output, /123/);
    } finally {
        await execution;
        ui.close();
    }
});

test("renders available skill names and descriptions as a Markdown table", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "corbecode-skills-table-"));
    const previous = getSKILLS_DIR();
    try {
        setSKILLS_DIR(directory);
        assert.equal(new SkillLoader().getTable(), "Nessuna skill disponibile.");
        mkdirSync(path.join(directory, "review"));
        writeFileSync(path.join(directory, "review", "SKILL.md"), "---\nname: Reviewer\ndescription: 'Review | code'\n---\nReview.");
        const table = new SkillLoader().getTable();
        assert.match(table, /\| Nome \| Descrizione \|/);
        assert.match(table, /Reviewer/);
        assert.match(table, /Review \\\| code/);
        const rendered = renderMarkdown(table).render(80).map(stripTerminalSequences).join("\n");
        assert.match(rendered, /Reviewer/);
        assert.match(rendered, /Review \| code/);
    } finally {
        setSKILLS_DIR(previous);
        rmSync(directory, { recursive: true, force: true });
    }
});

test("loads global skills and lets workspace skills override them", () => {
    const root = mkdtempSync(path.join(tmpdir(), "corbecode-global-skills-"));
    const globalSkills = path.join(root, "global", "skills");
    const workspaceSkills = path.join(root, "workspace", ".corbecode", "skills");
    try {
        mkdirSync(path.join(globalSkills, "shared"), { recursive: true });
        mkdirSync(path.join(globalSkills, "personal"), { recursive: true });
        mkdirSync(path.join(workspaceSkills, "shared"), { recursive: true });
        writeFileSync(path.join(globalSkills, "shared", "SKILL.md"), "---\ndescription: Global skill\n---\nGlobal instructions.");
        writeFileSync(path.join(globalSkills, "personal", "SKILL.md"), "---\ndescription: Personal skill\n---\nPersonal instructions.");
        writeFileSync(path.join(workspaceSkills, "shared", "SKILL.md"), "---\ndescription: Workspace skill\n---\nWorkspace instructions.");
        const loader = new SkillLoader([globalSkills, workspaceSkills]);
        assert.match(loader.getContent("shared"), /Workspace instructions/);
        assert.match(loader.getContent("personal"), /Personal instructions/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("renders tool output as Markdown with a separate label and truncation notice", () => {
    const ui = new TerminalUi(tmpdir(), [], new TestTerminal());
    try {
        ui.writeToolOutput("**Result** with `code`", 500);
        let rendered = ui.transcript.render(80).map(stripTerminalSequences).join("\n");
        assert.match(rendered, /Output:/);
        assert.match(rendered, /Result with code/);
        assert.doesNotMatch(rendered, /\*\*Result\*\*|`code`/);
        ui.writeToolOutput("abcdef", 3);
        rendered = ui.transcript.render(80).map(stripTerminalSequences).join("\n");
        assert.match(rendered, /abc/);
        assert.doesNotMatch(rendered, /abcdef/);
        assert.match(rendered, /output troncato/);
        ui.writeToolOutput("Error: **literal**", 500, true);
        assert.match(ui.transcript.render(80).map(stripTerminalSequences).join("\n"), /Error: \*\*literal\*\*/);
        ui.writeToolOutput("abcdef", 3, false, "Subagent Planner");
        rendered = ui.transcript.render(80).map(stripTerminalSequences).join("\n");
        assert.match(rendered, /Subagent Planner output:/);
        assert.match(rendered, /Subagent Planner: \.\.\. \(output troncato\)/);
    } finally {
        ui.close();
    }
});

test("previews file writes and edits as extension-aware code without escaped JSON", () => {
    const ui = new TerminalUi(tmpdir(), [], new TestTerminal());
    try {
        const content = "import { x } from 'module';\nconst value = 1;";
        const preview = getActionPreview("write_file", { filePath: "example.ts", content });
        assert.match(preview?.markdown ?? "", /^```typescript/);
        ui.writeActionPreview("write_file", { filePath: "example.ts", content });
        ui.writeActionPreview("edit_file", { filePath: "example.py", oldText: "x = 1", newText: "x = 2" });
        const colored = ui.transcript.render(100).join("\n");
        assert.ok(colored.includes(lavender("const")));
        assert.ok(colored.includes(chalk.cyan("'module'")));
        const rendered = stripTerminalSequences(colored);
        assert.match(rendered, /example.ts/);
        assert.match(rendered, /const value = 1/);
        assert.doesNotMatch(rendered, /"content":|\\n/);
        assert.doesNotMatch(rendered, /Prima|Dopo/);
        assert.match(rendered, /-x = 1/);
        assert.match(rendered, /\+x = 2/);
        const nested = getActionPreview("write_file", { filePath: "README.md", content: "```ts\nconst x = 1;\n```" });
        assert.match(nested?.markdown ?? "", /^````markdown/);
        for (const extension of ["html", "css", "scss", "java"]) {
            const preview = getActionPreview("write_file", { filePath: `example.${extension}`, content: "sample" });
            assert.ok(preview);
            assert.ok(preview.markdown.startsWith(`\`\`\`${extension}\n`));
            assert.match(renderMarkdown(preview.markdown).render(100).map(stripTerminalSequences).join("\n"), /sample/);
        }
        assert.throws(() => getActionPreview("write_file", { content }), /filePath/);
        assert.equal(getActionPreview("shell", { command: "test" }), undefined);
    } finally {
        ui.close();
    }
});

test("previews shell approval as a readable question without JSON", () => {
    const ui = new TerminalUi(tmpdir(), [], new TestTerminal());
    try {
        const command = "cd my-app && npx tsc --noEmit 2>&1 | head -50";
        ui.writeActionPreview("shell", { command });
        const rendered = ui.transcript.render(160).map(stripTerminalSequences).join("\n");
        assert.equal(rendered.trim(), `Eseguire "${command}" ?`);
        assert.doesNotMatch(rendered, /"command":|\{|\}/);
        ui.writeActionPreview("shell", { command: 'node -e "console.log(1)"\nnode --version' });
        const multiline = ui.transcript.render(160).map(stripTerminalSequences).join("\n");
        assert.match(multiline, /node -e "console\.log\(1\)"/);
        assert.doesNotMatch(multiline, /\\n|\\"/);
    } finally {
        ui.close();
    }
});
