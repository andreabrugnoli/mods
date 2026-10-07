// Quante mail dell'inbox mostrare per account
const PAGE_SIZE = 12

// I colori del puntino di ogni account
const DOTS = ['cyan', 'magenta', 'yellow', 'green']

// Quante mail mostrare insieme nella lista: il resto scorre con j e k
const WINDOW = 5

// L'id del pannello e la parola che lo apre scrivendola nel prompt (senza barra, niente avviso dell'app)
const PANE = 'posta'

// I nomi con cui il connettore Gmail può comparire: cambiano da sessione a sessione
// (nome del connettore, nome con prefisso, id), quindi si provano in ordine
const GMAIL_SERVERS = ['Gmail', 'e14c09e8-d3bf-4f30-b839-ba795465d6b4', 'claude.ai Gmail', 'claude_ai_Gmail']

// Gli account: il connettore MCP che li legge (un nome o un elenco di nomi da provare)
// e un nome breve. Si sostituiscono scrivendo un elenco con la stessa forma nello
// store (chiave "accounts")
const DEFAULT_ACCOUNTS = [
  { name: 'hello', email: 'hello@andreabrugnoli.it', server: GMAIL_SERVERS },
]

// I nomi di connettore da provare per un account, il primo funzionante per primo
export function serverList(account) {
  const list = [].concat(account.resolved ?? [], account.server ?? [])
  return list.filter((name, i) => name && list.indexOf(name) === i)
}

// Chiama un tool provando i nomi di connettore del bersaglio (un account Gmail o Notion) uno dopo l'altro,
// e ricorda quello che risponde. Se nessuno risponde, l'errore riporta il motivo di ciascun tentativo
async function callServers($, account, tool, args) {
  const failures = []
  for (const server of serverList(account)) {
    try {
      const res = await $.mcp.call(server, tool, args)
      if (!res.isError) {
        account.resolved = server
        return res
      }
      failures.push(server + ': ' + String(res.content?.[0]?.text ?? 'errore').replace(/\s+/g, ' '))
    } catch (err) {
      failures.push(server + ': ' + String(err?.message ?? err).replace(/\s+/g, ' '))
    }
  }
  // I nomi di connettore inesistenti non dicono nulla: si mostra l'errore del connettore che ha risposto
  const real = failures.filter((f) => !/no connected MCP tool/i.test(f))
  return { isError: true, content: [{ type: 'text', text: (real.length ? real : failures).join(' | ') || 'nessun connettore trovato' }] }
}

// Il data source del database Tasks di Notion
const TASKS_DB = '1ee13fe7-1a52-8195-9008-000b5e44714d'

// Le regole di scrittura delle bozze, dentro la cartella home
const RULES_FILE = '/.claude/mods-data/posta/sistematore.md'

// Acceso o spento: lo decide /posta e resta nello store tra una sessione e l'altra
let enabled = false

// Lo stato della vista: gli account con le loro mail e la mail selezionata
let accounts = DEFAULT_ACCOUNTS
let boxes = []
let cursor = 0

// I lavori in background: ogni azione gira nella mod e riferisce qui, senza riempire la chat
// { label, status: 'corso' | 'fatto' | 'errore', note, box, mail, archived, action }
const jobs = []

// Il pannello mostra solo l'ultimo messaggio del thread; i precedenti si aprono a richiesta
let showOlder = false

// Spinner dei lavori in corso e durata dei lavori riusciti prima che spariscano dal pannello
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const DONE_VISIBLE_MS = 8000
let ticker = null

// Fa girare lo spinner finché c'è un lavoro in corso e fa sparire i lavori riusciti dopo qualche secondo
function tick($) {
  if (ticker) return
  ticker = setInterval(() => {
    const running = jobs.some((j) => j.status === 'corso')
    const fading = jobs.some((j) => j.status === 'fatto' && Date.now() - j.doneAt < DONE_VISIBLE_MS + 500)
    if (!running && !fading) {
      clearInterval(ticker)
      ticker = null
    }
    $.ui.invalidate('ui.render')
  }, 120)
}

