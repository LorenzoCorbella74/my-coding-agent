# Brainstorming: Idee per potenziare CorbeAgent

## 🔧 **Core Agent Improvements**

| Area | Idee |
|------|------|
| **Memoria/Contesto** | • Conversation history persistente su disco (JSONL/SQLite)<br>• `SUMMARY` tool: l'agente riassume periodicamente la conversazione per risparmiare token<br>• `.corbeagent/context.md` - file di contesto progetto che l'agente aggiorna (architettura, convenzioni, TODO) |
| **Pianificazione** | • `PLAN` tool: scomporre task complessi in step, salvare piano, spuntare completati<br>• Modalità "architetto" vs "esecutore" (thinking separato da acting) |
| **Multi-file editing** | • `edit_files` batch: applicare stessa modifica a più file (es. rinomina import)<br>• Diff/preview prima di applicare (show changes → confirm) |

---

### 🛠️ **Nuovi Tools Utili**

| Tool | Cosa farebbe |
|------|--------------|
| **`grep` / `rg` wrapper** | Ricerca veloce tipo `ripgrep` (più performante di searchCode su codebase grandi) |
| **`git` tool** | `git diff`, `git log`, `git status`, `git commit` (con messaggio generato dall'agente) |
| **`test` runner** | Esegue test (jest/vitest/playwright), mostra output, itera finché passano |
| **`lint` / `typecheck`** | `eslint`, `tsc --noEmit`, `prettier --check` - fix automatici |
| **`browser` / `fetch`** | Legge doc online, API references, StackOverflow, npm package info |
| **`dependency_graph`** | Analizza import/export, genera mappa dipendenze (es. "chi usa questa funzione?") |
| **`symbol_search`** | LSP-based: "trova definizione", "trova riferimenti", "rinomina simbolo" (usa TypeScript Language Service) |

---

### 🎯 **Quality of Life**

| Feature | Descrizione |
|---------|-------------|
| **Slash commands** | `/compact`, `/clear`, `/save-session`, `/load-session`, `/model <name>` |
| **Config per progetto** | `.corbeagent.json` con: model, tool allowlist, system prompt custom, exclude patterns |
| **Streaming output** | Vedi il pensiero dell'agente in tempo reale (non solo risultato finale) |
| **Token usage dashboard** | Costo/token per sessione, per tool, per request |
| **Undo/Redo** | Stack delle modifiche file per rollback facile |

---

### 🤖 **Agentic Workflows (Advanced)**

| Pattern | Esempio |
|---------|---------|
| **Sub-agents** | Spawna agenti specializzati: "test-writer", "doc-generator", "refactorer" che lavorano in parallelo |
| **Critic loop** | Dopo una modifica, un secondo passaggio "code review" automatico (style, bug, security) |
| **Test-driven** | Agente scrive test → falliscono → implementa → passano (loop autonomo) |
| **Issue → PR** | Da GitHub issue → branch → implementa → test → commit → PR draft |

---

### 📦 **Integrazioni Esterne**

- **GitHub/GitLab API**: crea PR, leggi issue, commenta
- **Linear/Jira**: leggi ticket, aggiorna status
- **Database**: `sql` tool per query su DB locale (sqlite/postgres)
- **Docker**: `docker compose up`, logs, exec
- **Kubernetes**: `kubectl` wrapper per deploy/debug

---

### 🎨 **UX/Interfaccia**

- **TUI** (Text UI) con `ink` o `blessed`: pannelli laterali (file tree, diff, logs)
- **Web UI opzionale**: serve su localhost, chat nel browser + file explorer visuale
- **VS Code Extension**: usa l'agente dall'editor (sidebar chat, inline edits)

---

### 🔐 **Sicurezza/Permessi**

- **Allowlist/Denylist tools** per cartella (es. `shell` solo in `scripts/`)
- **Confirmation modes**: `auto` / `ask` / `deny` per tool pericolosi
- **Sandbox**: esegui shell in container Docker isolato

---

### 📊 **Observability**

- **Langfuse / LangSmith / Helicone** tracing per debuggare catene di tool
- **Eval framework**: dataset di task benchmark per misurare qualità nel tempo

---

## 🗂️ **Priorità suggerite (quick wins → big bets)**

| Priorità | Cosa | Sforzo |
|----------|------|--------|
| 🟢 **Alta** | Conversation history persistente | Basso |
| 🟢 **Alta** | `git` tool (diff, commit, log) | Basso |
| 🟢 **Alta** | `lint`/`typecheck` tool + auto-fix | Medio |
| 🟡 **Media** | `test` runner con loop fix | Medio |
| 🟡 **Media** | Symbol search (TS Language Service) | Medio-Alto |
| 🔴 **Bassa** | Sub-agents / critic loop | Alto |
| 🔴 **Bassa** | TUI / Web UI | Alto |

---

**Domanda per restringere:** vuoi che l'agente resti **CLI-only minimalista** o ti interessa farlo evolvere verso un **agent IDE completo**? La direzione cambia molto l'architettura.