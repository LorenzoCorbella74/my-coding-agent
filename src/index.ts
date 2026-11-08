import chalk from "chalk";
import { lavender, orange } from "./palette";
import { withSpinner } from "./spinner";
import { streamText, isLoopFinished } from "ai";
import { consumeTextStream } from "./agentStream";
import { microCompact, estimateTokens, autoCompact } from "./compact";
import type { ModelMessage } from "ai";
import packageJson from "../package.json" with { type: "json" };
import { createParentTools, TOOLS } from "./tools";
import { askTerminal, closeTerminalInput, getApprovalDecision } from "./terminalInput";
import { WORKDIR, api, MODEL, CONTEXT_LIMIT } from "./config";
import { SessionStore } from "./sessionStore";
import { SKILLS_DESCRIPTIONS, AGENTS_DESCRIPTIONS, getSkillsTable } from "./tools";
import { readWorkspaceInstructions } from "./workspaceInstructions";
import { startTerminalUi, startTextStream, writeMessage, writeVerbose, writeToolOutput, writeActionPreview } from "./terminalUi";
import { formatToolActivity } from "./toolActivity";

const formatTokenCount = (count: number): string => String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ".");

const workspaceInstructions = await readWorkspaceInstructions(WORKDIR);
const SYSTEM_PROMPT = `
You are CORBE CODE an expert coding agent at ${WORKDIR}. 
Use tools to solve tasks.

Use the task tool to delegate exploration or subtasks with fresh context.
Choose a custom agent by setting the task tool's agent parameter to its exact name when its description matches the task.

Available custom agents:
${AGENTS_DESCRIPTIONS}

Use explore_workspace to find files without reading contents, and read_files when you need to read multiple files. 
Use searchCode to locate literal text or regex matches before reading relevant files; include only the context needed to identify the code path.

Use skill_get for specialized knowledge.

Skills: 
${SKILLS_DESCRIPTIONS}

Act, dont explain or explain briefly if task was long.

${workspaceInstructions ? `Workspace instructions from AGENTS.md:\n${workspaceInstructions}` : ""}`;

const sessionStore = new SessionStore(WORKDIR);
let activeSession = sessionStore.resumeOrCreate();
let history = activeSession.messages;
const MUTATING_TOOLS = ["shell", "edit_file", "write_file"];
let requestController: AbortController | undefined;

