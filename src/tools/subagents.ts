import { generateText, isLoopFinished, type ModelMessage } from "ai";
import { api, MODEL, WORKDIR } from "../config";
import { TOOLS } from "../tools";
import chalk from "chalk";
import type { Session } from "../sessionStore";
import type { createSpinner } from "../spinner";
import { askTerminal, getApprovalDecision } from "../terminalInput";
import { selectAgentTools, type CustomAgent } from "../agents";
import { readWorkspaceInstructions } from "../workspaceInstructions";
import { writeMessage } from "../terminalUi";

const MUTATING_TOOLS = ["shell", "edit_file", "write_file"];

export const runSubagent = async (
    prompt: string,
    activeSession: Session,
    spinner: ReturnType<typeof createSpinner>,
    approveTools: (tools: string[]) => void,
    agent?: CustomAgent,
    abortSignal?: AbortSignal,
): Promise<string> => {
    const messages: ModelMessage[] = [{ role: "user", content: prompt }];
    const workspaceInstructions = await readWorkspaceInstructions(WORKDIR);
    const tools = selectAgentTools(TOOLS, agent?.tools);
    const system = [
        `You are ${agent?.name ?? "a coding subagent"} at ${WORKDIR}. 
        Complete your given task, then summarize your findings.`,
        workspaceInstructions,
        agent?.body ?? "",
    ].filter(Boolean).join("\n\n");
    const generate = () => generateText({
        model: api(MODEL),
        ...(abortSignal && { abortSignal }),
        system,
        messages,
        tools,
        stopWhen: isLoopFinished(),
        toolApproval: {
            shell: () => activeSession.approvedTools.includes("shell") ? "approved" : "user-approval",
            edit_file: () => activeSession.approvedTools.includes("edit_file") ? "approved" : "user-approval",
            write_file: () => activeSession.approvedTools.includes("write_file") ? "approved" : "user-approval",
        },
        onStepFinish: ({ providerMetadata }) => {
            const reasoningDetails = providerMetadata?.openrouter?.reasoning_details;
            if (Array.isArray(reasoningDetails) && reasoningDetails.length > 0) {
                spinner.stop();
                for (const detail of reasoningDetails) {
                    writeMessage(`${chalk.bold.cyan("Reasoning details:")} ${chalk.gray(detail.text ?? detail.summary ?? JSON.stringify(detail))}`);
                    writeMessage();
                }
                spinner.start("Subagent thinking...");
            }
        },
        onToolExecutionStart: ({ toolCall }) => {
            spinner.stop();
            writeMessage(chalk.magenta(`Subagent tool started: ${toolCall.toolName} (${toolCall.toolCallId})`));
            writeMessage(chalk.gray(`Input: ${JSON.stringify(toolCall.input).slice(0, 100)}`));
            spinner.start(`Subagent running ${toolCall.toolName}`);
        },
        onToolExecutionEnd: ({ toolCall, toolExecutionMs, toolOutput }) => {
            spinner.stop();
            const failed = toolOutput.type === "tool-error";
            const output = failed ? String(toolOutput.error) : String(toolOutput.output);
            const status = `Subagent tool ${failed ? "failed" : "completed"}: ${toolCall.toolName} (${toolExecutionMs} ms)`;
            writeMessage(failed ? chalk.red(status) : chalk.green(status));
            writeMessage(chalk.gray(`Output: ${output.slice(0, 100)}${output.length > 100 ? "..." : ""}`));
            spinner.start("Subagent thinking");
        },
    });

    let result = await generate();
    while (true) {
        const hasApprovalRequests = result.content.some(
            (part) => part.type === "tool-approval-request" && !part.isAutomatic,
        );
        if (!hasApprovalRequests) return result.text;

        messages.push(...result.responseMessages);
        const approvalResponses = [];
        for (const request of result.content) {
            if (request.type !== "tool-approval-request" || request.isAutomatic) continue;
            writeMessage(chalk.yellow(`\nAzione proposta dal subagent: ${request.toolCall.toolName}`));
            writeMessage(chalk.gray(JSON.stringify(request.toolCall.input, null, 2)));
            spinner.stop();
            const answer = await askTerminal(chalk.cyan("Eseguire? [s]ì / [n]o / [a]ccetta sempre in questo workspace per questa sessione: "));
            spinner.start("Subagent thinking");
            const decision = getApprovalDecision(answer);
            const approved = decision !== "deny";
            if (decision === "always") {
                approveTools(MUTATING_TOOLS);
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
        messages.push({ role: "tool", content: approvalResponses });
        result = await generate();
    }
};