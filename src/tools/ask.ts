import { askTerminal } from "../terminalInput";

export const runAskUserInput = async ({
    question,
    options,
    defaultValue,
}: {
    question: string;
    options?: string[] | undefined;
    defaultValue?: string | undefined;
}) => {
    const choices = options ?? [];
    let feedback = "";

    while (true) {
        const prompt = [
            "",
            `🤖 ${question}`,
            ...(choices.length > 0 ? ["Opzioni:", ...choices.map((option, index) => `  ${index + 1}. ${option}`)] : []),
            ...(defaultValue ? [`[Default: ${defaultValue}]`] : []),
            ...(feedback ? [feedback] : []),
            "> ",
        ].join("\n");

        let answer: string;
        try {
            answer = await askTerminal(prompt);
        } catch (error) {
            return `Unable to get user input: ${error instanceof Error ? error.message : String(error)}`;
        }

        const trimmed = answer.trim();
        if (!trimmed && defaultValue) return defaultValue;
        if (!trimmed) {
            feedback = "Inserisci una risposta per continuare.";
            continue;
        }
        if (choices.length === 0) return trimmed;

        const choiceNumber = /^\d+$/.test(trimmed) ? Number(trimmed) : 0;
        const selected = choiceNumber > 0 && choiceNumber <= choices.length
            ? choices[choiceNumber - 1]
            : choices.find((option) => option.toLowerCase() === trimmed.toLowerCase());
        if (selected) return selected;

        feedback = `Scelta non valida. Inserisci un numero da 1 a ${choices.length} o il testo di un'opzione.`;
    }
};