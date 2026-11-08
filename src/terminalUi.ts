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
    type AutocompleteProvider, type MarkdownTheme, type SlashCommand, type Terminal, type SelectItem,
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
        if (request) {
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
            const list = new SelectList(items, 8, selectTheme);
            list.setSelectedIndex(selectedIndex);
            const panel = new Container();
            panel.addChild(new Text(chalk.bold.cyan(title), 1, 0));
            panel.addChild(list);
            panel.addChild(new Text(chalk.gray("Frecce: seleziona | Invio: conferma | Esc: annulla"), 1, 0));
            const overlay = this.tui.showOverlay(panel, { width: "90%", maxHeight: "80%", anchor: "center" });
            this.tui.setFocus(list);
            const finish = (value?: string) => {
                overlay.hide();
                this.cancelSelection = undefined;
                this.tui.setFocus(this.editor);
                this.tui.requestRender();
                resolve(value);
            };
            this.cancelSelection = () => finish();
            list.onSelect = (item) => finish(item.value);
            list.onCancel = () => finish();
        });
    }

    write(text = "", kind: "log" | "user" | "assistant" | "markdown" = "log"): void {
        if (kind === "assistant") {
            this.transcript.addChild(new Text(chalk.bold.cyan("CORBE CODE"), 1, 0));
            this.transcript.addChild(renderMarkdown(text));
        } else if (kind === "markdown") {
            this.transcript.addChild(renderMarkdown(text));
        } else {
            this.transcript.addChild(new Text(kind === "user" ? chalk.bold.cyan(`YOU > ${text}`) : text, 1, 0));
        }
        this.tui.requestRender();
    }

    setFooter(text: string): void {
        this.footer.setText(chalk.gray(text));
        this.tui.requestRender();
    }

    startTextStream(label: string): (delta: string) => void {
        this.transcript.addChild(new Text(label, 1, 0));
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
        this.transcript.addChild(new Text(chalk.hex("#F8F8F2")(hint), 1, 0, chalk.bgHex("#44475A")));
        this.write("---", "markdown");
        this.transcript.addChild(new Spacer(1));
        this.tui.requestRender();
    }

    writeToolOutput(output: string, limit: number, failed = false): void {
        this.write(chalk.gray(chalk.bold("Output:")));
        this.write(failed ? chalk.red(output.slice(0, limit)) : output.slice(0, limit), failed ? "log" : "markdown");
        if (output.length > limit) this.write(chalk.gray("... (output troncato)"));
    }

    writeActionPreview(toolName: string, input: unknown): void {
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
export const startTextStream = (label: string): ((delta: string) => void) => getTerminalUi().startTextStream(label);
export const writeToolOutput = (output: string, limit: number, failed = false): void => getTerminalUi().writeToolOutput(output, limit, failed);
export const writeActionPreview = (toolName: string, input: unknown): void => getTerminalUi().writeActionPreview(toolName, input);
