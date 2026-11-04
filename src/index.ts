import { google } from '@ai-sdk/google';
import { ollama } from 'ollama-ai-provider-v2';
import { generateText } from 'ai';
import dotenv from 'dotenv';

dotenv.config()

const { text, usage } = await generateText({
  model: google('gemini-2.5-flash'), // ollama('llama3.2-latest')
  prompt: 'Write a vegetarian lasagna recipe for 4 people.',
});
console.log(text, usage);