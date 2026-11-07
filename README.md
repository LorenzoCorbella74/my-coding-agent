# Corbe Code

Corbe Code è un coding agent da terminale, realizzato in TypeScript con Vercel AI SDK e OpenRouter. Mantiene la conversazione durante la sessione, usa tool per esplorare e modificare il workspace.

## Configurazione

Richiede Node.js 22 o successivo e npm. Crea un file `.env` nella directory da cui lancerai CorbeAgent:

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

Le sessioni sono salvate come JSONL in `.corbeagent/sessions/`; `.corbeagent/active-session` contiene i metadati JSON di tutte le sessioni (ID attivo, data di creazione, tool approvati e titolo). Il vecchio puntatore testuale viene migrato automaticamente. `.corbeagent/.gitignore` esclude questi dati dal versionamento.

## Funzionamento

All'avvio Corbe Code mostra nome, versione e modello. Se presente, `AGENTS.md` nella root del workspace viene aggiunto al contesto del modello. Prima di eseguire `shell`, `edit_file` o `write_file`, Corbe Code mostra l'azione proposta e chiede conferma; è possibile approvare una singola azione, rifiutarla o accettare sempre le modifiche per il workspace nella sessione corrente. L'accettazione persistente è salvata nei metadati della sessione e resta valida dopo il riavvio. Gli altri tool non modificano il workspace e vengono eseguiti senza conferma. Ogni richiesta viene inviata al modello insieme alla cronologia della sessione e ai tool disponibili. Se il modello invoca un tool, il programma registra nome, input, esito e durata; gli output dei log sono limitati a 500 caratteri. A fine risposta mostra l'utilizzo dei token.

Il modello usa `ask_user_input` solo quando manca un'informazione decisiva che non può ricavare dal workspace. I prompt condividono l'input del terminale con la chat; scelte invalide vengono ripetute e i default devono corrispondere a una delle opzioni.

## Sessioni

All'avvio viene ripresa automaticamente l'ultima sessione attiva. I comandi disponibili sono:

- `/new`: crea e attiva una nuova sessione.
- `/sessions`: elenca le sessioni con ID breve, ultima modifica e anteprima del primo messaggio.
- `/restore <sessionId>`: riprende una sessione usando l'ID breve mostrato nell'elenco; sono richiesti almeno 8 caratteri.
- `/compress`: comprime solo la sessione attiva e sostituisce il suo JSONL con il riepilogo; la cronologia originale rimossa non viene conservata.
- `/quit` e `/exit`: chiudono la chat. Restano supportati anche `quit` ed `exit` senza slash.

## Tool

- `explore_workspace`: elenca file e directory senza leggerne il contenuto. Supporta root, glob, tipo, profondità, esclusioni e limite risultati. Esclude cartelle comuni di dipendenze/build e applica le esclusioni derivate da `.gitignore`.
- `searchCode`: cerca testo letterale o regex e restituisce percorso, righe e contesto. Supporta root, glob, maiuscole/minuscole, righe di contesto e limite risultati; ignora file oltre 2 MB. È implementato con API Node e non richiede `ripgrep`.
- `read_file` e `read_files`: leggono uno o più file nel workspace. La lettura multipla accetta fino a 20 percorsi; l'output è limitato a 50.000 caratteri.
- `shell`: esegue comandi nella root del workspace, tramite PowerShell su Windows e `sh` sugli altri sistemi. I comandi possono modificare file; il tool non è una sandbox.
- `write_file` e `edit_file`: creano/sovrascrivono un file o sostituiscono le occorrenze del testo indicato.
- `ask_user_input`: raccoglie una risposta libera o una scelta. Richiede un terminale interattivo.

I percorsi dei tool di lettura e scrittura sono confinati al workspace. Esplorazione e ricerca sono in sola lettura.

## TODO

- [] [Usare Github copilot models](https://vercel.com/changelog/github-copilot-ai-sdk-harness-adapter)