// I testi già letti, per thread: undefined = non ancora chiesto, 'carico' = in arrivo
const bodies = new Map()

// Accorcia un testo su una riga
function clip(text, n) {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n - 1) + '…' : one
}

// Il nuovo stato dopo un comando: "on" apre, "off" chiude, senza argomento alterna
export function parseToggle(args, current) {
  const arg = String(args ?? '').trim().toLowerCase()
  if (/^(on|acceso|apri|attiva|si|sì)$/.test(arg)) return true
  if (/^(off|spento|chiudi|disattiva|no)$/.test(arg)) return false
  return !current
}

// L'ora locale di una data ISO in formato HH:MM, oppure il giorno se non è di oggi
export function formatWhen(iso, now = new Date()) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const two = (n) => String(n).padStart(2, '0')
  if (d.toDateString() === now.toDateString()) return two(d.getHours()) + ':' + two(d.getMinutes())
  return two(d.getDate()) + '/' + two(d.getMonth() + 1)
}

// La data per esteso: 7 ott 2026, 09:26
export function formatLong(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const two = (n) => String(n).padStart(2, '0')
  const months = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic']
  return d.getDate() + ' ' + months[d.getMonth()] + ' ' + d.getFullYear() + ', ' + two(d.getHours()) + ':' + two(d.getMinutes())
}

// Pulisce il testo di una mail: righe di asterischi o trattini ridotte, righe vuote ripetute tolte
export function cleanBody(text) {
  return String(text ?? '')
    .replace(/\r/g, '')
    .replace(/([*=_#-])\1{7,}/g, '────────')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 20000)
}

// Dalla risposta di get_thread ai messaggi da leggere, dal più recente
export function parseThread(result) {
  const text = (result?.content ?? []).map((b) => (b && b.type === 'text' ? b.text : '')).join('')
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return []
  }
  return (data.messages ?? [])
    .map((m) => ({
      from: m.sender,
      to: [].concat(m.toRecipients ?? []).join(', '),
      date: m.date,
      subject: m.subject,
      body: cleanBody(m.plaintextBody ?? m.snippet),
      attachments: (m.attachments ?? []).map((a) => a.filename ?? a.name).filter(Boolean),
    }))
    .reverse()
}

// Dal nome del mittente "Nome <a@b.it>" al solo nome, o all'indirizzo
export function senderName(sender) {
  const s = String(sender ?? '').trim()
  const named = s.match(/^"?([^"<]+?)"?\s*<[^>]+>$/)
  return (named ? named[1] : s.replace(/[<>]/g, '')).trim()
}

// Il mittente per la lista: il nome se c'è, altrimenti il dominio (linkedin da em.linkedin.com),
// oppure la parte prima della chiocciola per le caselle personali
export function shortSender(sender) {
  const s = String(sender ?? '').trim()
  const at = s.indexOf('@')
  if (at < 0) return s
  const host = s.slice(at + 1).split('.')
  const personal = ['gmail', 'outlook', 'hotmail', 'yahoo', 'icloud', 'libero', 'live', 'me']
  const domain = host.length > 1 ? host[host.length - 2] : host[0]
  return personal.includes(domain) || host.length < 2 ? s.slice(0, at) : domain
}

// Dalla risposta di search_threads alla lista di mail: una per thread, l'ultimo messaggio
export function parseThreads(result) {
  const text = (result?.content ?? []).map((b) => (b && b.type === 'text' ? b.text : '')).join('')
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return []
  }
  return (data.threads ?? []).map((t) => {
    const m = (t.messages ?? []).at(-1) ?? {}
    return {
      threadId: t.id,
      messageId: m.id,
      sender: senderName(m.sender),
      subject: m.subject || '(senza oggetto)',
      date: m.date,
      snippet: m.snippet,
      url: t.viewUrl,
    }
  })
}

