import { createInterface, type Interface } from "node:readline";

let terminal: Interface | undefined;
let promptQueue: Promise<void> = Promise.resolve();

const getTerminal = (): Interface => {
    terminal ??= createInterface({ input: process.stdin, output: process.stdout });
    return terminal;
};

export const askTerminal = (prompt: string): Promise<string> => {
    if (process.stdin.isTTY !== true) {
        return Promise.reject(new Error("Interactive input is unavailable because stdin is not a TTY."));
    }

    const answer = promptQueue.then(() => new Promise<string>((resolve, reject) => {
        const rl = getTerminal();
        const onSigint = () => {
            rl.removeListener("SIGINT", onSigint);
            rl.close();
            terminal = undefined;
            reject(new Error("Input cancelled by user."));
        };

        rl.once("SIGINT", onSigint);
        rl.question(prompt, (value) => {
            rl.removeListener("SIGINT", onSigint);
            resolve(value);
        });
    }));

    promptQueue = answer.then(() => undefined, () => undefined);
    return answer;
};

export const getApprovalDecision = (answer: string): "approve" | "deny" | "always" => {
    const normalized = answer.trim().toLowerCase();
    if (["a", "sempre", "w", "workspace"].includes(normalized)) return "always";
    if (["s", "si", "y", "yes"].includes(normalized)) return "approve";
    return "deny";
};

export const closeTerminalInput = (): void => {
    terminal?.close();
    terminal = undefined;
};
