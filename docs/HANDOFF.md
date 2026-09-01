# ModelDock - Project handoff

Questo documento serve a riprendere il progetto da un'altra chat o da un'altra sessione senza perdere il contesto decisionale.

Ultimo aggiornamento: 2026-09-02.

Aggiornamento distribuzione: Open WebUI usa runtime pack preconfezionati per Windows x64, Mac Apple Silicon e Mac Intel. I pack vivono nelle GitHub Releases, vengono verificati tramite SHA-256 e hanno il vecchio installer `uv` come fallback. Il workflow è `.github/workflows/openwebui-runtime.yml`; il downloader è `apps/api/src/openwebui-runtime.ts`.

## Obiettivo del prodotto

ModelDock è una dashboard web open source per trasformare una macchina locale in un piccolo AI server gestibile anche da persone non tecniche.

L'idea centrale è unire in un unico pannello:

- Ollama, per scaricare, caricare, scaricare dalla memoria, cancellare e monitorare modelli locali;
- Tailscale, per rendere il server raggiungibile da altri dispositivi in modo privato e sicuro;
- Open WebUI, come superficie chat già pronta, mentre ModelDock rimane il control plane;
- onboarding guidato, per distinguere chiaramente cosa deve fare chi configura il server e cosa deve fare chi usa un dispositivo client;
- diagnostica e observability, per capire se ogni integrazione funziona senza dover aprire terminali o file di configurazione sparsi.

La destinazione è open source: ModelDock deve diventare un progetto pubblico, leggibile, installabile e comprensibile, utile sia come tool reale sia come biglietto da visita tecnico. Il codice deve restare semplice, modulare, testabile e documentato; l'interfaccia deve essere pulita, calma, non intimidatoria e orientata all'azione.

## Visione UX

ModelDock non deve sembrare un pannello tecnico pieno di rumore.

La direzione scelta è:

- pochi dati per schermata;
- informazioni operative solo quando servono;
- gerarchia visiva netta;
- card morbide e leggibili;
- layout arioso;
- stile glassmorphism leggero;
- modalità chiara calda e modalità scura grigio/vetro;
- onboarding a prova di principiante.

Le pagine principali sono:

- Home: riassunto dello stato del server AI;
- Models: gestione Ollama;
- Devices: gestione dispositivi Tailscale;
- Usage: accesso e condivisione Open WebUI;
- Onboarding: percorso server e percorso client;
- Settings: preferenze locali, nome server, URL chat, tema;
- Diagnostics: controlli tecnici più espliciti, tenuti separati dalla home per non creare rumore.

## Architettura scelta

Il progetto è un monolite TypeScript modulare.

Struttura:

```text
apps/
  api/       Backend Fastify
  web/       Frontend React/Vite

packages/
  auth/
  core/
  diagnostics/
  observability/
  ollama-adapter/
  storage/
  tailscale-adapter/
  testing/
```

Regole architetturali importanti:

1. La UI non deve parlare direttamente con Ollama, Tailscale o Open WebUI.
2. Il backend è il punto unico per adapter, validazione, errori, diagnostica e policy.
3. Le integrazioni esterne devono stare dietro adapter sostituibili.
4. Ogni feature deve avere stati chiari: loading, empty, success, failure.
5. Ogni feature importante deve essere testabile senza servizi reali, tramite fake gateway.
6. Le credenziali restano server-side in `.env` e non vanno mai committate.

## Stato Git rilevante

Branch principale:

```text
master
```

Branch visuale corrente:

```text
visual-direction-soft-dashboard
```

Commit importanti:

```text
c17e2ce Initial ModelDock MVP
ce62a24 Refactor web structure and server config
d62c7c3 Explore soft dashboard visual direction
4412284 Add warm glass visual treatment
e37c775 Refine gradient background and dark glass theme
185a4d7 Improve glass button contrast
```

La direzione visuale glassmorphism è stata volutamente lavorata su branch separato per poter tornare alla versione più sobria se necessario.

## Stato implementato

### Ollama / Models

La parte Ollama è la più matura del progetto.

Implementato:

- check reale di disponibilità Ollama;
- lettura modelli scaricati tramite `GET /api/tags`;
- lettura modelli caricati in memoria tramite `GET /api/ps`;
- pull modello con feedback di avanzamento;
- gestione pull fallito senza falso messaggio di successo;
- box feedback non modificabile;
- bottone Clear per pulire input, feedback e barra;
- delete modello;
- load modello tramite API Ollama;
- unload modello tramite API Ollama;
- refresh runtime per riallineare ModelDock se un modello è stato caricato fuori dalla dashboard;
- label RAM fit:
  - Usable;
  - Risk overload;
  - Too big;
- switch visivi per Loaded / Enabled;
- matrice permessi gruppi con checkbox:
  - Admins;
  - Builders;
  - Guests.

Decisione importante:

ModelDock non legge direttamente la cartella:

```text
C:\Users\Simone\.ollama\models\...
```

Usa invece le API ufficiali di Ollama:

```text
http://127.0.0.1:11434/api/tags
http://127.0.0.1:11434/api/ps
```

Questo è più robusto e più portabile. La lettura diretta dei manifest può essere fragile, perché il path può cambiare con sistema operativo, configurazione, variabili ambiente o installazioni diverse.

Test reale già fatto sulla macchina di Simone:

- Ollama vedeva correttamente:
  - `gpt-oss:latest`;
  - `phi3:3.8b`;
  - `gemma3:270m`;
- `phi3:3.8b` è stato caricato realmente;
- `Invoke-RestMethod http://127.0.0.1:11434/api/ps` ha confermato il modello in memoria;
- `tinyllama:latest` è stato pullato correttamente;
- l'ultimo problema sui modelli non visibili era dovuto al backend ModelDock spento sulla porta `4317`, non a Ollama.

### Tailscale / Devices

Implementato:

- pagina dedicata `Devices`;
- card stato Tailscale in Home;
- integrazione via Tailscale API;
- lettura dispositivi del tailnet;
- stato online/offline;
- stato active/authorized;
- refresh dispositivi;
- helper per invitare un nuovo device;
- conferma prima di disabilitare un device.

Test reale già fatto:

- token Tailscale inserito in `.env`;
- API Tailscale raggiunta correttamente;
- ModelDock ha letto dispositivi reali dal tailnet.

Nota concettuale:

Tailscale va installato anche sui client. ModelDock può guidare il processo, generare link e testi di invito, verificare che il device sia comparso, ma non può magicamente installare Tailscale su un altro dispositivo senza azione lato client.

### Open WebUI / Usage

Implementato a livello MVP:

- pagina `Usage`;
- URL chat configurabile;
- bottone per copiare/condividere URL;
- health check base di Open WebUI;
- mappa manuale tra:
  - device;
  - utente Open WebUI;
  - gruppo/modelli consentiti.

Decisione importante:

Per ora Open WebUI rimane la chat UI. ModelDock non prova a sostituirla.

ModelDock è il pannello di controllo intorno alla chat: modelli, dispositivi, accessi, onboarding, diagnostica e condivisione.

### Onboarding

Implementato:

- pagina dedicata `Onboarding`;
- separazione concettuale tra:
  - setup server;
  - invito client;
- testo copiabile per mandare al client istruzioni/link;
- direzione UX pensata per utenti principianti.

Direzione desiderata:

- schede molto pulite;
- una sola azione principale per step;
- testo centrale chiaro;
- CTA sotto il testo;
- stato verificabile dopo ogni azione;
- nessun mix confuso tra compiti del server e compiti del client.

### Settings

Implementato:

- nome server modificabile;
- URL Open WebUI modificabile;
- tema chiaro/scuro;
- impostazioni salvate lato browser.

Da valutare:

- rendere alcune impostazioni persistenti lato backend;
- aggiungere impostazioni per URL pubblico/privato del server;
- aggiungere preferenze onboarding;
- aggiungere configurazione esplicita provider.

### Diagnostics / Observability / Testing

Implementato:

- pagina Diagnostics separata dalla Home;
- check fondazionali;
- pacchetto `observability`;
- diagnostica backend;
- test unitari su core behavior;
- test adapter;
- test API;
- test e2e Playwright.

Comandi di verifica usati nel progetto:

```powershell
pnpm test
pnpm lint
pnpm build
pnpm test:e2e
```

In alcune sessioni, per evitare problemi del sandbox con pnpm, sono stati usati anche i binari locali:

```powershell
.\node_modules\.bin\vitest.cmd run --config vitest.config.mjs --configLoader runner
.\node_modules\.bin\tsc.cmd -p apps\api\tsconfig.json --noEmit
.\node_modules\.bin\tsc.cmd -p apps\web\tsconfig.json --noEmit
```

## Configurazione locale

Il progetto usa `.env`.

File template:

```text
.env.example
```

Chiavi principali:

```env
MODELDOCK_API_HOST=127.0.0.1
MODELDOCK_API_PORT=4317

MODELDOCK_OLLAMA_MODE=auto
MODELDOCK_OLLAMA_BASE_URL=http://127.0.0.1:11434

MODELDOCK_TAILSCALE_MODE=api
MODELDOCK_TAILSCALE_TAILNET=-
MODELDOCK_TAILSCALE_API_BASE_URL=https://api.tailscale.com/api/v2
MODELDOCK_TAILSCALE_API_TOKEN=

MODELDOCK_OPENWEBUI_BASE_URL=
```

Attenzione:

- non committare `.env`;
- non stampare token in chat;
- eventuali file locali con API key o segreti non devono entrare nella repo pubblica.

## Porte locali

Porte usate durante lo sviluppo:

```text
Ollama:             http://127.0.0.1:11434
ModelDock API:      http://127.0.0.1:4317
ModelDock web dev:  http://127.0.0.1:5173
ModelDock preview:  http://127.0.0.1:4173
Open WebUI:         di solito http://127.0.0.1:3000
```

