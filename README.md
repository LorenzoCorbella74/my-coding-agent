# Corbe Code

![Corbe Code](./docs/screen.png)

Corbe Code è un coding agent da terminale, realizzato in TypeScript con Vercel AI SDK e OpenRouter. Mantiene la conversazione durante la sessione, usa tool per esplorare e modificare il workspace.

## Configurazione

Richiede Node.js 22.19 o successivo, npm e un terminale interattivo. Crea un file `.env` nella directory da cui lancerai CorbeAgent:

```env
OPENROUTER_API_KEY=la-tua-api-key
MODEL=provider/model
```

Installa le dipendenze e avvia la chat nella cartella corrente:

```sh
npm install
npm run dev
```

Puoi indicare una cartella locale diversa:

```sh
npm run dev -- --workspace "C:\\percorso\\al\\progetto"
```

Per provare il comando come CLI locale, dalla cartella di CorbeAgent compila e collegalo:

```sh
npm run build
npm link
```

Poi, da qualsiasi cartella, avvia `corbecode` (workspace corrente) oppure `corbecode --workspace "C:\\percorso\\al\\progetto"`. La chiave OpenRouter e il modello vengono letti dal file `.env` nella cartella da cui lanci il comando.

```sh
corbecode --help
corbecode --version
```

Per controllare i tipi e generare il bundle in `dist/`:

```sh
npm run build
```

Le sessioni sono salvate come JSONL in `.corbecode/sessions/`; `.corbecode/active-session` contiene i metadati JSON di tutte le sessioni (ID attivo, data di creazione, tool approvati e titolo). Il vecchio puntatore testuale viene migrato automaticamente. `.corbecode/.gitignore` esclude questi dati dal versionamento.

## Funzionamento

Palette della TUI: cyan per titoli, prompt e reasoning; lavanda (`#BD93F9`) per tool, link ed evidenziazioni; arancione (`#FFB86C`) con chiavi in grassetto per statistiche token; grigio per dettagli e metadati; rosso per errori. I colori vengono adattati alle capacita cromatiche del terminale.

Gli output riusciti dei tool vengono renderizzati in Markdown sotto l'etichetta `Output:`; gli errori rimangono testo rosso. Restano i limiti di 500 caratteri per l'agente principale e 100 per i subagent, con indicazione esplicita della troncatura.

I dettagli `Tool started`, `Input` e `Tool completed` sono nascosti all'avvio. `/verbose` ne alterna la visibilita per i messaggi successivi, anche dei subagent, fino alla chiusura della CLI; non modifica la cronologia gia mostrata. Output, errori e approvazioni restano sempre visibili.

Prima della conferma, `write_file` mostra il percorso e una preview completa del contenuto, mentre `edit_file` mostra un diff unificato del file con alcune righe di contesto (applicando la stessa sostituzione che eseguirà il tool). I blocchi di codice hanno evidenziazione sintattica basata sull'estensione; i linguaggi sconosciuti sono mostrati come testo senza evidenziazione. La preview non modifica i file e si applica anche ai subagent.

L'interfaccia usa `@earendil-works/pi-tui`: cronologia scorrevole sopra e box di input multilinea fissato in basso. Risposte del modello renderizzate in Markdown (titoli, liste, tabelle e blocchi di codice); reasoning, tool, errori, utilizzo token e approvazioni sono mostrati nella stessa cronologia. Lo spinner e uno stato della TUI e non scrive direttamente sul terminale.

- `Enter`: invia; `Alt+Enter`: nuova riga (anche `Shift+Enter` nei terminali compatibili).
- `/`: apre l'autocomplete dei comandi; frecce per scegliere, `Tab` per completare.
- `@`: apre l'autocomplete di file e directory del workspace, anche con spazi e percorsi Windows; seleziona una directory per proseguire lungo il percorso. Non richiede `fd`. I riferimenti restano testo nel prompt: non allegano automaticamente il contenuto dei file.
- `PageUp`/`PageDown` o rotella del mouse: scorrono la cronologia senza spostare l'input.
- `Ctrl+C`: annulla la richiesta LLM o l'approvazione in corso; quando la CLI attende un nuovo messaggio, esce ripristinando il terminale. I comandi shell gia avviati restano soggetti al timeout del tool.

L'input e condiviso tra chat e approvazioni; durante l'esecuzione non vengono inviati nuovi messaggi. `--help` e `--version` funzionano anche senza TTY.

All'avvio Corbe Code mostra nome, versione e modello. Se presente, `AGENTS.md` nella root del workspace viene aggiunto al contesto del modello. Prima di eseguire `shell`, `edit_file` o `write_file`, Corbe Code mostra l'azione proposta e chiede conferma; è possibile approvare una singola azione, rifiutarla o accettare sempre le modifiche per il workspace nella sessione corrente. L'accettazione persistente è salvata nei metadati della sessione e resta valida dopo il riavvio. Gli altri tool non modificano il workspace e vengono eseguiti senza conferma. Ogni richiesta viene inviata al modello insieme alla cronologia della sessione e ai tool disponibili; la risposta testuale del modello (agente e subagent) viene mostrata in streaming, man mano che arriva. Se il modello invoca un tool, il programma mostra una riga per ogni azione con icona ed etichetta (ad esempio `▤ read: src/a.ts`, `✎ edit: src/a.ts`, `✚ write: notes.md`, `❯ bash: npm test`); le azioni dei subagent sono rientrate con `↳`. In modalità verbosa registra anche nome, input, esito e durata; gli output dei log sono limitati a 500 caratteri. A fine risposta mostra l'utilizzo dei token.

