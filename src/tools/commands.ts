import { WORKDIR } from "../config";
import { spawnSync } from "child_process";

const BLOCKED_COMMANDS = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];

export const executeCommand = (command: string): string => {
    if (BLOCKED_COMMANDS.some((c) => command.includes(c))) {
        return "Error: Danger Will Robinson!!!";
    }
    try {
        const isWindows = process.platform === "win32";
        const result = spawnSync(
            isWindows ? "powershell.exe" : "sh",
            isWindows ? ["-NoProfile", "-NonInteractive", "-Command", command] : ["-c", command],
            {
                cwd: WORKDIR,
                encoding: "utf8",
                timeout: 120000
            }
        );
        const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().slice(0, 50000);
        return result.error ? `Error: ${result.error.message}${output ? `\n${output}` : ""}` : output;

    } catch (e) {
        return `Error ${e}`;
    }
};