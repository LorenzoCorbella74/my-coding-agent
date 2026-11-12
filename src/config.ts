import dotenv from 'dotenv';
import os from 'node:os';
import path from 'node:path';

dotenv.config({ quiet: true })

/** CONSTANTS */
export const CONTEXT_LIMIT = 50000;
export const WORKDIR = path.resolve(process.env.CORBEAGENT_WORKDIR ?? process.cwd());
export const GLOBAL_DATA_DIR = process.platform === "win32"
    ? path.join(os.homedir(), ".corbecode")
    : path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "corbecode");