# mods

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat)](./LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude_Code-%E2%89%A5_2.1.287-d97757?style=flat)](https://code.claude.com/docs/en/plugins/mods/overview)
[![Mods](https://img.shields.io/badge/Mods-6-3178c6?style=flat)](#le-sei-mod)

Un marketplace di mod per Claude Code, pensato per capire e controllare una sessione: barra della cache e dei consumi, registro di ciò che viene scritto fuori dalla repo, conferma delle proposte, raccolta degli inciampi, modalità rec per le registrazioni e inbox con bozze, etichette e task. Ogni mod è un plugin indipendente, installabile singolarmente con un comando.

---

## Le sei mod

Ogni mod si accende e si spegne con un comando `/...`, che funziona in terminale, nell'app Desktop e da iPad. Lo stato si ricorda tra una sessione e l'altra.

**⏳ barra-cache** (`/barra`) — tre righe sopra il prompt. La prima è la *memoria della chat*: una barra con i token del contesto occupato e quanto è costata la sessione a listino (verde fino al 60%, gialla fino all'80%, rossa oltre, con il suggerimento Nuova chat). La seconda mostra l'*uso delle 5 ore* e l'*uso della settimana* dell'abbonamento, solo dove il motore riporta le cifre. La terza dice da quanto è aperta la sessione e quanto resta di *cache calda*: la prompt cache dura un'ora dall'ultima richiesta della conversazione principale (le richieste dei subagent non la rinnovano), poi la richiesta successiva riscrive tutto il contesto a prezzo pieno. Con la cache scaduta e almeno 20mila token di contesto compare un avviso rosso. Sotto, una riga con branch, file modificati e commit da pubblicare (letta da git, solo dove `$.process` esiste: nel cloud non compare) e i bottoni: **Commit e push** (tasto `g`), **Push** (tasto `p`, compare solo quando ci sono commit da pubblicare e nessuna modifica da committare, senza token) e **Nuova chat** (tasto `n`), che fa scrivere al modello un riassunto di ripartenza in `~/.claude/handoffs/`, svuota la chat con `/clear` e riparte da quel file. Dove la banda non viene disegnata (ad esempio l'app su iPad) restano `/cache`, che mostra minuti rimasti, contesto, costo dell'ultimo turno e quota di cache letta, `/push` e `/nuova`.

**📒 scritture-esterne** (`/scritture`) — a fine turno elenca tutto ciò che il turno ha scritto fuori dalla repo: Notion, Postpickr, Spreaker, Gmail, Calendar, Drive, `git push`, `gh`, `curl -X POST` e gli script con `--applica` o `--elimina`. Ogni riga ha servizio, azione, bersaglio, un link `apri` se la risposta ne contiene uno, e una croce rossa se la chiamata è fallita o negata. Le letture non compaiono. Il registro sparisce all'inizio del turno successivo. Riconosce dal nome i connettori più comuni; per quelli con id opaco serve l'opzione `servizi` del plugin.

**✅ conferma-proposte** (`/conferma`) — quando l'ultima risposta di Claude chiude con una proposta o una domanda di conferma (una domanda, oppure formule come "procedo", "vuoi che", "confermi"), mostra sopra il prompt il passaggio che propone e due bottoni: `Sì, procedi` (tasto `s`) e `No, fermati` (tasto `x`). Il bottone invia la risposta come se l'avessi scritta tu. Non usa il modello, quindi non consuma token. Funziona anche nel cloud e da iPad.

**🛠 correggi** (`/correggi`) — durante la sessione annota gli inciampi: tool che falliscono, azioni negate dal sistema di permessi e le tue correzioni ("non vedo", "hai sbagliato", "riprova"). Con almeno due inciampi compare una riga con il conteggio, le skill usate e il bottone `Proponi correzione` (tasto `l`), che chiede a Claude di individuare la causa e proporre la modifica esatta alla skill o al file di istruzioni, senza applicarla. `/correggi elenco` mostra gli inciampi raccolti. Consuma token solo quando premi il bottone.

**🔴 rec** (`/rec`) — la modalità per registrare un video o lavorare in una sessione live con ospiti. Maschera a schermo chiavi e valori dei `.env`, email, nomi, telefoni, indirizzi, codice fiscale, partita IVA, IBAN, importi in euro e cifre vicino a parole come fatturato, margine, compenso, preventivo. I risultati di posta, chat, task, file, calendario, Notion e strumenti di pagamento si disegnano nascosti. Claude continua a lavorare sui dati reali: cambia solo ciò che si vede (se modifica un file da 29 a 39 euro, il file cambia davvero, lo schermo no). Tiene chiusi i file privati (`.env`, credenziali, fatture, contratti, preventivi, buste paga) e gli strumenti di pagamento, e ogni prompt porta una nota nascosta che chiede a Claude di usare segnaposto al posto di nomi e cifre. Un ● REC rosso sopra il prompt e nel piè di pagina ricorda che è acceso. `/rec` alterna, `/rec rigoroso` maschera anche ogni cifra grande, `/rec off` spegne, `/rec config` crea `~/.claude/mods-data/rec/config.json` per il tuo nome (`nomiVisibili`), le persone da nascondere (`nomiNascosti`), le cartelle private (`percorsiPrivati`) e gli strumenti extra (`strumentiAffari`, `strumentiChiusi`). Limiti: cambia ciò che è disegnato, non ciò che è memorizzato; il riconoscimento per pattern non prende tutto quello che è scritto a parole, quindi riguarda il girato prima di pubblicarlo; i titoli delle chat nella barra laterale dell'app Desktop non si possono mascherare. Adattata da `recording-mode` di Nate Herk (MIT, vedi `rec/NOTICE.md`).

**📬 posta** (`/posta`) — apre sopra il prompt la inbox Gmail (12 mail per account, mittente, oggetto, ora) con la scheda della mail selezionata (`j`/`k` per scorrere) e quattro bottoni: **Bozza** (`b`), **Label** (`l`), **Bozza+Label** (`m`) e **Task** (`t`). L'elenco e l'anteprima vengono dal connettore Gmail senza modello; le quattro azioni inviano un prompt al modello, che scrive la bozza con le regole di `~/.claude/mods-data/posta/sistematore.md` (solo il blocco "Email ottimizzata", la mail non viene mai inviata), sceglie l'etichetta più pertinente tra quelle esistenti (non ne crea) o crea il task nel database Tasks di Notion con data e ora. Label, Bozza+Label e Task archiviano la mail; Bozza la lascia in inbox. Gli account sono in `DEFAULT_ACCOUNTS` e si sostituiscono con la chiave `accounts` dello store. `/posta aggiorna` rilegge la inbox.

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
   claude plugin install barra-cache@andrea-mods
   claude plugin install scritture-esterne@andrea-mods
   claude plugin install conferma-proposte@andrea-mods
   claude plugin install correggi@andrea-mods
   claude plugin install rec@andrea-mods
   claude plugin install posta@andrea-mods
   ```

3. Avvia una nuova sessione con `claude`.

Verifica: apri `/plugin` e controlla che le mod risultino attive. Per provare una mod in una sola sessione senza installarla, clona la repo e avvia `claude --plugin-dir ./mods/barra-cache`. Per disattivarla, usa il tab **Installed** di `/plugin`.

---

## Uso in cloud e da iPad

Le sessioni cloud (claude.ai/code, app per iPad) non leggono le tue impostazioni locali: partono da un contenitore pulito e caricano i plugin dichiarati nella repo su cui lavori. Per attivare una mod in una repo, aggiungi a `.claude/settings.json` di quella repo:

```json
{
  "extraKnownMarketplaces": {
    "andrea-mods": { "source": { "source": "github", "repo": "andreabrugnoli/mods" } }
  },
  "enabledPlugins": { "barra-cache@andrea-mods": true, "rec@andrea-mods": true }
}
```

Lo fa per te `scripts/abilita-cloud.sh <percorso-repo> [mod ...]`, che unisce la voce alle impostazioni esistenti. Se il tuo gitignore (anche globale) esclude `.claude/settings.json`, aggiungilo con `git add -f .claude/settings.json`, poi commit e push. La sessione cloud legge il file dal branch.

Su iPad la banda sopra il prompt può non essere disegnata: restano `/cache`, `/push` e `/nuova`, e tutti i comandi on/off (`/barra`, `/scritture`, `/conferma`, `/correggi`, `/rec`) funzionano uguale. Lo stato (`$.store`) e i riassunti in `~/.claude/handoffs/` vivono nel contenitore della sessione e si perdono alla sua chiusura.

---

## Comandi disponibili

Accendere e spegnere (senza argomento alternano; accettano anche `on` e `off`):

- `/barra`: la barra sopra il prompt.
- `/scritture`: il registro delle scritture esterne.
- `/conferma`: i bottoni Sì e No sulle proposte.
- `/correggi`: la raccolta degli inciampi (`/correggi elenco` li mostra).
- `/rec`: la modalità registrazione (`/rec rigoroso`, `/rec off`, `/rec config`).
- `/posta`: la inbox con i bottoni Bozza, Label e Task (`/posta aggiorna`, `/posta off`).

Altri comandi di barra-cache:

- `/cache`: minuti di cache rimasti, contesto occupato, costo dell'ultimo turno e quota di cache letta.
- `/push`: pubblica i commit del branch corrente.
- `/nuova`: riassume la sessione in un file e riparte da una chat pulita.

---

## Personalizzazione

**Durata della cache** in `barra-cache`: parte da un'ora (`TTL_MS`) e si corregge da sola. Dopo una pausa di almeno 6 minuti guarda la quota di cache letta: se la cache è stata riscritta, passa a 5 minuti e lo ricorda tra le sessioni; se è stata letta, conferma l'ora.

**Soglie dei colori** in `barra-cache`: `CONTEXT_WARN`, `CONTEXT_BAD`, `COST_WARN`, `CACHE_OK` e `CACHE_BAD`, in cima allo stesso file.

**Nomi dei connettori** in `scritture-esterne`: opzione `servizi` del plugin.

Per modificare una mod, clona la repo e caricala con `claude --plugin-dir`: ogni salvataggio ricarica il modulo nella sessione aperta.

---

## Struttura del progetto

```
mods/
├── .claude-plugin/marketplace.json   # elenco delle mod installabili
├── barra-cache/
├── scritture-esterne/
├── conferma-proposte/
├── correggi/
├── rec/
├── posta/
└── scripts/abilita-cloud.sh
```

Ogni cartella di mod è un plugin completo: `.claude-plugin/plugin.json`, `hooks/hooks.json`, `hooks/register.js` e `tests/` (eseguibili con `claude plugin test ./<mod>`). `claude plugin validate ./<mod>` elenca gli eventi intercettati e le chiamate al motore.

---

Licenza: [MIT](./LICENSE).
