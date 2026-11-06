import fs from 'node:fs';
import path from 'node:path';
import packageJson from '../package.json' with { type: 'json' };

const printHelp = () => {
    console.log(`CorbeAgent ${packageJson.version}

Usage: corbeagent [--workspace <path>]

Options:
  -w, --workspace <path>  Workspace directory (defaults to current directory)
  -h, --help              Show this help
  -v, --version           Show version`);
};

const args = process.argv.slice(2);
let workspacePath: string | undefined;

for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
        printHelp();
        process.exit(0);
    }
    if (arg === '--version' || arg === '-v') {
        console.log(packageJson.version);
        process.exit(0);
    }
    if (arg === '--workspace' || arg === '-w') {
        workspacePath = args[index + 1];
        if (!workspacePath || workspacePath.startsWith('-')) {
            console.error(`Missing path after ${arg}`);
            process.exit(2);
        }
        index += 1;
        continue;
    }
    console.error(`Unknown option: ${arg}`);
    printHelp();
    process.exit(2);
}

const workspace = path.resolve(workspacePath ?? process.cwd());
if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
    console.error(`Workspace is not a directory: ${workspace}`);
    process.exit(2);
}

process.env.CORBEAGENT_WORKDIR = workspace;
await import('./index.js');