// Il testo del thread già letto dalla mod, da dare al modello al posto di una nuova lettura
export function threadText(body, limit = 6000) {
  if (!Array.isArray(body) || !body.length) return ''
  return body
    .map((m) => ['Da: ' + m.from, 'Data: ' + formatLong(m.date), 'Oggetto: ' + m.subject, '', m.body].join('\n'))
    .join('\n\n---\n\n')
    .slice(0, limit)
}

// I nomi con cui il connettore Notion può comparire, provati in ordine come per Gmail
const NOTION_SERVERS = ['Notion', '46dded4b-f2d2-4af7-9ae7-1db030709c49', 'claude.ai Notion', 'claude_ai_Notion']
const notion = { server: NOTION_SERVERS }

// I modelli: uno economico per scegliere campi ed etichette, uno migliore per scrivere la bozza
const CHEAP_MODEL = 'haiku'
const WRITER_MODEL = 'sonnet'

// I valori ammessi dei campi del task: quello che il modello propone fuori elenco cade sul primo
export const TASK_CHOICES = {
  Urgenza: ['Non urgente', 'Urgente', 'Routine'],
  Importanza: ['Importante', 'Non importante', 'Strategico'],
  Impegno: ['Facile', 'Flusso', 'Veloce', 'Personale'],
}

// L'ora locale di adesso con il fuso, in ISO senza secondi
export function nowLocal(d = new Date()) {
  const two = (n) => String(n).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()) + 'T' + two(d.getHours()) + ':' + two(d.getMinutes()) + sign + two(Math.floor(Math.abs(off) / 60)) + ':' + two(Math.abs(off) % 60)
}

// Domani alle 09:00 locali, in ISO con fuso
export function tomorrowNine(d = new Date()) {
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 9, 0, 0)
  return nowLocal(next).replace('T09:00', 'T09:00:00')
}

// Il primo oggetto JSON in una risposta del modello, anche se racchiuso in un blocco di codice
export function parseJson(text) {
  const s = String(text ?? '')
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(s.slice(start, end + 1))
  } catch {
    return null
  }
}

// I campi del task proposti dal modello, ricondotti a valori ammessi: titolo non vuoto e corto,
// scelte negli elenchi, scadenza tra adesso e un anno, altrimenti domani alle 09:00
export function taskFields(raw, mail, now = new Date()) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const pick = (key) => (TASK_CHOICES[key].includes(r[key]) ? r[key] : TASK_CHOICES[key][0])
  const due = new Date(r.scadenza)
  const valid = typeof r.scadenza === 'string' && /T\d\d:\d\d/.test(r.scadenza) && due > now && due - now < 365 * 864e5
  return {
    title: clip(r.titolo, 120) || clip(mail.subject, 120) || 'Rispondere alla mail',
    due: valid ? r.scadenza : tomorrowNine(now),
    Urgenza: pick('Urgenza'),
    Importanza: pick('Importanza'),
    Impegno: pick('Impegno'),
    context: clip(r.contesto, 400),
  }
}

// Le etichette dell'utente dalla risposta di list_labels (le etichette di sistema no)
export function parseLabels(result) {
  const text = (result?.content ?? []).map((b) => (b && b.type === 'text' ? b.text : '')).join('')
  try {
    return (JSON.parse(text).labels ?? []).filter((l) => l.labelType === 'USER' && l.labelId && l.name).map((l) => ({ id: l.labelId, name: l.name }))
  } catch {
    return []
  }
}

