import chalk from "chalk";
import { lavender } from "./palette";
import { highlight, supportsLanguage } from "cli-highlight";
import { getActionPreview } from "./actionPreview";
import { readdir } from "node:fs/promises";
import path from "node:path";
import {
    CombinedAutocompleteProvider, Container, Editor, Loader, Markdown, matchesKey,
    ProcessTerminal, ScrollView, SelectList, Spacer, Text, TuiAltScreen, VStack,
    stripTerminalSequences,
    truncateToWidth,
    type AutocompleteProvider, type Component, type MarkdownTheme, type SlashCommand, type Terminal, type SelectItem,
} from "@earendil-works/pi-tui";

const selectTheme = {
    selectedPrefix: chalk.cyan, selectedText: chalk.bold.cyan,
    description: chalk.gray, scrollInfo: chalk.gray, noMatch: lavender,
};
const markdownTheme: MarkdownTheme = {
    heading: chalk.bold.cyan, link: lavender, linkUrl: chalk.gray,
    code: lavender, codeBlock: chalk.white, codeBlockBorder: chalk.gray,
    quote: chalk.gray, quoteBorder: chalk.gray, hr: chalk.gray,
    listBullet: chalk.cyan, bold: chalk.bold, italic: chalk.italic,
    strikethrough: chalk.strikethrough, underline: chalk.underline,
    highlightCode: (code, language) => language && supportsLanguage(language)
        ? highlight(code, {
            language, ignoreIllegals: true,
            theme: { keyword: lavender, string: chalk.cyan, comment: chalk.gray, number: lavender, default: chalk.white },
        }).split("\n")
        : code.split("\n"),
};

