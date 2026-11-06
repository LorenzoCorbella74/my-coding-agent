import * as fs from "node:fs";
import * as path from "node:path";
import { WORKDIR } from "./config";

let _SKILLS_DIR = path.join(WORKDIR, ".corbeagent/skills");
export const getSKILLS_DIR = () => _SKILLS_DIR;
export const setSKILLS_DIR = (dir: string) => { _SKILLS_DIR = dir; };

interface Skill {
    meta: Record<string, string>;
    body: string;
}

export class SkillLoader {
    private skills: Record<string, Skill> = {};

    constructor() {
        const skillsDir = getSKILLS_DIR();
        fs.mkdirSync(skillsDir, { recursive: true });
        for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const skillFile = path.join(skillsDir, entry.name, 'SKILL.md');
            if (!fs.existsSync(skillFile)) continue;
            const text = fs.readFileSync(skillFile, "utf8");
            const { meta, body } = this.parseFrontmatter(text);
            const name = meta["name"] ?? entry.name;
            this.skills[name] = { meta, body };
        }
    }

    parseFrontmatter(text: string): Skill {
        const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
        if (!match) return { meta: {}, body: text };
        const [, rawMeta = '', rawBody = ''] = match;
        const meta: Record<string, string> = {};
        for (const line of rawMeta.split('\n')) {
            const [k, ...v] = line.split(':');
            if (k && v.length) meta[k.trim()] = v.join(':').trim();
        }
        return { meta, body: rawBody.trim() };
    }

    getDescriptions() {
        const entries = Object.entries(this.skills);
        if (!entries.length) return '(no skills available)';
        return entries
            .map(([name, s]) => {
                return `  - ${name}: ${s.meta.description ?? ''}`;
            })
            .join('\n');
    }

    getContent(name: string): string {
        const skill = this.skills[name];
        if (!skill) return `Error: skill ${name} not found`;
        return `<skill name="${name}">\n${skill.body}\n</skill>`;
    }
}