/** AGENT LOOP */
const agentLoop = async (messages: ModelMessage[]): Promise<string> => {

  microCompact(messages);
  const estTokens = estimateTokens(messages);
  writeMessage(orange(`${chalk.bold("Tokens usati finora:")} ${estTokens}`));
  if (estTokens > CONTEXT_LIMIT) {
    writeMessage(`compacting at ${estTokens}`);
    const compacted = await withSpinner("Compressing context", () => autoCompact(messages, requestController?.signal));
    if (messages === history) sessionStore.replace(activeSession.id, compacted);
    messages.length = 0;
    messages.push(...compacted);
    writeMessage(`new tokens, ${estimateTokens(messages)}`);
  }

  const workingMessages = [...messages];
  const generate = (inputMessages: ModelMessage[]) => withSpinner("Thinking", async (spinner) => {
    const result = streamText({
    model: api(MODEL),
    system: SYSTEM_PROMPT,
    messages: inputMessages,
    ...(requestController && { abortSignal: requestController.signal }),
    tools: createParentTools(activeSession, spinner, (tools) => {
      sessionStore.approveTools(activeSession.id, tools);
    }, requestController?.signal),
    toolApproval: {
      shell: () => activeSession.approvedTools.includes("shell") ? "approved" : "user-approval",
      edit_file: () => activeSession.approvedTools.includes("edit_file") ? "approved" : "user-approval",
      write_file: () => activeSession.approvedTools.includes("write_file") ? "approved" : "user-approval",
    },
    stopWhen: isLoopFinished(),
    onStepFinish: ({ providerMetadata }) => {
      const reasoningDetails = providerMetadata?.openrouter?.reasoning_details;
      if (Array.isArray(reasoningDetails) && reasoningDetails.length > 0) {
        spinner.stop();
        for (const detail of reasoningDetails) {
          writeMessage(`${chalk.bold.cyan("Reasoning details:")} ${chalk.gray(detail.text ?? detail.summary ?? JSON.stringify(detail))}`);
          writeMessage();
        }
        spinner.start("Thinking...");
      }
    },
    onToolExecutionStart: ({ toolCall }) => {
      spinner.stop();
      writeMessage(chalk.bold(lavender(formatToolActivity(toolCall.toolName, toolCall.input))));
      writeVerbose(lavender(`Tool started: ${toolCall.toolName} (${toolCall.toolCallId})`));
      writeVerbose(chalk.gray(`Input: ${JSON.stringify(toolCall.input).slice(0, 500)}`));
      spinner.start(`Running ${toolCall.toolName}`);
    },
    onToolExecutionEnd: ({ toolCall, toolExecutionMs, toolOutput }) => {
      spinner.stop();
      const failed = toolOutput.type === "tool-error";
      const output = failed ? String(toolOutput.error) : String(toolOutput.output);
      const status = `Tool ${failed ? "failed" : "completed"}: ${toolCall.toolName} (${toolExecutionMs} ms)`;
      if (failed) writeMessage(chalk.red(status));
      else writeVerbose(lavender(status));
      writeToolOutput(output, 500, failed);
      spinner.start("Thinking");
    },
    });

    let appendDelta: (delta: string) => void = () => undefined;
    await consumeTextStream(result.fullStream, {
      onTextStart: () => {
        spinner.stop();
        appendDelta = startTextStream(chalk.bold.cyan("CORBE CODE"));
      },
      onTextDelta: (delta) => appendDelta(delta),
    });
    return {
      text: await result.text,
      content: await result.content,
      usage: await result.usage,
      responseMessages: await result.responseMessages,
    };
  });

  let result = await generate(workingMessages);
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  while (true) {
    inputTokens += result.usage.inputTokens ?? 0;
    outputTokens += result.usage.outputTokens ?? 0;
    totalTokens += result.usage.totalTokens ?? 0;

    const hasApprovalRequests = result.content.some(
      (part) => part.type === "tool-approval-request" && !part.isAutomatic,
    );
    if (!hasApprovalRequests) break;

    workingMessages.push(...result.responseMessages);
    const approvalResponses = [];
    for (const request of result.content) {
      if (request.type !== "tool-approval-request" || request.isAutomatic) continue;
      writeMessage(lavender(`\nAzione proposta: ${request.toolCall.toolName}`));
      writeActionPreview(request.toolCall.toolName, request.toolCall.input);
      const answer = await askTerminal(chalk.cyan("Eseguire? [s]ì / [n]o / [a]ccetta sempre in questo workspace per questa sessione: "));
      const decision = getApprovalDecision(answer);
      const approved = decision !== "deny";
      if (decision === "always") {
        sessionStore.approveTools(activeSession.id, MUTATING_TOOLS);
        activeSession.approvedTools = MUTATING_TOOLS;
      }
      if (!approved) writeMessage(lavender("Azione rifiutata."));
      approvalResponses.push({
        type: "tool-approval-response" as const,
        approvalId: request.approvalId,
        approved,
        reason: approved ? "Approvato dall'utente." : "Rifiutato dall'utente.",
      });
    }
    workingMessages.push({ role: "tool", content: approvalResponses });
    result = await generate(workingMessages);
  }

  writeMessage(orange(`${chalk.bold("Usage:")} ${chalk.bold("Input:")} ${formatTokenCount(inputTokens)} - ${chalk.bold("Output:")} ${formatTokenCount(outputTokens)} - ${chalk.bold("Total:")} ${formatTokenCount(totalTokens)}`));
  return result.text;
};

/** INTERFACE */
type SlashCommandHandler = (args: string) => Promise<boolean>;

const exitChat: SlashCommandHandler = async () => {
  writeMessage(chalk.gray("Exiting chat..."));
  closeTerminalInput();
  return true;
};

