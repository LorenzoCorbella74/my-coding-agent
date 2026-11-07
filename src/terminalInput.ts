import { getTerminalUi } from "./terminalUi";

export const askTerminal = (prompt: string): Promise<string> => {
    return getTerminalUi().ask(prompt);
};

export const getApprovalDecision = (answer: string): "approve" | "deny" | "always" => {
    const normalized = answer.trim().toLowerCase();
    if (["a", "sempre", "w", "workspace"].includes(normalized)) return "always";
    if (["s", "si", "y", "yes"].includes(normalized)) return "approve";
    return "deny";
};

export const closeTerminalInput = (): void => {
    getTerminalUi().close();
};