export const createAutocomplete = (workspace: string, commands: SlashCommand[]): AutocompleteProvider => {
    const provider = new CombinedAutocompleteProvider(commands, workspace);
    return {
        triggerCharacters: ["/", "@"],
        applyCompletion: provider.applyCompletion.bind(provider),
        shouldTriggerFileCompletion: provider.shouldTriggerFileCompletion.bind(provider),
        async getSuggestions(lines, line, column, options) {
            const before = (lines[line] ?? "").slice(0, column);
            const match = before.match(/(?:^|\s)(@(?:"[^"]*|[^\s"]*))$/);
            if (!match) return provider.getSuggestions(lines, line, column, options);
            const prefix = match[1]!;
            const partial = prefix.slice(1).replace(/^"/, "").replaceAll("\\", "/");
            const separator = partial.lastIndexOf("/");
            const directory = partial.slice(0, separator + 1);
            const filter = partial.slice(separator + 1).toLowerCase();
            const target = path.resolve(workspace, directory);
            const relative = path.relative(workspace, target);
            if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
                throw new Error("File completion must stay inside the workspace.");
            }
            const entries = await readdir(target, { withFileTypes: true });
            if (options.signal.aborted) return null;
            const items = entries
                .filter((entry) => (entry.isFile() || entry.isDirectory()) && entry.name.toLowerCase().startsWith(filter))
                .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
                .map((entry) => {
                    const file = `${directory}${entry.name}${entry.isDirectory() ? "/" : ""}`;
                    return {
                        value: file.includes(" ") ? `@"${file}"` : `@${file}`,
                        label: `${entry.name}${entry.isDirectory() ? "/" : ""}`,
                    };
                });
            return items.length ? { prefix, items } : null;
        },
    };
};

export const renderMarkdown = (text: string) => new Markdown(text, 1, 0, markdownTheme);

const highlightedLabel = (text: string) => new Text(chalk.hex("#F8F8F2")(text), 1, 0, chalk.bgHex("#44475A"));

class ChatEditor extends Editor {
    showUserPrefix = false;

    override render(width: number): string[] {
        const lines = super.render(width);
        if (this.showUserPrefix && !this.disableSubmit && lines[1]?.startsWith("       ")) {
            lines[1] = ` ${chalk.bold.cyan("YOU > ")}${lines[1].slice(7)}`;
        }
        return lines;
    }
}

export class TerminalUi {
    readonly tui: TuiAltScreen;
    readonly editor: ChatEditor;
    readonly transcript = new Container();
    verbose = false;
    private readonly prompt = new Text("YOU >");
    private readonly status = new Container();
    private readonly selection = new Container();
    private readonly footer = new Text("", 1, 0);
    private readonly autocomplete: AutocompleteProvider;
    private readonly requests: {
        prompt: string; resolve: (answer: string) => void; reject: (error: Error) => void;
    }[] = [];
    private loader: Loader | undefined;
    private closed = false;
    private cancelSelection: (() => void) | undefined;
    onInterrupt: (() => void) | undefined;

    constructor(workspace: string, commands: SlashCommand[], terminal: Terminal = new ProcessTerminal()) {
        this.tui = new TuiAltScreen(terminal);
        const autocomplete = createAutocomplete(workspace, commands);
        this.autocomplete = {
            ...autocomplete,
            getSuggestions: async (...args) => {
                try {
                    return await autocomplete.getSuggestions(...args);
                } catch (error) {
                    this.write(chalk.red(`Autocomplete: ${error instanceof Error ? error.message : String(error)}`));
                    return null;
                }
            },
        };
        this.editor = new ChatEditor(this.tui, { borderColor: chalk.cyan, selectList: selectTheme }, { paddingX: 1, autocompleteMaxVisible: 6 });
        this.editor.disableSubmit = true;
        this.editor.setAutocompleteProvider(this.autocomplete);
        this.tui.setLayoutRoot(new VStack([
            { component: new ScrollView(this.transcript, { follow: "end", primary: true }), grow: 1, basis: 0, minSize: 1 },
            this.status,
            { component: this.prompt, visible: () => this.requests.length > 0 && !this.editor.showUserPrefix },
            { component: this.selection, visible: () => this.cancelSelection !== undefined },
            this.editor,
            this.footer,
        ]));
        this.editor.onSubmit = (answer) => {
            const request = this.requests.shift();
            if (!request) return;
            this.write(answer, "user");
            this.editor.addToHistory(answer);
            this.editor.setText("");
            this.editor.disableSubmit = true;
            request.resolve(answer);
            this.activatePrompt();
        };
        this.tui.addInputListener((data) => {
            if (!matchesKey(data, "ctrl+c")) return undefined;
            this.onInterrupt?.();
            this.cancelSelection?.();
            for (const request of this.requests.splice(0)) request.reject(new Error("Input cancelled by user."));
            this.editor.disableSubmit = true;
            this.tui.requestRender();
            return { consume: true };
        });
    }

    start(): void {
        this.tui.setFocus(this.editor);
        this.tui.start();
    }

    ask(prompt: string): Promise<string> {
        if (this.closed) return Promise.reject(new Error("Terminal UI is closed."));
        return new Promise((resolve, reject) => {
            this.requests.push({ prompt, resolve, reject });
            this.activatePrompt();
        });
    }

    private activatePrompt(): void {
        const request = this.requests[0];
        if (request && !this.cancelSelection) {
            this.editor.showUserPrefix = stripTerminalSequences(request.prompt).trim() === "YOU >";
            this.editor.setPaddingX(this.editor.showUserPrefix ? 7 : 1);
            this.prompt.setText(request.prompt);
            this.editor.disableSubmit = false;
            this.tui.setFocus(this.editor);
        }
        this.tui.requestRender();
    }

    select(title: string, items: SelectItem[], selectedIndex = 0): Promise<string | undefined> {
        if (this.closed) return Promise.reject(new Error("Terminal UI is closed."));
        if (this.cancelSelection) return Promise.reject(new Error("A selection is already open."));
        return new Promise((resolve) => {
            let visibleRows = 6;
            let list = new SelectList(items, visibleRows, selectTheme);
            list.setSelectedIndex(selectedIndex);
            const submitDisabled = this.editor.disableSubmit;
            this.editor.disableSubmit = true;
            const heading = new Text(chalk.bold.cyan(title), 1, 0);
            const headingView: Component = {
                render: (width) => {
                    const lines = heading.render(width);
                    return lines.length > 2 ? [lines[0]!, truncateToWidth(lines[1]!, Math.max(0, width - 3), "") + "..."] : lines;
                },
                invalidate: () => heading.invalidate(),
            };
            const selectionView: Component = {
                capturesViewportInput: false,
                render: (width) => {
                    const rows = Math.min(6, Math.max(1, this.tui.terminal.rows - this.editor.render(width).length
                        - this.footer.render(width).length - this.status.render(width).length - headingView.render(width).length - 2));
                    if (rows !== visibleRows) {
                        const previous = list;
                        list = new SelectList(items, rows, selectTheme);
                        list.setSelectedIndex(items.findIndex((item) => item.value === previous.getSelectedItem()?.value));
                        if (previous.onSelect) list.onSelect = previous.onSelect;
                        if (previous.onCancel) list.onCancel = previous.onCancel;
                        visibleRows = rows;
                    }
                    return list.render(width);
                },
                invalidate: () => list.invalidate(),
                handleInput: (data) => list.handleInput(data),
                handleMouse: (event) => list.handleMouse(event),
            };
            this.selection.addChild(headingView);
            this.selection.addChild(selectionView);
            const finish = (value?: string) => {
                this.selection.clear();
                this.cancelSelection = undefined;
                this.editor.disableSubmit = submitDisabled;
                this.tui.setFocus(this.editor);
                if (value !== undefined) {
                    const item = items.find((entry) => entry.value === value);
                    this.write(`${title}: ${item?.label ?? value}`);
                }
                this.activatePrompt();
                this.tui.requestRender();
                resolve(value);
            };
            this.cancelSelection = () => finish();
            list.onSelect = (item) => finish(item.value);
            list.onCancel = () => finish();
            this.tui.setFocus(selectionView);
            this.tui.requestRender();
        });
    }

    write(text = "", kind: "log" | "user" | "assistant" | "markdown" = "log"): void {
        if (kind === "assistant") {
            this.transcript.addChild(highlightedLabel("CORBE CODE"));
            this.transcript.addChild(renderMarkdown(text));
        } else if (kind === "markdown") {
            this.transcript.addChild(renderMarkdown(text));
        } else {
            this.transcript.addChild(new Text(kind === "user" ? `${chalk.bold.cyan("YOU > ")}${chalk.white(text)}` : text, 1, 0));
        }
        this.tui.requestRender();
    }

    setFooter(text: string): void {
        this.footer.setText(chalk.gray(text));
        this.tui.requestRender();
    }

    startTextStream(label: string, highlighted = false): (delta: string) => void {
        this.transcript.addChild(highlighted ? highlightedLabel(label) : new Text(label, 1, 0));
        const block = renderMarkdown("");
        this.transcript.addChild(block);
        let text = "";
        return (delta) => {
            text += delta;
            block.setText(text);
            this.tui.requestRender();
        };
    }

    writeVerbose(text: string): void {
        if (this.verbose) this.write(text);
    }

    writeHeader(title: string, hint: string): void {
        this.write(chalk.bold.cyan(title));
        this.transcript.addChild(new Spacer(1));
        this.transcript.addChild(new Text(chalk.gray(hint), 1, 0));
        this.write("---", "markdown");
        this.transcript.addChild(new Spacer(1));
        this.tui.requestRender();
    }

    writeToolOutput(output: string, limit: number, failed = false, source?: string): void {
        this.write(chalk.gray(chalk.bold(source ? `${source} output:` : "Output:")));
        this.write(failed ? chalk.red(output.slice(0, limit)) : output.slice(0, limit), failed ? "log" : "markdown");
        if (output.length > limit) this.write(chalk.gray(`${source ? `${source}: ` : ""}... (output troncato)`));
    }

    writeActionPreview(toolName: string, input: unknown): void {
        if (toolName === "shell" && typeof input === "object" && input !== null && "command" in input && typeof input.command === "string") {
            this.write(chalk.cyan(`Eseguire "${input.command}" ?`));
            return;
        }
        const preview = getActionPreview(toolName, input);
        if (preview) {
            this.write(chalk.bold.cyan(preview.filePath));
            this.write(preview.markdown, "markdown");
        } else {
            this.write(chalk.gray(JSON.stringify(input, null, 2)));
        }
    }

    setStatus(label: string): void {
        if (!this.loader) {
            this.loader = new Loader(this.tui, chalk.cyan, chalk.gray, label);
            this.status.addChild(this.loader);
        }
        this.loader.setMessage(label);
        this.loader.start();
        this.tui.requestRender();
    }

    clearStatus(): void {
        this.loader?.stop();
        this.status.clear();
        this.loader = undefined;
        this.tui.requestRender();
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.cancelSelection?.();
        for (const request of this.requests.splice(0)) request.reject(new Error("Terminal UI closed."));
        this.clearStatus();
        this.editor.disableSubmit = true;
        this.tui.stop();
    }
}

let ui: TerminalUi | undefined;

export const startTerminalUi = (workspace: string, commands: SlashCommand[]): TerminalUi => {
    if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
        throw new Error("Corbe Code requires an interactive terminal (TTY).");
    }
    ui = new TerminalUi(workspace, commands);
    try {
        ui.start();
    } catch (error) {
        ui.close();
        throw error;
    }
    return ui;
};

export const getTerminalUi = (): TerminalUi => {
    if (!ui) throw new Error("Terminal UI has not been started.");
    return ui;
};
export const writeMessage = (text = "", kind: "log" | "user" | "assistant" | "markdown" = "log"): void => getTerminalUi().write(text, kind);
export const writeVerbose = (text: string): void => getTerminalUi().writeVerbose(text);
export const startTextStream = (label: string, highlighted = false): ((delta: string) => void) => getTerminalUi().startTextStream(label, highlighted);
export const writeToolOutput = (output: string, limit: number, failed = false, source?: string): void => getTerminalUi().writeToolOutput(output, limit, failed, source);
export const writeActionPreview = (toolName: string, input: unknown): void => getTerminalUi().writeActionPreview(toolName, input);
