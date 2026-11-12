import * as fs from "node:fs";
import * as path from "node:path";
import { WORKDIR } from "../config";
import { parseFrontmatter } from "../utils/frontmatter";

let _SKILLS_DIR = path.join(WORKDIR, ".corbecode/skills");
export const getSKILLS_DIR = () => _SKILLS_DIR;
export const setSKILLS_DIR = (dir: string) => { _SKILLS_DIR = dir; };

interface Skill {
    meta: Record<string, string>;
    body: string;
}

export class SkillLoader {
    private skills: Record<string, Skill> = {};

    constructor(skillsDirectories = [getSKILLS_DIR()]) {
        for (const skillsDir of skillsDirectories) {
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
    }

    parseFrontmatter(text: string): Skill {
        const { meta, body } = parseFrontmatter(text);
        return { meta: Object.fromEntries(Object.entries(meta).map(([key, value]) => [key, String(value)])), body };
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

    getTable(): string {
        const escape = (value: string) => value.replaceAll("\\", "\\\\").replaceAll("|", "\\|").replace(/\r?\n/g, " ");
        const rows = Object.entries(this.skills).map(([name, skill]) =>
            `| ${escape(name)} | ${escape(skill.meta.description ?? "")} |`
        );
        return rows.length ? ["| Nome | Descrizione |", "| --- | --- |", ...rows].join("\n") : "Nessuna skill disponibile.";
    }

    getContent(name: string): string {
        const skill = this.skills[name];
        if (!skill) return `Error: skill ${name} not found`;
        return `<skill name="${name}">\n${skill.body}\n</skill>`;
    }
}