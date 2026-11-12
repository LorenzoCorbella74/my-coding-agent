import { getTerminalUi } from "./terminalUi";

export const createSpinner = () => {
    return {
        start(nextLabel: string) {
            getTerminalUi().setStatus(nextLabel);
        },
        stop() {
            getTerminalUi().clearStatus();
        },
    };
};

export const withSpinner = async <T>(
    label: string,
    action: (spinner: ReturnType<typeof createSpinner>) => Promise<T>,
): Promise<T> => {
    const spinner = createSpinner();
    spinner.start(label);
    try {
        return await action(spinner);
    } finally {
        spinner.stop();
    }
};