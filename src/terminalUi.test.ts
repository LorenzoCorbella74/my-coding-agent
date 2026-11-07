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
    override moveBy(): void {}
    override hideCursor(): void {}
    override showCursor(): void {}
    override clearLine(): void {}
    override clearFromCursor(): void {}
    override clearScreen(): void {}
    override setProgress(): void {}
    override restoreOnExit(): void {}
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

test("spaces the header and separates hints from conversation messages", () => {
    const ui = new TerminalUi(tmpdir(), [], new TestTerminal());
    try {
        ui.writeHeader("CORBE CODE", "Enter: invia");
        ui.write("first message");
        const lines = ui.transcript.render(80).map(stripTerminalSequences).map((line) => line.trim());
        assert.equal(lines[0], "CORBE CODE");
        assert.equal(lines[1], "");
        assert.equal(lines[2], "Enter: invia");
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
        const selected = ui.select("Sessions", items);
        terminal.input?.("\x1b[B");
        terminal.input?.("\r");
        assert.equal(await selected, "second");
        assert.equal(ui.tui.hasOverlay(), false);
        const cancelled = ui.select("Sessions", items);
        terminal.input?.("\x1b");
        assert.equal(await cancelled, undefined);
        const closed = ui.select("Sessions", items);
        ui.close();
        assert.equal(await closed, undefined);
    } finally {
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
