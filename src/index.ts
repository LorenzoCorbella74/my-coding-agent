import chalk from "chalk";
import { lavender, orange } from "./UI/palette";
import { withSpinner } from "./UI/spinner";
import { streamText, isLoopFinished } from "ai";
import { consumeTextStream } from "./agentStream";
import { microCompact, estimateTokens, autoCompact } from "./features/compact";
import type { ModelMessage } from "ai";
import packageJson from "../package.json" with { type: "json" };
import { createParentTools } from "./tools/tools-definitions";
import { askTerminal, closeTerminalInput, getApprovalDecision } from "./UI/terminalInput";
import { GLOBAL_DATA_DIR, WORKDIR } from "./config";
import { modelSettings } from "./slash/providers-models";
import { createSlashCommands, SLASH_COMMANDS, type ChatState } from "./slash";
import { SessionStore } from "./features/sessionStore";
import { SKILLS_DESCRIPTIONS, AGENTS_DESCRIPTIONS } from "./tools/tools-definitions";
import { readWorkspaceInstructions } from "./features/workspaceInstructions";
import { startTerminalUi, startTextStream, writeMessage, writeVerbose, writeToolOutput, writeActionPreview } from "./UI/terminalUi";
import { FlowStore } from "./slash/flowStore";
import { flowChatContext } from "./slash/flow";
import { formatToolActivity } from "./UI/toolActivity";
import { memoryStore } from "./features/memory";

const formatTokenCount = (count: number): string => String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ".");

const workspaceInstructions = await readWorkspaceInstructions(WORKDIR);
const SYSTEM_PROMPT = `
You are CORBE CODE an expert coding agent at ${WORKDIR}. 
Use tools to solve tasks.

Use the task tool to delegate exploration or subtasks with fresh context.
Choose a custom agent by setting the task tool's agent parameter to its exact name when its description matches the task.

Available default and custom agents:
${AGENTS_DESCRIPTIONS}

Use explore_workspace to find files without reading contents, and read_files when you need to read multiple files. 
Use searchCode to locate literal text or regex matches before reading relevant files; include only the context needed to identify the code path.

Use skill_get for specialized knowledge.

Skills: 
${SKILLS_DESCRIPTIONS}

Act, dont explain or explain briefly if task was long.

${workspaceInstructions ? `Workspace instructions from AGENTS.md:\n${workspaceInstructions}` : ""}`;

const sessionStore = new SessionStore(WORKDIR, GLOBAL_DATA_DIR);
const flowStore = new FlowStore(WORKDIR);
const recoveredFlow = flowStore.recover();
const state: ChatState = {
  session: sessionStore.resumeOrCreate(),
  requestController: undefined,
  lastTurnUsage: "",
};
const MUTATING_TOOLS = ["shell", "edit_file", "write_file"];

