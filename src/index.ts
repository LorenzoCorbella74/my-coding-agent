import chalk from "chalk";
import { withSpinner } from "./spinner";
import { generateText, isLoopFinished } from "ai";
import { microCompact, estimateTokens, autoCompact } from "./compact";
import type { ModelMessage } from "ai";
import packageJson from "../package.json" with { type: "json" };
import { TOOLS } from "./tools";
import { askTerminal, closeTerminalInput } from "./terminalInput";
import { WORKDIR, api, MODEL, CONTEXT_LIMIT } from "./config";
import { SessionStore } from "./sessionStore";

const SYSTEM_PROMPT = `
You are an expert coding agent at ${WORKDIR}. 
Use explore_workspace to find files without reading contents, and read_files when you need to read multiple files. 
Use searchCode to locate literal text or regex matches before reading relevant files; include only the context needed to identify the code path.
Use ask_user_input only if a missing fact or material choice blocks a correct implementation and cannot be discovered from the workspace. Do not ask about routine or reversible choices; make a sensible default and proceed. Ask one focused question, with options and a valid default when useful. If interactive input is unavailable, state the blocker and do not retry the prompt.
Use tools to solve tasks. Act, dont explain.`;

const sessionStore = new SessionStore(WORKDIR);
let activeSession = sessionStore.resumeOrCreate();
let history = activeSession.messages;

/** AGENT LOOP */
const agentLoop = async (messages: ModelMessage[]): Promise<string> => {

  microCompact(messages);
  const estTokens = estimateTokens(messages);
  console.log(` tokens, ${estTokens}`);
  if (estTokens > CONTEXT_LIMIT) {
    console.log(`compacting at ${estTokens}`);
    const compacted = await withSpinner("Compressing context", () => autoCompact(messages));
    if (messages === history) sessionStore.replace(activeSession.id, compacted);
    messages.length = 0;
    messages.push(...compacted);
    console.log(`new tokens, ${estimateTokens(messages)}`);
  }

  const { text, usage } = await withSpinner("Thinking", async (spinner) => generateText({
    model: api(MODEL),
    system: SYSTEM_PROMPT,
    messages,
    tools: TOOLS,
    stopWhen: isLoopFinished(),
    onToolExecutionStart: ({ toolCall }) => {
      spinner.stop();
      console.log(chalk.magenta(`Tool started: ${toolCall.toolName} (${toolCall.toolCallId})`));
      console.log(chalk.gray(`Input: ${JSON.stringify(toolCall.input).slice(0, 500)}`));
      spinner.start(`Running ${toolCall.toolName}`);
    },
    onToolExecutionEnd: ({ toolCall, toolExecutionMs, toolOutput }) => {
      spinner.stop();
      const failed = toolOutput.type === "tool-error";
      const output = failed ? String(toolOutput.error) : String(toolOutput.output);
      const status = `Tool ${failed ? "failed" : "completed"}: ${toolCall.toolName} (${toolExecutionMs} ms)`;
      console.log(failed ? chalk.red(status) : chalk.green(status));
      console.log(chalk.gray(`Output: ${output.slice(0, 500)}${output.length > 500 ? "..." : ""}`));
      spinner.start("Thinking");
    },
  }));
  console.log(chalk.yellow(`Usage:\nInput: ${usage.inputTokens} - Output: ${usage.outputTokens} - Total: ${usage.totalTokens}`));
  return text;
};

/** INTERFACE */
type SlashCommandHandler = (args: string) => Promise<boolean>;

const exitChat: SlashCommandHandler = async () => {
  console.log(chalk.red("Exiting chat..."));
  closeTerminalInput();
  return true;
};

const slashCommands: Record<string, SlashCommandHandler> = {
  "/quit": exitChat,
  "/exit": exitChat,
  "/new": async () => {
    activeSession = sessionStore.create();
    history = activeSession.messages;
    console.log(chalk.green(`Started session ${activeSession.id.slice(0, 8)}.`));
    return false;
  },
  "/sessions": async () => {
    const sessions = sessionStore.list();
    if (sessions.length === 0) {
      console.log(chalk.yellow("No sessions found."));
      return false;
    }
    for (const session of sessions) {
      const current = session.id === activeSession.id ? chalk.cyan(" (current)") : "";
      const updatedAt = new Date(session.updatedAt).toLocaleString();
      console.log(`${chalk.bold(session.id.slice(0, 8))}${current}  ${updatedAt}  ${session.messageCount} messages  ${session.preview}`);
    }
    return false;
  },
  "/restore": async (idPrefix) => {
    if (!idPrefix) {
      console.log(chalk.yellow("Usage: /restore <sessionId>"));
      return false;
    }
    try {
      activeSession = sessionStore.restore(idPrefix);
      history = activeSession.messages;
      console.log(chalk.green(`Restored session ${activeSession.id.slice(0, 8)}.`));
    } catch (error) {
      console.log(chalk.red(error instanceof Error ? error.message : String(error)));
    }
    return false;
  },
  "/compress": async () => {
    if (history.length === 0) {
      console.log(chalk.yellow("Nothing to compress."));
      return false;
    }

    try {
      const compacted = await withSpinner("Compressing context", () => autoCompact(history));
      sessionStore.replace(activeSession.id, compacted);
      history.splice(0, history.length, ...compacted);
      console.log(chalk.green("Conversation compressed."));
    } catch (error) {
      console.log(chalk.red(error instanceof Error ? error.message : String(error)));
    }
    return false;
  },
};

const chat = async (): Promise<void> => {
  while (true) {
    let query: string;
    try {
      query = await askTerminal(chalk.cyan(" input >> "));
    } catch (error) {
      console.log(chalk.red(error instanceof Error ? error.message : String(error)));
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
          console.log(chalk.yellow(`Unknown command: ${command}`));
        } else if (await handler(args.join(" "))) {
          return;
        }
      } catch (error) {
        console.log(chalk.red(error instanceof Error ? error.message : String(error)));
      }
      console.log();
      continue;
    }

    const userMessage: ModelMessage = { role: "user", content: query };
    history.push(userMessage);
    try {
      sessionStore.append(activeSession.id, userMessage);
      const reply = await agentLoop(history);
      const assistantMessage: ModelMessage = { role: "assistant", content: reply };
      history.push(assistantMessage);
      sessionStore.append(activeSession.id, assistantMessage);
      if (reply) console.log(chalk.green(reply));
    } catch (error) {
      console.log(chalk.red(error instanceof Error ? error.message : String(error)));
    }
    console.log();
  }
};

console.log(chalk.gray("  ----------------------------------------"));
console.log(chalk.bold.cyan("  CorbeAgent"));
console.log(chalk.gray("  ----------------------------------------"));
console.log(`${chalk.gray("  Version")}  ${chalk.white(packageJson.version)}`);
console.log(`${chalk.gray("  LLM")}      ${chalk.white(MODEL)}`);
console.log(`${chalk.gray("  Session")}  ${chalk.white(activeSession.id.slice(0, 8))}`);
console.log(chalk.gray("  ----------------------------------------"));
console.log();
void chat();