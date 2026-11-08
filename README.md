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

Per `shell`, la conferma mostra direttamente `Eseguire "<comando>" ?`, senza il blocco JSON degli argomenti o la domanda generica duplicata. Il nome del subagent resta visibile; le scelte di approvazione singola, rifiuto e accettazione per la sessione non cambiano.

L'interfaccia usa `@earendil-works/pi-tui`: cronologia scorrevole sopra e box di input multilinea fissato in basso. Risposte del modello renderizzate in Markdown (titoli, liste, tabelle e blocchi di codice); reasoning, tool, errori, utilizzo token e approvazioni sono mostrati nella stessa cronologia. Lo spinner e uno stato della TUI e non scrive direttamente sul terminale.

I selettori di sessioni, change e conferme del workflow sono pannelli ancorati immediatamente sopra il box di input, non finestre sovrapposte al centro. Mostrano al massimo 6 opzioni, riducendole se il terminale e basso; il ridimensionamento mantiene la scelta corrente. Frecce e Invio selezionano, Esc annulla; PageUp/PageDown restano disponibili per consultare la cronologia. Alla chiusura il focus torna all'editor e in cronologia rimane solo la decisione confermata, senza l'elenco delle opzioni.

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

## Workflow di change

La chat libera resta il comportamento predefinito: domande, spiegazioni e modifiche ordinarie non creano automaticamente un workflow. I comandi `/flow:*` attivano esplicitamente un percorso pianificato con subagent separati, approvazione dell'utente e documenti persistenti.

Una **change** contiene richiesta, analisi, piano versionato, criteri di accettazione, attivita e rapporti. Nel workspace puo esserci **una sola change corrente**, condivisa tra le sessioni di chat. Le altre restano sospese o chiuse; cambiare sessione non cambia la change corrente.

### Comandi