const slashCommands: Record<string, SlashCommandHandler> = {
  "/verbose": async () => {
    ui.verbose = !ui.verbose;
    writeMessage(chalk.cyan(`Verbose: ${ui.verbose ? "ON" : "OFF"}`));
    return false;
  },
  "/quit": exitChat,
  "/exit": exitChat,
  "/new": async () => {
    activeSession = sessionStore.create();
    history = activeSession.messages;
    updateFooter();
    writeMessage(chalk.cyan(`Started session ${activeSession.id.slice(0, 8)}.`));
    return false;
  },
  "/sessions": async () => {
    const sessions = sessionStore.list();
    if (sessions.length === 0) {
      writeMessage(lavender("No sessions found."));
      return false;
    }
    const selected = await ui.select("Seleziona una sessione", sessions.map((session) => ({
      value: session.id,
      label: `${session.id.slice(0, 8)} ${session.title || session.preview}${session.id === activeSession.id ? " (corrente)" : ""}`,
      description: `${new Date(session.updatedAt).toLocaleString()} | ${session.messageCount} messaggi`,
    })), sessions.findIndex((session) => session.id === activeSession.id));
    if (selected) {
      activeSession = sessionStore.restore(selected);
      history = activeSession.messages;
      updateFooter();
      writeMessage(chalk.cyan(`Restored session ${activeSession.id.slice(0, 8)}.`));
    }
    return false;
  },
  "/skills": async () => {
    writeMessage(getSkillsTable(), "markdown");
    return false;
  },
  "/restore": async (idPrefix) => {
    if (!idPrefix) {
      writeMessage(lavender("Usage: /restore <sessionId>"));
      return false;
    }
    try {
      activeSession = sessionStore.restore(idPrefix);
      history = activeSession.messages;
      updateFooter();
      writeMessage(chalk.cyan(`Restored session ${activeSession.id.slice(0, 8)}.`));
    } catch (error) {
      writeMessage(chalk.red(error instanceof Error ? error.message : String(error)));
    }
    return false;
  },
  "/compress": async () => {
    if (history.length === 0) {
      writeMessage(lavender("Nothing to compress."));
      return false;
    }

    try {
      requestController = new AbortController();
      const compacted = await withSpinner("Compressing context", () => autoCompact(history, requestController?.signal));
      sessionStore.replace(activeSession.id, compacted);
      history.splice(0, history.length, ...compacted);
      writeMessage(chalk.cyan("Conversation compressed."));
    } catch (error) {
      writeMessage(chalk.red(error instanceof Error ? error.message : String(error)));
    } finally {
      requestController = undefined;
    }
    return false;
  },
};

const chat = async (): Promise<void> => {
  while (true) {
    let query: string;
    try {
      query = await askTerminal(chalk.cyan("YOU > "));
    } catch (error) {
      writeMessage(chalk.red(error instanceof Error ? error.message : String(error)));
      closeTerminalInput();
      process.exitCode = 130;
      return;
    }

    if (["exit", "quit"].includes(query.trim().toLowerCase())) {
      await exitChat("");
      return;
    }

    if (query.trim().startsWith("/")) {
      const [command = "", ...args] = query.trim().split(/\s+/);
      const handler = slashCommands[command.toLowerCase()];
      try {
        if (!handler) {
          writeMessage(lavender(`Unknown command: ${command}`));
        } else if (await handler(args.join(" "))) {
          return;
        }
      } catch (error) {
        writeMessage(chalk.red(error instanceof Error ? error.message : String(error)));
      }
      writeMessage();
      continue;
    }

    const userMessage: ModelMessage = { role: "user", content: query };
    history.push(userMessage);
    try {
      requestController = new AbortController();
      sessionStore.append(activeSession.id, userMessage);
      const reply = await agentLoop(history);
      const assistantMessage: ModelMessage = { role: "assistant", content: reply };
      history.push(assistantMessage);
      sessionStore.append(activeSession.id, assistantMessage);
    } catch (error) {
      writeMessage(chalk.red(error instanceof Error ? error.message : String(error)));
    } finally {
      requestController = undefined;
    }
    writeMessage();
  }
};

const ui = startTerminalUi(WORKDIR, Object.keys(slashCommands).map((command) => ({
  name: command.slice(1),
  description: {
    "/new": "Start a new session", "/sessions": "List sessions", "/restore": "Restore a session",
    "/compress": "Compress the conversation", "/quit": "Quit", "/exit": "Quit",
    "/skills": "List available skills",
    "/verbose": "Toggle tool execution details",
  }[command] ?? "",
})));
ui.onInterrupt = () => requestController?.abort();
ui.writeHeader([
  "  ____ ___  ____  ____  _____    ____ ___  ____  _____",
  " / ___/ _ \\|  _ \\| __ )| ____|  / ___/ _ \\|  _ \\| ____|",
  "| |  | | | | |_) |  _ \\|  _|   | |  | | | | | | |  _|",
  "| |__| |_| |  _ <| |_) | |___  | |__| |_| | |_| | |___",
  " \\____\\___/|_| \\_\\____/|_____|  \\____\\___/|____/|_____|",
].join("\n"), "Enter: invia·Alt+Enter: nuova riga·/: comandi·@: file·PgUp/PgDn: cronologia·Ctrl+C: annulla/esci");
const updateFooter = () => ui.setFooter(`Version ${packageJson.version} | Model: ${MODEL} | Session ${activeSession.id.slice(0, 8)}`);
updateFooter();
try {
  await chat();
} finally {
  closeTerminalInput();
}