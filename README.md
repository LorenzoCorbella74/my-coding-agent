# Corbe Code

![Corbe Code](./docs/screen.png)

Coding agent da terminale per esplorare e modificare un workspace con i modelli free di OpenRouter e Vercel AI SDK.

## Configurazione

Richiede Node.js 22.19 o successivo, npm e un terminale interattivo. Crea `.env` nella cartella da cui avvii l'agente:

```env
OPENROUTER_API_KEY=la-tua-api-key
MODEL=provider/model
TAVILY_API_KEY=tvly-la-tua-api-key # opzionale, per la ricerca web
```

Installa e avvia dalla cartella del progetto:

```sh
npm install
npm run dev
```

Per usare un workspace diverso, aggiungi `--workspace <percorso>`.

## Funzionalità

- Chat in streaming con cronologia persistente e ripresa delle sessioni.
- Esplorazione, ricerca e lettura dei file; modifiche e comandi shell richiedono approvazione.
- Ricerca web ed estrazione di pagine tramite Tavily, se configurato `TAVILY_API_KEY`.
- Subagent e agenti custom definiti nel workspace; `AGENTS.md` viene aggiunto al contesto quando presente.
- Workflow espliciti per pianificare, approvare, implementare e verificare una change.
- Interfaccia terminale con Markdown, selezione di file tramite `@` e cronologia navigabile.
- Agent Skills: elenca le skill disponibili per l'agente, incluse quelle definite nel workspace e i tool integrati.

## Comandi

**CLI**

```sh
corbecode [--workspace <percorso>]
corbecode --help
corbecode --version
```

**Chat**

- `/new`, `/sessions`, `/restore <id>`: crea, seleziona o ripristina una sessione.
- `/compress`: comprime la cronologia attiva.
- `/skills`: elenca le skill; `/verbose`: mostra o nasconde i dettagli dei tool.
- `/quit` o `/exit`: chiude la CLI.
- `Enter` invia, `Alt+Enter` inserisce una riga, `Ctrl+C` interrompe la richiesta corrente.

**Workflow**

- `/flow:explore <idea>`: esplora un'idea senza implementarla.
- `/flow:propose <richiesta>`: prepara una change e il relativo piano.
- `/flow:update <modifica>`: aggiorna il piano; `/flow:apply` lo approva e avvia il lavoro.
- `/flow:review`: richiede una review; `/flow:list` elenca le change.
- `/flow:resume [id]`: riprende una change; `/flow:pause` la sospende.
- `/flow:end`: chiude la change corrente.