// L'etichetta indicata dal modello, solo se è una di quelle esistenti
export function matchLabel(answer, labels) {
  const a = String(answer ?? '').trim().replace(/^["'`]+|["'`.]+$/g, '').trim().toLowerCase()
  if (!a) return null
  return labels.find((l) => l.name.toLowerCase() === a) ?? null
}

// Una completion senza tool: il modello propone, il codice decide cosa scrivere
async function ask($, request) {
  const r = await $.model.complete({ timeoutMs: 90000, ...request })
  if (!r.isAnswered) throw new Error('modello senza risposta (' + r.reason + (r.status ? ' ' + r.status : '') + ')')
  return r.text
}

// Il testo del thread: quello già letto dal pannello, altrimenti lo legge ora
async function ensureText($, account, mail) {
  let body = bodies.get(mail.threadId)
  if (!Array.isArray(body)) {
    const res = await callServers($, account, 'get_thread', { threadId: mail.threadId, messageFormat: 'PLAIN_TEXT' })
    if (res.isError) throw new Error('lettura del thread: ' + clip(res.content?.[0]?.text, 200))
    body = parseThread(res)
    if (body.length) bodies.set(mail.threadId, body)
  }
  return threadText(body) || 'Oggetto: ' + mail.subject + '\n\n' + (mail.snippet ?? '')
}

// Una chiamata che deve riuscire: altrimenti l'errore ferma l'azione
async function must($, target, tool, args, what) {
  const res = await callServers($, target, tool, args)
  if (res.isError) throw new Error(what + ': ' + clip(res.content?.[0]?.text, 200))
  return res
}

// Le regole della bozza, lette dal file dell'utente
let rules = null
async function draftRules($) {
  if (rules) return rules
  const home = (await $.env.get('HOME')) || ''
  rules = await $.fs.read(home + RULES_FILE)
  return rules
}

// BOZZA: il modello scrive solo il testo, il codice crea la bozza di risposta (mai inviata)
async function doDraft($, account, mail, text) {
  const system = await draftRules($)
  const reply = await ask($, {
    model: WRITER_MODEL,
    system,
    maxTokens: 2000,
    prompt: 'Thread (dal messaggio più recente):\n<<<\n' + text + '\n>>>\n\nScrivi la risposta di Andrea all\'ultimo messaggio. Restituisci solo il testo della mail, senza titoli, commenti né markdown.',
  })
  const body = String(reply).replace(/^```[a-z]*\n?|\n?```$/g, '').trim()
  if (!body) throw new Error('bozza vuota')
  await must($, account, 'create_draft', { replyToMessageId: mail.messageId, body }, 'creazione bozza')
  return 'bozza creata'
}

// LABEL: il modello sceglie tra le etichette esistenti, il codice la applica e toglie INBOX
async function doLabel($, account, mail, text) {
  const labels = parseLabels(await must($, account, 'list_labels', {}, 'lettura etichette'))
  if (!labels.length) throw new Error('nessuna etichetta trovata')
  const answer = await ask($, {
    model: CHEAP_MODEL,
    effort: 'low',
    maxTokens: 100,
    system: 'Classifichi mail. Rispondi solo con il nome esatto di una etichetta dell\'elenco, nient\'altro.',
    prompt: 'Etichette:\n' + labels.map((l) => l.name).join('\n') + '\n\nMail:\n<<<\n' + text.slice(0, 3000) + '\n>>>\n\nQuale etichetta è la più pertinente?',
  })
  const label = matchLabel(answer, labels)
  if (!label) throw new Error('etichetta non riconosciuta: ' + clip(answer, 60))
  await must($, account, 'label_thread', { threadId: mail.threadId, labelIds: [label.id] }, 'etichetta')
  await must($, account, 'unlabel_thread', { threadId: mail.threadId, labelIds: ['INBOX'] }, 'archiviazione')
  return label.name
}

// TASK: il modello propone i campi, il codice li valida e crea la pagina nel database Tasks
async function doTask($, mail, text) {
  const answer = await ask($, {
    model: CHEAP_MODEL,
    effort: 'low',
    maxTokens: 400,
    system: 'Trasformi una mail in un task. Rispondi solo con un oggetto JSON, senza testo intorno.',
    prompt:
      'Ora locale: ' + nowLocal() + '.\nMail:\n<<<\n' + text.slice(0, 4000) + '\n>>>\n\n' +
      'Campi: "titolo" (cosa fare, breve, verbo all\'infinito), "scadenza" (ISO con fuso, ad esempio ' + tomorrowNine() + '; se la mail non indica una data usa domani alle 09:00), ' +
      Object.entries(TASK_CHOICES).map(([k, v]) => '"' + k + '" (uno tra ' + v.map((x) => '"' + x + '"').join(', ') + ')').join(', ') +
      ', "contesto" (una o due frasi).',
  })
  const f = taskFields(parseJson(answer), mail)
  await must($, notion, 'notion-create-pages', {
    parent: { type: 'data_source_id', data_source_id: TASKS_DB },
    pages: [{
      properties: { Task: f.title, 'date:Data:start': f.due, 'date:Data:is_datetime': 1, Urgenza: f.Urgenza, Importanza: f.Importanza, Impegno: f.Impegno, ' ': 'Non iniziato' },
      content: '[Apri la mail](' + (mail.url ?? '') + ') da ' + mail.sender + '\n\n' + f.context,
    }],
  }, 'creazione task')
  return clip(f.title, 50) + ' · ' + formatLong(f.due)
}

// Esegue l'azione di un bottone: tutte le scritture partono dal codice, il modello sceglie solo i contenuti
export async function runAction($, key, account, mail) {
  const text = await ensureText($, account, mail)
  if (key === 'bozza') return doDraft($, account, mail, text)
  if (key === 'label') return 'etichetta ' + (await doLabel($, account, mail, text))
  if (key === 'misto') {
    // Se la bozza c'è già (un tentativo precedente si è fermato all'etichetta) non la si ripete
    if (!mail.drafted) await doDraft($, account, mail, text)
    mail.drafted = true
    return 'bozza creata, etichetta ' + (await doLabel($, account, mail, text))
  }
  if (key === 'task') return 'task: ' + (await doTask($, mail, text))
  throw new Error('azione sconosciuta: ' + key)
}

// Le azioni dei bottoni: cosa fanno alla mail dopo l'invio. Solo l'etichetta sposta la mail
// (esce dall'inbox verso la cartella dell'etichetta); bozza e task la lasciano dov'è
const ACTIONS = [
  { key: 'bozza', label: 'Bozza', hotkey: 'b', archives: false },
  { key: 'label', label: 'Label', hotkey: 'l', archives: true },
  { key: 'misto', label: 'Bozza+Label', hotkey: 'm', archives: true },
  { key: 'task', label: 'Task', hotkey: 't', archives: false },
]

// La mail selezionata nell'elenco piatto di tutti gli account
function flat() {
  return boxes.flatMap((box) => box.mails.map((mail) => ({ box, mail })))
}

// Carica la inbox di ogni account; un errore resta nell'account e non ferma gli altri
async function load($) {
  boxes = await Promise.all(
    accounts.map(async (account) => {
      try {
        const res = await callServers($, account, 'search_threads', { query: 'in:inbox', pageSize: PAGE_SIZE, view: 'THREAD_VIEW_MINIMAL' })
        if (res.isError) return { account, mails: [], error: clip((res.content?.[0]?.text) ?? 'errore', 600) }
        return { account, mails: parseThreads(res), error: '' }
      } catch (err) {
        return { account, mails: [], error: clip(err?.message ?? err, 600) }
      }
    }),
  )
  cursor = 0
}

// Legge il testo del thread selezionato (una sola volta) e ridisegna il pannello
async function loadBody($, item) {
  if (!item || bodies.has(item.mail.threadId)) return
  bodies.set(item.mail.threadId, 'carico')
  try {
    const res = await callServers($, item.box.account, 'get_thread', { threadId: item.mail.threadId, messageFormat: 'PLAIN_TEXT' })
    const messages = res.isError ? [] : parseThread(res)
    bodies.set(item.mail.threadId, messages.length ? messages : { error: res.isError ? clip(res.content?.[0]?.text, 300) : 'testo non disponibile' })
  } catch (err) {
    bodies.set(item.mail.threadId, { error: clip(err?.message ?? err, 300) })
  }
  $.ui.invalidate('ui.render')
}

// Un lavoro fallito: la mail archiviata torna in elenco e l'errore si vede nel pannello
function failJob($, job, note) {
  job.status = 'errore'
  job.note = clip(String(note).replace(/posta: \$ ?mcp\.call: /g, ''), 400)
  if (job.archived && !job.box.mails.includes(job.mail)) job.box.mails.unshift(job.mail)
  $.ui.toast('posta: ' + job.label + ' non riuscito')
  $.ui.invalidate('ui.render')
}

// Apre il pannello (carica la inbox) o lo chiude; risponde con la riga di esito
async function setOpen($, want) {
  enabled = want
  if (want) {
    await load($)
    await $.ui.open({ id: PANE, title: 'Posta', focus: true })
    void loadBody($, flat()[0])
  } else {
    await $.ui.close({ id: PANE })
  }
  $.ui.invalidate('ui.render')
  return 'posta · ' + (want ? 'aperta, ' + flat().length + ' mail' : 'chiusa')
}

async function runPosta($, e) {
  const arg = String(e.args ?? '').trim().toLowerCase()
  try {
    return { text: await setOpen($, arg === 'aggiorna' ? true : parseToggle(e.args, enabled)) }
  } catch (err) {
    return { text: 'posta: ' + clip(err?.message ?? err, 200) }
  }
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    try {
      const saved = await $.store.get('accounts')
      if (Array.isArray(saved) && saved.length) accounts = saved
    } catch {}
    const spec = { name: 'posta', description: 'Apre o chiude la inbox con i bottoni Bozza, Label e Task', argumentHint: '[on|off|aggiorna]', immediate: true }
    await $.command.register(spec)
    // Nelle chat nuove l'elenco dei comandi può essere già chiuso a questo punto: si ripete dopo poco
    for (const ms of [1500, 5000]) {
      $.clock.after(ms, () => {
        void $.command.register(spec).catch(() => {})
      })
    }
    return next(e)
  })

  on('command.run', { command: 'posta' }, runPosta)
  // Il comando statico del plugin si chiama anche posta:apri
  on('command.run', { command: 'posta:apri' }, runPosta)

  // Scrivere "posta" (senza barra) apre o chiude il pannello: non arriva al modello e non consuma token
  on('prompt.submit', async ($, e, next) => {
    const m = String(e.text ?? '').trim().toLowerCase().match(/^posta(?:\s+(on|off|aggiorna|chiudi))?$/)
    if (!m) return next(e)
    try {
      const text = await setOpen($, m[1] === 'aggiorna' ? true : parseToggle(m[1], enabled))
      return { drop: text }
    } catch (err) {
      // Se il pannello non si apre il prompt non deve restare bloccato
      return { drop: 'posta: ' + clip(err?.message ?? err, 200) }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const all = flat()
    cursor = Math.min(cursor, Math.max(0, all.length - 1))
    const current = all[cursor]
    const rule = Text({ dimColor: true, children: ['─'.repeat(Math.max(10, Math.min(120, e.props.bodyColumns ?? 60)))] })

    // Sposta la selezione e carica il testo della nuova mail
    const move = (step) => () => {
      if (!all.length) return
      cursor = (cursor + step + all.length) % all.length
      showOlder = false
      void loadBody($, all[cursor])
      $.ui.invalidate('ui.render')
    }

    const refresh = async () => {
      showOlder = false
      bodies.clear()
      await load($)
      void loadBody($, flat()[0])
      $.ui.invalidate('ui.render')
    }

    // Il bottone avvia l'azione in background e toglie la mail dall'elenco se l'azione la archivia;
    // l'esito compare nel pannello e in un avviso, la chat resta pulita
    const act = (action, target = current) => async () => {
      if (!target) return
      const { box, mail } = target
      // Un secondo tocco sulla stessa mail mentre l'azione gira non la ripete
      if (jobs.some((j) => j.status === 'corso' && j.mail === mail && j.action === action)) return
      const job = { label: action.label + ' · ' + clip(mail.subject, 40), status: 'corso', note: '', box, mail, archived: action.archives, action }
      jobs.push(job)
      tick($)
      if (action.archives) {
        box.mails = box.mails.filter((m) => m !== mail)
        cursor = Math.min(cursor, Math.max(0, flat().length - 1))
        void loadBody($, flat()[cursor])
      }
      $.ui.invalidate('ui.render')
      try {
        job.note = clip(await runAction($, action.key, box.account, mail), 160)
        job.status = 'fatto'
        job.doneAt = Date.now()
        // Riuscita: gli errori precedenti della stessa azione su questa mail non servono più
        for (let i = jobs.length - 1; i >= 0; i--) {
          const j = jobs[i]
          if (j.status === 'errore' && j.action === action && j.mail.threadId === mail.threadId) jobs.splice(i, 1)
        }
        $.ui.toast('posta: ' + job.label + ' fatto')
      } catch (err) {
        failJob($, job, String(err?.message ?? err))
      }
      $.ui.invalidate('ui.render')
    }

    // Gli errori si vedono solo sulla mail a cui appartengono; Riprova rilancia l'ultimo di quella mail
    const mine = (j) => current && j.mail.threadId === current.mail.threadId
    const failed = jobs.findLast((j) => j.status === 'errore' && mine(j))
    const retry = () => {
      if (!failed) return
      const idx = flat().findIndex((x) => x.mail.threadId === failed.mail.threadId)
      if (idx < 0) return
      jobs.splice(jobs.indexOf(failed), 1)
      cursor = idx
      return act(failed.action, flat()[idx])()
    }

    // La lista: una finestra di poche righe che scorre con la selezione, con l'intestazione di ogni account
    const top = Math.min(Math.max(0, cursor - Math.floor(WINDOW / 2)), Math.max(0, all.length - WINDOW))
    const shown = all.slice(top, top + WINDOW)
    const list = []
    let lastBox = null
    shown.forEach((item, i) => {
      const dot = DOTS[boxes.indexOf(item.box) % DOTS.length]
      if (item.box !== lastBox) {
        lastBox = item.box
        list.push(
          Box({
            key: 'h-' + item.box.account.name + i,
            flexDirection: 'row',
            children: [
              Text({ color: dot, bold: true, children: ['● '] }),
              Text({ bold: true, children: [item.box.account.email] }),
              Text({ dimColor: true, children: ['  ' + item.box.mails.length + ' mail'] }),
            ],
          }),
        )
      }
      const selected = top + i === cursor
      list.push(
        Box({
          key: 'm-' + (top + i),
          flexDirection: 'row',
          children: [
            Text({ color: selected ? dot : undefined, bold: true, children: [selected ? '▌' : ' '] }),
            Text({ inverse: selected, dimColor: !selected, children: [' ' + formatWhen(item.mail.date).padEnd(5) + ' '] }),
            Text({ inverse: selected, bold: true, children: [' ' + clip(shortSender(item.mail.sender), 16).padEnd(16) + ' '] }),
            Text({ inverse: selected, bold: selected, dimColor: !selected, children: [' ' + clip(item.mail.subject, 90) + ' '] }),
          ],
        }),
      )
    })

    // Il testo intero: tutti i messaggi del thread, dal più recente
    const detail = []
    const body = current ? bodies.get(current.mail.threadId) : null
    if (!current) {
      detail.push(Text({ key: 'vuota', dimColor: true, children: ['Inbox vuota'] }))
    } else if (!body || body === 'carico') {
      detail.push(Text({ key: 'carico', dimColor: true, children: ['Carico il testo…'] }))
    } else if (body.error) {
      detail.push(Text({ key: 'err', color: 'red', children: ['errore: ' + body.error] }))
    } else {
      const block = (m, i) => {
        detail.push(
          Box({
            key: 'da-' + i,
            flexDirection: 'row',
            children: [Text({ bold: true, children: [m.from] }), Text({ dimColor: true, children: ['  ' + formatLong(m.date)] })],
          }),
        )
        detail.push(Text({ key: 'a-' + i, dimColor: true, children: ['A: ' + m.to] }))
        detail.push(Text({ key: 'og-' + i, bold: true, children: [m.subject ?? current.mail.subject] }))
        detail.push(Text({ key: 'sp-' + i, children: [' '] }))
        detail.push(Text({ key: 'tx-' + i, children: [m.body || '(vuoto)'] }))
        if (m.attachments.length) detail.push(Text({ key: 'al-' + i, dimColor: true, children: ['Allegati: ' + m.attachments.join(', ')] }))
      }
      block(body[0], 0)
      if (body.length > 1) {
        detail.push(
          Button({
            key: 'precedenti',
            label: showOlder ? 'Nascondi precedenti' : 'Mostra ' + (body.length - 1) + (body.length === 2 ? ' precedente' : ' precedenti'),
            hotkey: 'p',
            onPress: () => {
              showOlder = !showOlder
              $.ui.invalidate('ui.render')
            },
          }),
        )
        body.slice(1).forEach((m, k) => {
          const i = k + 1
          detail.push(Text({ key: 'sep-' + i, dimColor: true, children: ['┄'.repeat(Math.max(10, Math.min(120, e.props.bodyColumns ?? 60)))] }))
          if (showOlder) block(m, i)
          else detail.push(Text({ key: 'riga-' + i, dimColor: true, children: ['▸ ' + clip(shortSender(m.from), 16) + ' · ' + formatWhen(m.date) + ' · ' + clip(String(m.body ?? '').replace(/\s+/g, ' '), 70)] }))
        })
      }
    }

    const errors = boxes.filter((box) => box.error)
    return Box({
      flexDirection: 'column',
      children: [
        Text({ key: 'head', bold: true, children: ['Posta' + (all.length ? '  (' + (cursor + 1) + '/' + all.length + ')' : '')] }),
        ...errors.map((box) => Text({ key: 'e-' + box.account.name, color: 'red', children: ['errore: ' + box.error] })),
        rule,
        ...list,
        rule,
        ...jobs
          .filter((j) => (j.status === 'corso') || (j.status === 'fatto' && Date.now() - j.doneAt < DONE_VISIBLE_MS) || (j.status === 'errore' && mine(j)))
          .slice(-4)
          .map((j, i) =>
            Text({
              key: 'job-' + i,
              color: j.status === 'errore' ? 'red' : j.status === 'fatto' ? 'green' : undefined,
              dimColor: j.status === 'corso',
              children: [
                (j.status === 'corso' ? SPIN[Math.floor(Date.now() / 120) % SPIN.length] : j.status === 'fatto' ? '✓' : '✗') + ' ' + j.label +
                  (j.note ? ' · ' + j.note : '') + (j.status === 'errore' ? '  (premi y per riprovare)' : ''),
              ],
            }),
          ),
        Box({
          flexDirection: 'row',
          children: [
            ...ACTIONS.flatMap((a) => [Button({ key: a.key, label: a.label, hotkey: a.hotkey, variant: a.key === 'bozza' ? 'primary' : undefined, onPress: act(a) }), Text({ children: [' '] })]),
            Text({ dimColor: true, children: [' │  '] }),
            Button({ key: 'su', label: 'Su', hotkey: 'k', onPress: move(-1) }),
            Text({ children: [' '] }),
            Button({ key: 'giu', label: 'Giù', hotkey: 'j', onPress: move(1) }),
            Text({ dimColor: true, children: ['  │  '] }),
            failed && Button({ key: 'riprova', label: 'Riprova', hotkey: 'y', onPress: retry }),
            failed && Text({ children: [' '] }),
            Button({ key: 'aggiorna', label: 'Aggiorna', hotkey: 'r', onPress: refresh }),
            Text({ children: [' '] }),
            Button({ key: 'chiudi', label: 'Chiudi', hotkey: 'x', onPress: () => setOpen($, false) }),
          ].filter(Boolean),
        }),
        rule,
        ...detail,
      ].filter(Boolean),
    })
  })
}
