import { tool, zodSchema } from "ai";
import { z } from "zod";

const tavilyRequest = async (endpoint: "search" | "extract", body: object) => {
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) throw new Error("TAVILY_API_KEY is required to use web tools");

    const response = await fetch(`https://api.tavily.com/${endpoint}`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) {
        throw new Error(`Tavily ${endpoint} failed (${response.status}): ${JSON.stringify(result)}`);
    }
    return result;
};

export const webSearch = tool({
    description: "Search the web for up-to-date information using Tavily",
    inputSchema: zodSchema(z.object({ query: z.string().min(1).max(500) })),
    execute: async ({ query }) => tavilyRequest("search", {
        query,
        search_depth: "basic",
        max_results: 5,
    }),
});

export const webExtract = tool({
    description: "Extract page content from one or more URLs using Tavily",
    inputSchema: zodSchema(z.object({
        urls: z.array(z.string().url()).min(1).max(20),
        extractDepth: z.enum(["basic", "advanced"]).optional(),
    })),
    execute: async ({ urls, extractDepth }) => tavilyRequest("extract", {
        urls,
        ...(extractDepth ? { extract_depth: extractDepth } : {}),
        format: "markdown",
    }),
});