/** AGENT LOOP */
const agentLoop = async (messages: ModelMessage[]): Promise<string> => {

  const modelRequest = modelSettings.request();
  microCompact(messages);
  const estTokens = estimateTokens(messages);
  writeMessage(orange(`${chalk.bold("Tokens usati finora:")} ${estTokens}`));
  if (estTokens > modelSettings.contextLimit()) {
    writeMessage(`compacting at ${estTokens}`);
    const compacted = await withSpinner("Compressing context", () => autoCompact(messages, state.requestController?.signal));
    if (messages === state.session.messages) sessionStore.replace(state.session.id, compacted);
    messages.length = 0;
    messages.push(...compacted);
    writeMessage(`new tokens, ${estimateTokens(messages)}`);
  }

  const workingMessages = [...messages];
  const generate = (inputMessages: ModelMessage[]) => withSpinner("Thinking", async (spinner) => {
    const result = streamText({
      ...modelRequest,
      system: `${SYSTEM_PROMPT}\n\n${memoryStore.context()}\n\n${flowChatContext(flowStore.current())}`,
      messages: inputMessages,
      ...(state.requestController && { abortSignal: state.requestController.signal }),
      tools: createParentTools(state.session, spinner, (tools) => {
        sessionStore.approveTools(state.session.id, tools);
      }, state.requestController?.signal, Boolean(flowStore.current())),
      toolApproval: {
        shell: () => state.session.approvedTools.includes("shell") ? "approved" : "user-approval",
        edit_file: () => state.session.approvedTools.includes("edit_file") ? "approved" : "user-approval",
        write_file: () => state.session.approvedTools.includes("write_file") ? "approved" : "user-approval",
      },
      stopWhen: isLoopFinished(),
      onToolExecutionStart: ({ toolCall }) => {
        spinner.stop();
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
    let appendReasoning: (delta: string) => void = () => undefined;
    await consumeTextStream(result.fullStream, {
      onReasoningStart: () => {
        spinner.stop();
        appendReasoning = startTextStream(chalk.gray("Reasoning"));
      },
      onReasoningDelta: (delta) => appendReasoning(delta),
      onReasoningEnd: () => spinner.start("Thinking"),
      onTextStart: () => {
        spinner.stop();
        appendDelta = startTextStream("CORBE CODE", true);
      },
      onTextDelta: (delta) => appendDelta(delta),
      onToolCall: (toolName, input) => writeMessage(chalk.bold(lavender(formatToolActivity(toolName, input)))),
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
      const isShell = request.toolCall.toolName === "shell";
      if (!isShell) writeMessage(lavender(`\nAzione proposta: ${request.toolCall.toolName}`));
      writeActionPreview(request.toolCall.toolName, request.toolCall.input);
      const answer = await askTerminal(chalk.cyan(`${isShell ? "" : "Eseguire? "}[s]ì / [n]o / [a]ccetta sempre in questo workspace per questa sessione: `));
      const decision = getApprovalDecision(answer);
      const approved = decision !== "deny";
      if (decision === "always") {
        sessionStore.approveTools(state.session.id, MUTATING_TOOLS);
        state.session.approvedTools = MUTATING_TOOLS;
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

  state.lastTurnUsage = `Input: ${formatTokenCount(inputTokens)} | Output: ${formatTokenCount(outputTokens)} | Total: ${formatTokenCount(totalTokens)}`;
  updateFooter();
  return result.text;
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

    const handled = await slashCommands.execute(query);
    if (handled !== undefined) {
      if (handled) return;
      continue;
    }

    const userMessage: ModelMessage = { role: "user", content: query };
    state.session.messages.push(userMessage);
    const discussionFlow = flowStore.current();
    try {
      state.requestController = new AbortController();
      sessionStore.append(state.session.id, userMessage);
      if (discussionFlow) {
        discussionFlow.discussions.push({ role: "user", text: query });
        flowStore.save(discussionFlow, "User discussion; official plan unchanged.");
      }
      const reply = await agentLoop(state.session.messages);
      const assistantMessage: ModelMessage = { role: "assistant", content: reply };
      state.session.messages.push(assistantMessage);
      sessionStore.append(state.session.id, assistantMessage);
      if (discussionFlow) {
        discussionFlow.discussions.push({ role: "assistant", text: reply });
        flowStore.save(discussionFlow);
      }
    } catch (error) {
      writeMessage(chalk.red(error instanceof Error ? error.message : String(error)));
    } finally {
      state.requestController = undefined;
    }
    writeMessage();
  }
};

const startupModel = modelSettings.current();
if (startupModel) modelSettings.provider(startupModel.provider);
const ui = startTerminalUi(WORKDIR, SLASH_COMMANDS);
ui.onInterrupt = () => state.requestController?.abort();
ui.writeHeader([
  "  ____ ___  ____  ____  _____    ____ ___  ____  _____",
  " / ___/ _ \\|  _ \\| __ )| ____|  / ___/ _ \\|  _ \\| ____|",
  "| |  | | | | |_) |  _ \\|  _|   | |  | | | | | | |  _|",
  "| |__| |_| |  _ <| |_) | |___  | |__| |_| | |_| | |___",
  " \\____\\___/|_| \\_\\____/|_____|  \\____\\___/|____/|_____|",
].join("\n"), "Enter: invia | Alt+Enter: nuova riga | Alt+M: modello | Alt+R: reasoning | /: comandi | @: file | PgUp/PgDn: cronologia | Ctrl+C: annulla/esci");
const updateFooter = () => {
  const flow = flowStore.current();
  const current = modelSettings.current();
  const model = current ? `${modelSettings.provider(current.provider).name} / ${current.model} | Reasoning: ${current.control ? current.reasoning : "N/A"}` : "nessuno (/login, /models)";
  ui.setFooter(`Version ${packageJson.version} | Model: ${model} | Session ${state.session.id.slice(0, 8)}${flow ? ` | Flow ${flow.id.slice(0, 8)} ${flow.phase}` : ""}`, state.lastTurnUsage);
};
const slashCommands = createSlashCommands({ ui, settings: modelSettings, sessionStore, flowStore, state, updateFooter });
updateFooter();
if (!startupModel) writeMessage("Configura un provider con /login, poi scegli il modello con /models.");
const modelOverrides = modelSettings.environmentOverrides();
if (modelOverrides.length) writeMessage(`Override modello da ambiente: ${modelOverrides.join(", ")}. Rimuovili per usare la selezione globale salvata.`);
if (recoveredFlow) writeMessage(`Change corrente ripresa: ${recoveredFlow.id.slice(0, 8)} ${recoveredFlow.title} (${recoveredFlow.phase}). Nessuna esecuzione automatica. /flow:resume per i dettagli, /flow:apply per continuare, /flow:pause per la chat libera.`);
try {
  await chat();
} finally {
  closeTerminalInput();
}