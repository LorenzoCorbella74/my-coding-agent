import chalk from "chalk";
import { withSpinner } from "./spinner";
import { generateText, isLoopFinished } from "ai";
import { microCompact, estimateTokens, autoCompact } from "./compact";
import type { ModelMessage } from "ai";
import packageJson from "../package.json" with { type: "json" };
import { createParentTools, TOOLS } from "./tools";
import { askTerminal, closeTerminalInput, getApprovalDecision } from "./terminalInput";
import { WORKDIR, api, MODEL, CONTEXT_LIMIT } from "./config";
import { SessionStore } from "./sessionStore";
import { SKILLS_DESCRIPTIONS, AGENTS_DESCRIPTIONS, getSkillsTable } from "./tools";
import { readWorkspaceInstructions } from "./workspaceInstructions";
import { startTerminalUi, writeMessage } from "./terminalUi";

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
  writeMessage(chalk.yellow(`Tokens usati finora, ${estTokens}`));
  if (estTokens > CONTEXT_LIMIT) {
    writeMessage(`compacting at ${estTokens}`);
    const compacted = await withSpinner("Compressing context", () => autoCompact(messages, requestController?.signal));
    if (messages === history) sessionStore.replace(activeSession.id, compacted);
    messages.length = 0;
    messages.push(...compacted);
    writeMessage(`new tokens, ${estimateTokens(messages)}`);
  }

  const workingMessages = [...messages];
  const generate = (inputMessages: ModelMessage[]) => withSpinner("Thinking", async (spinner) => generateText({
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
      writeMessage(chalk.magenta(`Tool started: ${toolCall.toolName} (${toolCall.toolCallId})`));
      writeMessage(chalk.gray(`Input: ${JSON.stringify(toolCall.input).slice(0, 500)}`));
      spinner.start(`Running ${toolCall.toolName}`);
    },
    onToolExecutionEnd: ({ toolCall, toolExecutionMs, toolOutput }) => {
      spinner.stop();
      const failed = toolOutput.type === "tool-error";
      const output = failed ? String(toolOutput.error) : String(toolOutput.output);
      const status = `Tool ${failed ? "failed" : "completed"}: ${toolCall.toolName} (${toolExecutionMs} ms)`;
      writeMessage(failed ? chalk.red(status) : chalk.green(status));
      writeMessage(chalk.gray(`Output: ${output.slice(0, 500)}${output.length > 500 ? "..." : ""}`));
      spinner.start("Thinking");
    },
  }));

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
      writeMessage(chalk.yellow(`\nAzione proposta: ${request.toolCall.toolName}`));
      writeMessage(chalk.gray(JSON.stringify(request.toolCall.input, null, 2)));
      const answer = await askTerminal(chalk.cyan("Eseguire? [s]ì / [n]o / [a]ccetta sempre in questo workspace per questa sessione: "));
      const decision = getApprovalDecision(answer);
      const approved = decision !== "deny";
      if (decision === "always") {
        sessionStore.approveTools(activeSession.id, MUTATING_TOOLS);
        activeSession.approvedTools = MUTATING_TOOLS;
      }
      if (!approved) writeMessage(chalk.yellow("Azione rifiutata."));
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

  writeMessage(chalk.yellow(`Usage: Input: ${inputTokens} - Output: ${outputTokens} - Total: ${totalTokens}`));
  return result.text;
};

/** INTERFACE */
type SlashCommandHandler = (args: string) => Promise<boolean>;

const exitChat: SlashCommandHandler = async () => {
  writeMessage(chalk.red("Exiting chat..."));
  closeTerminalInput();
  return true;
};

const slashCommands: Record<string, SlashCommandHandler> = {
  "/quit": exitChat,
  "/exit": exitChat,
  "/new": async () => {
    activeSession = sessionStore.create();
    history = activeSession.messages;
    updateFooter();
    writeMessage(chalk.green(`Started session ${activeSession.id.slice(0, 8)}.`));
    return false;
  },
  "/sessions": async () => {
    const sessions = sessionStore.list();
    if (sessions.length === 0) {
      writeMessage(chalk.yellow("No sessions found."));
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
      writeMessage(chalk.green(`Restored session ${activeSession.id.slice(0, 8)}.`));
    }
    return false;
  },
  "/skills": async () => {
    writeMessage(getSkillsTable(), "markdown");
    return false;
  },
  "/restore": async (idPrefix) => {
    if (!idPrefix) {
      writeMessage(chalk.yellow("Usage: /restore <sessionId>"));
      return false;
    }
    try {
      activeSession = sessionStore.restore(idPrefix);
      history = activeSession.messages;
      updateFooter();
      writeMessage(chalk.green(`Restored session ${activeSession.id.slice(0, 8)}.`));
    } catch (error) {
      writeMessage(chalk.red(error instanceof Error ? error.message : String(error)));
    }
    return false;
  },
  "/compress": async () => {
    if (history.length === 0) {
      writeMessage(chalk.yellow("Nothing to compress."));
      return false;
    }

    try {
      requestController = new AbortController();
      const compacted = await withSpinner("Compressing context", () => autoCompact(history, requestController?.signal));
      sessionStore.replace(activeSession.id, compacted);
      history.splice(0, history.length, ...compacted);
      writeMessage(chalk.green("Conversation compressed."));
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
          writeMessage(chalk.yellow(`Unknown command: ${command}`));
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
      if (reply) writeMessage(reply, "assistant");
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
  }[command] ?? "",
})));
ui.onInterrupt = () => requestController?.abort();
writeMessage(chalk.bold.cyan([
  "  ____ ___  ____  ____  _____    ____ ___  ____  _____",
  " / ___/ _ \\|  _ \\| __ )| ____|  / ___/ _ \\|  _ \\| ____|",
  "| |  | | | | |_) |  _ \\|  _|   | |  | | | | | | |  _|",
  "| |__| |_| |  _ <| |_) | |___  | |__| |_| | |_| | |___",
  " \\____\\___/|_| \\_\\____/|_____|  \\____\\___/|____/|_____|",
].join("\n")));
const updateFooter = () => ui.setFooter(`Version ${packageJson.version} | LLM ${MODEL} | Session ${activeSession.id.slice(0, 8)}`);
updateFooter();
writeMessage(chalk.gray("Enter: invia | Alt+Enter: nuova riga | /: comandi | @: file | PgUp/PgDn: cronologia | Ctrl+C: annulla/esci"));
try {
  await chat();
} finally {
  closeTerminalInput();
}