| Comando                     | Funzionamento                                                                                                                                                                                                                                         |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/flow:explore <idea>`      | Il Planner analizza il problema e confronta soluzioni, senza implementare o creare un piano ufficiale. Senza change corrente, l'esplorazione viene salvata per il prossimo `propose`; con una change corrente viene registrata nella sua discussione. |
| `/flow:propose <richiesta>` | Crea la change e avvia il Planner, usando anche l'esplorazione salvata. Genera piano, criteri e attivita prima dell'implementazione. Se esiste una change corrente, chiede conferma per sospenderla e crearne una nuova.                              |
| `/flow:update <modifica>`   | Il Planner revisiona il piano della change corrente, usando richiesta, discussione e risultati precedenti. Mantiene le attivita completate ancora valide e riapre quelle coinvolte. Invalida l'approvazione precedente.                               |
| `/flow:apply`               | Mostra piano, versione ed eventuali problemi di verifica, poi chiede conferma. Approva e implementa la versione corrente tramite il Developer. Al termine dello sviluppo completato avvia automaticamente il Verifier.                                |
| `/flow:review`              | Avvia opzionalmente il Reviewer sull'implementazione della change corrente e salva i rilievi, senza correggerli. Richiede che sia gia presente un rapporto di sviluppo.                                                                               |
| `/flow:list`                | Elenca tutte le change con ID breve, titolo, selezione corrente, fase e revisione.                                                                                                                                                                    |
| `/flow:resume [id]`         | Senza ID apre il selettore; con ID accetta anche un prefisso univoco. Seleziona la change, chiedendo conferma per sospendere quella corrente o riaprire una change chiusa. Non avvia lo sviluppo.                                                     |
| `/flow:pause`               | Sospende la change corrente e restituisce alla chat libera i tool ordinari. Conserva tutto per la ripresa.                                                                                                                                            |
| `/flow:end`                 | Chiude la change corrente e conserva i documenti. Se la verifica non e passata, richiede conferma esplicita e registra la chiusura come incompleta.                                                                                                   |

`propose` crea, `update` revisiona, `apply` autorizza ed esegue. Nessuno dei primi due modifica il codice. Un `apply` su una change gia completata non ripete il lavoro: per ulteriori modifiche serve `update`.

### Agenti e approvazioni

La CLI include quattro agenti predefiniti, anche senza file custom nel workspace:

| Agente    | Responsabilita                                                                                          | Tool di base                                  |
| --------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Planner   | Analisi, chiarimenti decisivi, piano, attivita e criteri. Non implementa.                               | Lettura, ricerca e skill                      |
| Developer | Implementazione del piano approvato, aggiornamento delle attivita e controlli mirati.                   | Lettura, ricerca, modifica, shell e skill     |
| Verifier  | Controllo indipendente di implementazione e criteri. Non corregge il codice.                            | Lettura, ricerca, shell per verifiche e skill |
| Reviewer  | Review su richiesta: bug, sicurezza, convenzioni e manutenibilita, con gravita e riferimenti al codice. | Lettura, ricerca e skill                      |

L'orchestratore controlla le transizioni nel codice. Ogni subagent riceve richiesta originale, piano, vincoli e risultati salvati degli step precedenti, non la sola frase finale del precedente agente. Il Developer comunica l'avanzamento tramite `flow_progress`; Planner e altri ruoli consegnano risultati strutturati tramite `flow_plan` e `flow_report`. Il padre valida gli aggiornamenti e scrive i documenti.

La verifica passa soltanto se tutte le attivita sono completate, tutti i criteri sono soddisfatti, ci sono controlli riusciti e non risultano problemi. Un controllo non eseguibile non e un successo. Per i controlli dichiarati riusciti dal Verifier, il runtime richiede un comando realmente eseguito nello stesso step con codice di uscita zero.

Se la verifica fallisce, il workflow attende: un nuovo `/flow:apply` mostra i problemi e richiede conferma prima delle correzioni. Se cambia l'ambito, usare invece `/flow:update` e poi `/flow:apply`. Un blocco dello sviluppo non avvia la verifica.

L'approvazione del piano resta **distinta dalle approvazioni dei tool**. Le conferme di modifica e shell restano attive; il Verifier chiede sempre approvazione per la shell, anche se approvata nella sessione. La shell non e una sandbox: le istruzioni di sola verifica non costituiscono una garanzia tecnica che un comando non possa modificare file.

Quando una change e corrente, i messaggi normali servono alla discussione e vengono salvati senza modificare automaticamente il piano. La chat principale dispone solo di lettura, ricerca e skill, senza shell, scrittura o delega generica. Scrivere "procedi" non equivale a `/flow:apply`. Per modifiche libere non legate alla change, usare prima `/flow:pause`.

### Documenti e ripresa

Ogni change viene salvata in `.corbecode/workflows/<id>/`:

```text
state.json       Stato strutturato autorevole, revisioni, approvazioni e risultati
plan.md          Richiesta, analisi, ambito, rischi e criteri di accettazione
tasks.md         Attivita: pending, in_progress, completed, blocked
reports.md       Rapporti di sviluppo/verifica/review e cronologia degli eventi
exploration.md   Esplorazione e discussioni della change
```

I Markdown sono viste generate dallo stato strutturato: non modificarli manualmente per cambiare il workflow; usare `/flow:update`. Lo stato viene sostituito atomicamente a ogni aggiornamento; i Markdown vengono rigenerati a partire da quello stato. Le revisioni precedenti del piano restano nel JSON e i rapporti superati sono indicati come `outdated`.

Il puntatore `.corbecode/active-flow.json` identifica l'unica change corrente. L'esplorazione precedente a `propose` e salvata in `.corbecode/workflows/exploration.json` e viene consumata alla creazione della change. I dati runtime del workflow sono esclusi dal versionamento tramite `.corbecode/.gitignore`.

All'avvio viene segnalata la change corrente, senza esecuzioni automatiche. Una fase interrotta viene marcata `blocked`, mantenendo le attivita salvate: `in_progress` non viene convertito automaticamente in completato. Dopo `resume`, il Developer deve controllare il workspace prima di proseguire. Non vengono effettuati rollback delle modifiche gia eseguite.

Un aggiornamento del piano interrotto conserva la richiesta in sospeso e blocca l'uso del vecchio piano: completare `/flow:update <modifica>` prima di `apply`. Durante l'esecuzione l'input resta occupato; per sospendere o cambiare change bisogna prima interrompere con `Ctrl+C`. I comandi shell gia avviati mantengono il timeout esistente.

Chiusa, corrente e sospesa descrivono la selezione/ciclo di vita; pianificazione, attesa approvazione, sviluppo, verifica, attesa correzione, completata e bloccata descrivono la fase. Una change chiusa puo essere incompleta; una review e facoltativa e non blocca `end`.

### Esempi applicativi

**Nuova autenticazione, dall'idea alla chiusura:**

```text
/flow:explore Valutiamo login con sessione oppure JWT per questa applicazione
/flow:propose Implementa login e logout con sessione, senza registrazione pubblica
```

Il Planner esplora il codice, chiarisce le informazioni mancanti e mostra piano e attivita. Si puo discuterne in chat; per recepire una modifica nel piano:

```text
/flow:update Aggiungi anche il recupero password tramite email
/flow:apply
```

Dopo conferma del piano e delle eventuali azioni dei tool, il Developer implementa e aggiorna le attivita. Il Verifier parte automaticamente. Se passa:

```text
/flow:review
/flow:end
```

**Integrare un rilievo della review:**

```text
/flow:update Risolvi il rilievo sulla mancata invalidazione della sessione al logout
/flow:apply
/flow:review
/flow:end
```

Il piano riceve una nuova versione; le attivita ancora valide restano completate. Il vecchio rapporto di review e conservato ma marcato superato.

**Verifica negativa e correzione autorizzata:**

Se il Verifier segnala un test fallito, leggere il rapporto. Per correggere senza cambiare ambito:

```text
/flow:apply
```

La CLI mostra i problemi e chiede una nuova conferma prima del ritorno al Developer. Dopo la correzione riesegue la verifica. Nessun ciclo di correzione parte da solo.

**Sospendere, lavorare in chat libera e riprendere:**

```text
/flow:pause
Spiegami come funziona il caricamento delle skill
/flow:list
/flow:resume
/flow:apply
```

`resume` apre la lista e rende corrente la change scelta, senza implementare. Si puo anche usare `/flow:resume <id-breve>`. Una change chiusa richiede conferma per la riapertura; se gia completata, usare `update` per introdurre nuovo lavoro.

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

Planner, Developer, Verifier e Reviewer sono inclusi nella CLI e disponibili anche tramite `task`. Un agente custom con lo stesso nome sostituisce il predefinito. Le restrizioni del ruolo nel workflow rimangono applicate: un Planner custom con `tools: ["*"]` non ottiene shell o scrittura nel flusso.

Per associare un agente con nome diverso a un ruolo, crea `.corbecode/flow-agents.json`, per esempio:

```json
{
  "Planner": "Analista",
  "Developer": "AngularDeveloper",
  "Reviewer": "SecurityReviewer"
}
```

Gli agenti indicati devono esistere nei file custom. I ruoli omessi usano il rispettivo agente predefinito. Il mapping viene letto a ogni invocazione; le definizioni degli agenti sono caricate all'avvio. I tool effettivi sono l'intersezione tra quelli dell'agente e quelli consentiti dal ruolo. Per un Verifier custom, includere `execute` se deve eseguire test; senza controlli eseguiti non puo ottenere un esito positivo.

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
