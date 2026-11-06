import chalk from 'chalk';

export const createSpinner = () => {
    const frames = ["|", "/", "-", "\\"];
    let frame = 0;
    let label = "";
    let timer: ReturnType<typeof setInterval> | undefined;

    const render = () => {
        process.stdout.write(`\r${chalk.cyan(`${frames[frame++ % frames.length]} ${label}`)}`);
    };

    return {
        start(nextLabel: string) {
            label = nextLabel;
            if (!timer) {
                render();
                timer = setInterval(render, 80);
            }
        },
        stop() {
            if (!timer) return;
            clearInterval(timer);
            timer = undefined;
            process.stdout.write("\r\x1b[2K");
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