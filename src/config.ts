import dotenv from 'dotenv';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import path from 'node:path';

dotenv.config()

/** CONSTANTS */
export const CONTEXT_LIMIT = 50000;
export const WORKDIR = path.resolve(process.env.CORBEAGENT_WORKDIR ?? process.cwd());


// TODO: other providers
export const api = createOpenRouter({
    apiKey: process.env.OPENROUTER_API_KEY!,
});
export const MODEL = process.env.MODEL!;