import { WORKDIR } from "../config";
import { spawn } from "child_process";

const BLOCKED_COMMANDS = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];

export const executeCommandWithResult = async (command: string): Promise<{ output: string; exitCode: number | null; error: string | null }> => {
    if (BLOCKED_COMMANDS.some((c) => command.includes(c))) {
        return { output: "", exitCode: null, error: "Blocked command" };
    }
    try {
        const isWindows = process.platform === "win32";
        return await new Promise((resolve) => {
            const child = spawn(
                isWindows ? "powershell.exe" : "sh",
                isWindows ? ["-NoProfile", "-NonInteractive", "-Command", command] : ["-c", command],
                { cwd: WORKDIR, timeout: 120000 },
            );
            let stdout = "";
            let stderr = "";
            let error: string | null = null;
            child.stdout.setEncoding("utf8");
            child.stderr.setEncoding("utf8");
            child.stdout.on("data", (data: string) => { stdout = (stdout + data).slice(0, 50000); });
            child.stderr.on("data", (data: string) => { stderr = (stderr + data).slice(0, 50000); });
            child.on("error", (failure) => { error = failure.message; });
            child.on("close", (exitCode, signal) => resolve({
                output: `${stdout}${stderr}`.trim().slice(0, 50000),
                exitCode,
                error: error ?? (signal ? `Command terminated by ${signal}. Timeout: 120000 ms.` : null),
            }));
        });

    } catch (e) {
        return { output: "", exitCode: null, error: String(e) };
    }
};

export const executeCommand = async (command: string): Promise<string> => {
    const result = await executeCommandWithResult(command);
    return result.error ? `Error: ${result.error}${result.output ? `\n${result.output}` : ""}` : result.output;
};