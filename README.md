# mods

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat)](./LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude_Code-%E2%89%A5_2.1.287-d97757?style=flat)](https://code.claude.com/docs/en/plugins/mods/overview)
[![Mods](https://img.shields.io/badge/Mods-2-3178c6?style=flat)](#le-due-mod)

Un marketplace di mod per Claude Code, pensato per capire e controllare cosa consuma una sessione: barra della prompt cache, contesto occupato, costo del turno, durata della sessione, stato della repo e registro di ciò che viene scritto fuori dalla repo. Ogni mod è un plugin indipendente, installabile singolarmente con un comando.

---

## Le due mod

**⏳ cache-meter** — una riga sopra il prompt con una barra che si svuota nel tempo: indica quanto resta dell'ora di prompt cache dall'ultima richiesta della conversazione principale. Verde oltre i 20 minuti, gialla oltre i 5, rossa sotto; allo scadere segnala che la richiesta successiva riscriverà la cache. Le richieste dei subagent non rinnovano la barra, perché usano una cache separata. Sulla stessa riga della cache, a destra, il `contesto`, il turno e la cache letta: la riga va a capo da sola solo quando manca lo spazio. Il contesto: (barra e percentuale della finestra, verde fino al 60%, gialla fino all'80%, rossa oltre, con il suggerimento Nuova chat), `sessione` (durata dall'inizio della sessione, ad esempio `2h 14m`), `turno` (costo in dollari dell'ultimo turno, giallo da 0,50, più i token pagati interi e quelli generati dal modello) e `cache letta` (quota dell'ultima richiesta servita dalla cache: verde da 80%, gialla da 50%, rossa sotto). Le cifre vengono dal motore (`session.measure`), quindi non costano token; dove il motore non le riporta la riga non compare. Poi una riga con branch, file modificati e commit da pubblicare (letta da git, solo dove `$.process` esiste: nel cloud non compare) e i bottoni: **Commit e push** (tasto `g`) fa commit e push sul branch corrente; **Push** (tasto `p`) compare solo quando non ci sono modifiche da committare ma ci sono commit da pubblicare, e fa `git push` direttamente, senza token; **Nuova chat** (tasto `n`) fa scrivere al modello un riassunto di ripartenza in `~/.claude/handoffs/`, svuota la chat con `/clear` e riparte da quel file, così il contesto non si trascina e la cache si riscrive una volta sola. Commit e Nuova chat inviano un prompt e consumano token; spariscono mentre il modello lavora. Dove la banda non viene disegnata (ad esempio l'app su iPad) restano i comandi `/cache`, che mostra i minuti rimasti e le stesse cifre di contesto, turno e cache letta, `/push`, che pubblica i commit, e `/nuova`, che avvia il passaggio a una chat pulita.

**📒 registro-scritture** — a fine turno elenca tutto ciò che il turno ha scritto fuori dalla repo: Notion, Postpickr, Spreaker, Gmail, Calendar, Drive, `git push`, `gh`, `curl -X POST` e gli script con `--applica` o `--elimina`. Ogni riga ha servizio, azione, bersaglio, un link `apri` se la risposta ne contiene uno, e una croce rossa se la chiamata è fallita o negata. Le letture non compaiono. Il registro sparisce all'inizio del turno successivo. Riconosce dal nome i connettori più comuni (Notion, Spreaker, Postpickr, Gmail, Calendar, Drive, Vercel, Stripe, GitHub, Slack, Linear); per quelli con id opaco, che altrimenti compaiono come i primi otto caratteri dell'id, c'è l'opzione `servizi` con coppie `id=Nome` separate da virgola (nel menu di configurazione del plugin). Funziona anche nelle sessioni cloud perché non usa processi locali.

---

## Prerequisiti

- **Claude Code 2.1.287 o successivo**: le mod sono attive di default da questa versione. Verifica con `claude --version`.
- **Terminale o tab Code dell'app Desktop**: le sessioni WSL nell'app Desktop non eseguono le mod.

Una mod è codice eseguito con i tuoi permessi: può leggere e scrivere file, avviare processi e vedere prompt e tool call della sessione. Il sorgente di ogni mod è in `hooks/`: leggilo prima dell'installazione.

---

## Installazione

1. Aggiungi il marketplace a Claude Code:

   ```bash
   claude plugin marketplace add andreabrugnoli/mods
   ```

2. Installa le mod che ti interessano, una per comando:

   ```bash
   claude plugin install cache-meter@andrea-mods
   claude plugin install registro-scritture@andrea-mods
   ```

3. Avvia una nuova sessione con `claude`.

Verifica: apri `/plugin` e controlla che le mod risultino attive. Per provare una mod in una sola sessione senza installarla, clona la repo e avvia `claude --plugin-dir ./mods/cache-meter`. Per disattivarla, usa il tab **Installed** di `/plugin`.

---

## Uso in cloud e da iPad

Le sessioni cloud (claude.ai/code, app per iPad) non leggono le tue impostazioni locali: partono da un contenitore pulito e caricano i plugin dichiarati nella repo su cui lavori. Per attivare una mod in una repo, aggiungi a `.claude/settings.json` di quella repo:

```json
{
  "extraKnownMarketplaces": {
    "andrea-mods": { "source": { "source": "github", "repo": "andreabrugnoli/mods" } }
  },
  "enabledPlugins": { "cache-meter@andrea-mods": true }
}
```

Lo fa per te `scripts/abilita-cloud.sh <percorso-repo> [mod ...]`, che unisce la voce alle impostazioni esistenti. Se il tuo gitignore (anche globale) esclude `.claude/settings.json`, aggiungilo con `git add -f .claude/settings.json`, poi commit e push. La sessione cloud legge il file dal branch.

Su iPad la banda sopra il prompt può non essere disegnata: restano `/cache` e `/nuova`. Lo stato (`$.store`) e i riassunti in `~/.claude/handoffs/` vivono nel contenitore della sessione e si perdono alla sua chiusura.

---

## Comandi disponibili

- `/cache`: minuti di cache rimasti, contesto occupato, costo dell'ultimo turno e quota di cache letta.
- `/push`: pubblica i commit del branch corrente.
- `/nuova`: riassume la sessione in un file e riparte da una chat pulita.

---

## Personalizzazione

**Durata della cache** in `cache-meter`: la costante `TTL_MS` in `cache-meter/hooks/register.js` vale un'ora, la durata della prompt cache negli abbonamenti Claude. Se la tua cache dura 5 minuti, imposta `5 * 60 * 1000`.

**Soglie dei colori** in `cache-meter`: `CONTEXT_WARN`, `CONTEXT_BAD`, `COST_WARN`, `CACHE_OK` e `CACHE_BAD`, in cima allo stesso file.

**Nomi dei connettori** in `registro-scritture`: opzione `servizi` del plugin.

Per modificare una mod, clona la repo e caricala con `claude --plugin-dir`: ogni salvataggio ricarica il modulo nella sessione aperta.

---

## Struttura del progetto

```
mods/
├── .claude-plugin/marketplace.json   # elenco delle mod installabili
├── cache-meter/
├── registro-scritture/
└── scripts/abilita-cloud.sh
```

Ogni cartella di mod è un plugin completo: `.claude-plugin/plugin.json`, `hooks/hooks.json`, `hooks/register.js` e `tests/` (eseguibili con `claude plugin test ./<mod>`). `claude plugin validate ./<mod>` elenca gli eventi intercettati e le chiamate al motore.

---

Licenza: [MIT](./LICENSE).