Nota pratica:

Se la UI non vede i modelli ma Ollama sì, controllare prima che il backend ModelDock sia acceso su `4317`.

Check utili:

```powershell
Invoke-RestMethod http://127.0.0.1:11434/api/tags
Invoke-RestMethod http://127.0.0.1:11434/api/ps
Invoke-RestMethod http://127.0.0.1:4317/api/integrations/ollama/status
Invoke-RestMethod http://127.0.0.1:4317/api/models
Invoke-RestMethod http://127.0.0.1:4173/api/models
```

## Cosa manca prima di una prima repo pubblica

### Priorità alta

- Ripulire eventuali file locali sensibili prima della pubblicazione.
- Verificare `.gitignore`.
- Aggiornare README con istruzioni precise per Windows.
- Rendere chiaro lo stato “MVP preview” del progetto.
- Decidere se pubblicare il branch visuale o fare merge su `master`.
- Eseguire test completi.
- Creare screenshot puliti per README.
- Aggiungere una sezione “Security / tokens”.

### Priorità prodotto

- Completare la UX Devices:
  - copia invito più chiara;
  - stato “device in attesa”;
  - spiegazione beginner-friendly del flusso client;
  - differenza tra device online, autorizzato e pronto all'uso.
- Raffinare Usage/Open WebUI:
  - distinguere link chat locale e link chat via Tailscale;
  - chiarire che gli utenti Open WebUI vanno creati/gestiti lì finché non esiste sync;
  - preparare una futura associazione persistente device -> utente Open WebUI -> gruppo modelli.
- Migliorare onboarding:
  - percorso Server;
  - percorso Client;
  - copy-to-client message;
  - check automatici dopo ogni step.

### Priorità tecnica

- Persistenza reale invece dello storage in-memory.
- Modello utenti/gruppi persistente.
- Adapter Open WebUI più profondo, se API disponibili e stabili.
- Adapter LM Studio separato, se si decide di supportare modelli esterni a Ollama.
- Telemetria GPU tramite adapter dedicati.
- Packaging/installazione semplificata per utenti non tecnici.

## LM Studio

LM Studio non è ancora integrato.

I modelli in:

```text
.lmstudio\hub\models\
```

non appaiono nella pagina Models perché ModelDock in questa fase legge Ollama, non il filesystem di LM Studio.

Possibile direzione futura:

- aggiungere `lmstudio-adapter`;
- leggere il catalogo locale LM Studio se disponibile;
- mostrare la provenienza del modello:
  - Ollama;
  - LM Studio;
  - Hugging Face cache;
- evitare di mischiare modelli non eseguibili dallo stesso runtime.

## Decisioni da non perdere

- Il prodotto deve restare semplice, non “enterprise” prima del tempo.
- La Home deve essere un riassunto, non un centro diagnostico rumoroso.
- I dettagli tecnici devono vivere in Diagnostics.
- La gestione modelli Ollama è quasi chiusa per l'MVP.
- Devices/Tailscale e Usage/Open WebUI sono i prossimi blocchi da chiudere.
- L'onboarding è fondamentale per rendere ModelDock diverso da un semplice pannello tecnico.
- Open WebUI per ora non va sostituito: va orchestrato e reso più facile da usare.
- Le API reali devono convivere con fake gateway per test affidabili.
- La UX deve guidare l'utente: una schermata, un'intenzione, un'azione chiara.

## Come riprendere il lavoro in una nuova chat

Prompt consigliato:

```text
Leggi docs/HANDOFF.md, README.md, docs/MVP.md e docs/ARCHITECTURE.md.
Siamo sul progetto ModelDock in outputs/modeldock.
Riprendi dal branch visual-direction-soft-dashboard.
Prima verifica stato git, server API su 4317 e preview web su 4173.
Non stampare .env o token.
Continuiamo a chiudere MVP open source con codice semplice, testabile e UI pulita.
```

Comandi iniziali utili:

```powershell
git status --short --branch
git log --oneline --decorate -5
Invoke-RestMethod http://127.0.0.1:4317/api/integrations/ollama/status
Invoke-RestMethod http://127.0.0.1:4317/api/models
```

Se il backend non è acceso:

```powershell
$env:PATH = "C:\Users\Simone\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;" + $env:PATH
node --experimental-strip-types apps/api/src/server.ts
```

## Definizione di successo MVP

ModelDock MVP è chiuso quando un utente può:

1. avviare ModelDock su una macchina server;
2. vedere se Ollama, Tailscale e Open WebUI sono disponibili;
3. vedere i modelli Ollama installati;
4. pullare un modello;
5. caricare/scaricare un modello dalla memoria;
6. cancellare un modello;
7. vedere i device Tailscale;
8. invitare un nuovo client con istruzioni chiare;
9. copiare/condividere il link Open WebUI;
10. capire cosa non funziona tramite Diagnostics;
11. seguire una guida server/client senza sapere già come funzionano Ollama e Tailscale.

Quando questi punti sono solidi, si può preparare la repo pubblica.
