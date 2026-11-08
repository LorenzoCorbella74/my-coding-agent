import { streamText, isLoopFinished, type ModelMessage } from "ai";
import { consumeTextStream } from "../agentStream";
import { api, MODEL, WORKDIR } from "../config";
import { TOOLS } from "../tools";
import chalk from "chalk";
import { lavender } from "../palette";
import type { Session } from "../sessionStore";
import type { createSpinner } from "../spinner";
import { askTerminal, getApprovalDecision } from "../terminalInput";
import { selectAgentTools, type CustomAgent } from "../agents";
import { readWorkspaceInstructions } from "../workspaceInstructions";
import { writeMessage, writeVerbose, writeToolOutput, writeActionPreview, startTextStream } from "../terminalUi";
import { formatToolActivity } from "../toolActivity";

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
    const generate = async () => {
        const result = streamText({
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
                writeMessage(chalk.bold.gray(`  ↳ ${formatToolActivity(toolCall.toolName, toolCall.input)}`));
                writeVerbose(lavender(`Subagent tool started: ${toolCall.toolName} (${toolCall.toolCallId})`));
                writeVerbose(chalk.gray(`Input: ${JSON.stringify(toolCall.input).slice(0, 100)}`));
                spinner.start(`Subagent running ${toolCall.toolName}`);
            },
            onToolExecutionEnd: ({ toolCall, toolExecutionMs, toolOutput }) => {
                spinner.stop();
                const failed = toolOutput.type === "tool-error";
                const output = failed ? String(toolOutput.error) : String(toolOutput.output);
                const status = `Subagent tool ${failed ? "failed" : "completed"}: ${toolCall.toolName} (${toolExecutionMs} ms)`;
                if (failed) writeMessage(chalk.red(status));
                else writeVerbose(lavender(status));
                writeToolOutput(output, 100, failed);
                spinner.start("Subagent thinking");
            },
        });

        let appendDelta: (delta: string) => void = () => undefined;
        await consumeTextStream(result.fullStream, {
            onTextStart: () => {
                spinner.stop();
                appendDelta = startTextStream(chalk.gray(`  ↳ ${agent?.name ?? "subagent"}`));
            },
            onTextDelta: (delta) => appendDelta(delta),
        });
        return {
            text: await result.text,
            content: await result.content,
            responseMessages: await result.responseMessages,
        };
    };

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
            writeMessage(lavender(`\nAzione proposta dal subagent: ${request.toolCall.toolName}`));
            writeActionPreview(request.toolCall.toolName, request.toolCall.input);
            spinner.stop();
            const answer = await askTerminal(chalk.cyan("Eseguire? [s]ì / [n]o / [a]ccetta sempre in questo workspace per questa sessione: "));
            spinner.start("Subagent thinking");
            const decision = getApprovalDecision(answer);
            const approved = decision !== "deny";
            if (decision === "always") {
                approveTools(MUTATING_TOOLS);
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
        messages.push({ role: "tool", content: approvalResponses });
        result = await generate();
    }
};