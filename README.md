# Corbe Code

![Corbe Code](./docs/screen.png)

Coding agent da terminale per esplorare e modificare un workspace con OpenRouter, OpenAI, Anthropic, Google Gemini e server OpenAI-compatible, tramite Vercel AI SDK.

## Configurazione

Richiede Node.js 22.19 o successivo, npm e un terminale interattivo.

Installa e avvia dalla cartella del progetto:

```sh
npm install
npm run dev
```

Per usare un workspace diverso, aggiungi `--workspace <percorso>`.

Nella chat, esegui `/login` per configurare un provider e `/models` per scegliere il modello. `Alt+R`, al prompt della chat, apre il selettore del reasoning senza perdere il testo in composizione. La scelta globale di provider, modello e reasoning viene ripristinata al riavvio e usata anche da subagent, workflow e compressione.

I dati personali vengono salvati fuori dal workspace: in Windows sotto `%USERPROFILE%\.corbecode`, su macOS e Linux sotto `~/.config/corbecode` (rispettando `XDG_CONFIG_HOME` se impostata). Le sessioni sono conservate in `sessions/<nome-progetto>-<hash-percorso>` per restare separate anche tra progetti omonimi; quelle già presenti in `.corbecode` o nella precedente cartella globale basata solo sull'hash vengono copiate senza rimuovere l'origine. Agenti e skill vengono caricati sia dalla cartella globale (`agents/` e `skills/`) sia da `.corbecode` nel workspace, dove una definizione locale prevale su quella globale. Workflow e configurazioni specifiche del progetto restano nel workspace.

### Credenziali e override

Il file globale `config.json` conserva le chiavi dei provider e la selezione corrente. Le chiavi sono **in chiaro**: non condividere il file. L'inserimento e' mascherato, senza copia nella conversazione o nella cronologia dell'editor. Il salvataggio e' atomico; su POSIX il file viene creato con permessi `0600`, su Windows eredita le ACL della cartella utente.

`/login` verifica la credenziale prima del salvataggio. Un errore di autenticazione non sostituisce la configurazione; per problemi di rete o cataloghi non disponibili puoi scegliere esplicitamente di salvare senza verifica. `Esc` annulla. Ripetendo il login puoi sostituire una chiave; un campo vuoto conserva quella gia' salvata. Gli altri provider restano invariati.

Il file `.env` e' facoltativo. Le variabili d'ambiente prevalgono sulla configurazione globale:

```env
OPENROUTER_API_KEY=la-tua-api-key
# Alternative: OPENAI_API_KEY, ANTHROPIC_API_KEY,
# GOOGLE_GENERATIVE_AI_API_KEY oppure GEMINI_API_KEY
# Override facoltativi: rimuovili per usare la scelta salvata da /models
CORBECODE_PROVIDER=openrouter
MODEL=provider/model
TAVILY_API_KEY=tvly-la-tua-api-key
```

`MODEL` senza un provider salvato usa OpenRouter, come nelle versioni precedenti. Gli override del modello sono segnalati all'avvio e dopo `/models`; il footer mostra la selezione effettiva. `/login` segnala quando una chiave d'ambiente prevale su quella appena salvata.

### Modelli locali e provider personalizzati

In `/login` scegli **Ollama locale** (URL predefinito `http://localhost:11434/v1`) oppure **Aggiungi endpoint OpenAI-compatible**. Puoi salvare piu' server con nomi diversi, per esempio Ollama e LM Studio. Per i server locali la chiave e' facoltativa; non vengono riutilizzate automaticamente le credenziali OpenAI.

Imposta la finestra di contesto effettivamente configurata sul server, non il massimo teorico del modello; il valore prudenziale iniziale e' 4096 token. La soglia di compressione usa il 60% della finestra nota, fino al limite preesistente di 50.000 token; la stima dei token rimane approssimativa.

Ollama deve essere gia' avviato. Scarica i modelli esternamente, ad esempio:

```sh
ollama pull qwen3:8b
```

`/models` recupera i cataloghi via API e permette la ricerca per nome o ID. I cataloghi restano in memoria; `/models refresh` li ricarica. Se un provider fallisce, viene mostrato l'errore e gli altri rimangono disponibili. Puoi inserire manualmente un ID e la sua finestra di contesto quando il catalogo non e' disponibile.

I modelli senza tool calling dichiarato vengono esclusi o rifiutati alla selezione. Dove il catalogo non dichiara questa capacita', viene mostrato un avviso: la compatibilita' non e' garantita. Per Ollama viene interrogato anche `/api/show`.

Il reasoning usa i metadati disponibili e una piccola mappa di modelli documentati per i provider che non espongono i livelli. I modelli sconosciuti mantengono i default del provider (`N/A` nel footer). Le opzioni possono essere livelli, on/off oppure budget espliciti in token, secondo provider, modello e versione del server. Cambiando modello, una scelta non compatibile torna a `Default` con avviso. `Alt+R` non cambia impostazioni durante generazioni o approvazioni.

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

- `/login`: configura o aggiorna le credenziali di un provider.
- `/models [refresh]`: seleziona provider e modello; `refresh` aggiorna i cataloghi.
- `/new`, `/sessions`, `/restore <id>`: crea, seleziona o ripristina una sessione.
- `/compress`: comprime la cronologia attiva.
- `/skills`: elenca le skill; `/verbose`: mostra o nasconde i dettagli dei tool.
- `/quit` o `/exit`: chiude la CLI.
- `Enter` invia, `Alt+Enter` inserisce una riga, `Alt+R` seleziona il reasoning al prompt della chat, `Ctrl+C` interrompe la richiesta corrente.

**Workflow**

- `/flow:explore <idea>`: esplora un'idea senza implementarla.
- `/flow:propose <richiesta>`: prepara una change e il relativo piano.
- `/flow:update <modifica>`: aggiorna il piano; `/flow:apply` lo approva e avvia il lavoro.
- `/flow:review`: richiede una review; `/flow:list` elenca le change.
- `/flow:resume [id]`: riprende una change; `/flow:pause` la sospende.
- `/flow:end`: chiude la change corrente.