Il modello usa `ask_user_input` solo quando manca un'informazione decisiva che non può ricavare dal workspace. I prompt condividono l'input del terminale con la chat; scelte invalide vengono ripetute e i default devono corrispondere a una delle opzioni.

## Sessioni

All'avvio viene ripresa automaticamente l'ultima sessione attiva. I comandi disponibili sono:

- `/new`: crea e attiva una nuova sessione.
- `/sessions`: apre un selettore delle sessioni; frecce per scegliere, Invio per attivare, Esc per annullare. Aggiorna cronologia, approvazioni e ID nel footer.
- `/skills`: mostra una tabella con nome e descrizione delle skill disponibili.
- `/verbose`: attiva/disattiva i dettagli di esecuzione dei tool (inizialmente disattivati).
- `/restore <sessionId>`: riprende una sessione usando l'ID breve mostrato nell'elenco; sono richiesti almeno 8 caratteri.
- `/compress`: comprime solo la sessione attiva e sostituisce il suo JSONL con il riepilogo; la cronologia originale rimossa non viene conservata.
- `/quit` e `/exit`: chiudono la chat. Restano supportati anche `quit` ed `exit` senza slash.

## Tool

- `task`: delega un compito a un subagent con contesto separato. Il parametro opzionale `agent` seleziona un agente custom per nome; se omesso usa il subagent generico.

- `explore_workspace`: elenca file e directory senza leggerne il contenuto. Supporta root, glob, tipo, profondità, esclusioni e limite risultati. Esclude cartelle comuni di dipendenze/build e applica le esclusioni derivate da `.gitignore`.
- `searchCode`: cerca testo letterale o regex e restituisce percorso, righe e contesto. Supporta root, glob, maiuscole/minuscole, righe di contesto e limite risultati; ignora file oltre 2 MB. È implementato con API Node e non richiede `ripgrep`.
- `read_file` e `read_files`: leggono uno o più file nel workspace. La lettura multipla accetta fino a 20 percorsi; l'output è limitato a 50.000 caratteri.
- `shell`: esegue comandi nella root del workspace, tramite PowerShell su Windows e `sh` sugli altri sistemi. I comandi possono modificare file; il tool non è una sandbox.
- `write_file` e `edit_file`: creano/sovrascrivono un file o sostituiscono le occorrenze del testo indicato.
- `ask_user_input`: raccoglie una risposta libera o una scelta. Richiede un terminale interattivo.

I percorsi dei tool di lettura e scrittura sono confinati al workspace. Esplorazione e ricerca sono in sola lettura.

## Agenti custom

Crea file `.agent.md` (o `.md`) in `.corbecode/agents/` nel workspace. Come per le skill, vengono caricati all'avvio; nomi, descrizioni e tool disponibili entrano nel system prompt del modello principale. Le istruzioni complete vengono aggiunte al system prompt del subagent selezionato tramite `task({ task: "...", agent: "Reviewer" })`, insieme alle istruzioni del workspace in `AGENTS.md`.

```markdown
---
name: Reviewer
description: "Usa per revisioni del codice: identifica bug senza modificare file."
tools: [read, search]
---

Analizza il codice e segnala solo problemi concreti, indicando file e righe.
Non modificare file.
```

Il formato YAML supporta stringhe quotate, valori multilinea, liste inline o a blocchi e `tools` come stringa separata da virgole. `description` e istruzioni sono obbligatorie; `name` omesso usa il nome del file senza `.agent.md` o `.md`.

I tool possono essere i nomi nativi della CLI oppure gli alias `read` (lettura singola/multipla), `search`/`Grep`/`Glob` (esplorazione/ricerca), `edit`/`MultiEdit`/`Write` (modifica/scrittura), `execute`/`Bash`/`powershell` (shell). Gli alias non distinguono maiuscole e minuscole. Omettere `tools` o usare `["*"]` abilita tutti i tool del subagent; `[]` li disabilita tutti. I tool esclusi non vengono forniti al modello, anche se approvati nella sessione. Le operazioni modificative mantengono il flusso di approvazione esistente.

La compatibilita con Copilot riguarda `name`, `description`, `tools` e il corpo Markdown, non funzionalita specifiche come `model`, `handoffs`, hook o MCP. Campi non supportati, tool sconosciuti, YAML invalido e nomi duplicati causano un errore esplicito all'avvio. I subagent non hanno accesso a `task`, per evitare delegazioni ricorsive.

Il campo Copilot `user-invocable` e accettato come booleano (`true` o `false`). Riguarda la selezione manuale in un picker, non la delega dal modello: poiche la CLI non ha un picker, non cambia il comportamento di `task.agent` ne la scoperta degli agenti.

## TODO

- [] [Usare Github copilot models](https://vercel.com/changelog/github-copilot-ai-sdk-harness-adapter)
