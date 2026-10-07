// Quante mail dell'inbox mostrare per account
const PAGE_SIZE = 12

// Quante mail mostrare insieme nella lista: il resto scorre con j e k
const WINDOW = 5

// L'id del pannello e la parola che lo apre scrivendola nel prompt (senza barra, niente avviso dell'app)
const PANE = 'posta'

// I nomi con cui il connettore Gmail può comparire: cambiano da sessione a sessione
// (nome del connettore, nome con prefisso, id), quindi si provano in ordine
const GMAIL_SERVERS = ['claude.ai Gmail', 'Gmail', 'claude_ai_Gmail', 'e14c09e8-d3bf-4f30-b839-ba795465d6b4']

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

// Chiama un tool dell'account provando i nomi di connettore uno dopo l'altro, e ricorda quello che risponde.
// Se nessuno risponde, l'errore riporta il motivo di ciascun tentativo
async function callGmail($, account, tool, args) {
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
  return { isError: true, content: [{ type: 'text', text: failures.join(' | ') || 'nessun connettore Gmail trovato' }] }
}

// Il database Tasks di Notion: letto una volta, così il modello non lo cerca a ogni task
const TASKS_DB = '1ee13fe7-1a52-8195-9008-000b5e44714d'
const TASKS_SCHEMA = [
  'Task (titolo): cosa fare, breve e all\'infinito.',
  'date:Data:start: data e ora di scadenza in ISO con fuso (ad esempio 2026-10-08T09:00:00+02:00); date:Data:is_datetime: 1. Sempre presente.',
  'Urgenza (select): "Urgente", "Non urgente" oppure "Routine".',
  'Importanza (select): "Importante", "Non importante" oppure "Strategico".',
  'Impegno (select): "Flusso", "Facile", "Veloce" oppure "Personale".',
  '" " (lo Stato, una colonna con nome uno spazio): "Non iniziato".',
].join('\n- ')

// Le regole di scrittura delle bozze, lette dal modello quando serve
const RULES_FILE = '~/.claude/mods-data/posta/sistematore.md'

// Acceso o spento: lo decide /posta e resta nello store tra una sessione e l'altra
let enabled = false

// Lo stato della vista: gli account con le loro mail, la mail selezionata, l'ultimo esito
let accounts = DEFAULT_ACCOUNTS
let boxes = []
let cursor = 0
let outcome = ''

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

// L'ora locale di adesso con il fuso, per dare al modello un riferimento per le scadenze
export function nowLocal(d = new Date()) {
  const two = (n) => String(n).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()) + 'T' + two(d.getHours()) + ':' + two(d.getMinutes()) + sign + two(Math.floor(Math.abs(off) / 60)) + ':' + two(Math.abs(off) % 60)
}

// Il prompt che un bottone invia al modello. Bozza, etichetta e task passano da lui:
// servono giudizio (scrivere, scegliere l'etichetta, compilare i campi)
export function buildPrompt(action, account, mail, text = '') {
  const mailLine =
    'Mail: account ' + account.email + ' (connettore Gmail "' + (serverList(account)[0] ?? 'Gmail') + '", se non risponde usa quello disponibile), thread ' + mail.threadId +
    ', messaggio ' + mail.messageId + ', da ' + mail.sender + ', oggetto "' + mail.subject + '".'
  const read = text
    ? 'Testo del thread (già letto, non rileggerlo):\n<<<\n' + text + '\n>>>'
    : 'Leggi il thread completo con get_thread prima di agire.'
  const draft =
    'BOZZA: scrivi la risposta seguendo le regole in ' + RULES_FILE + ' e crea una bozza di risposta con create_draft ' +
    '(replyToMessageId = ' + mail.messageId + '). Nella bozza metti solo il blocco "Email ottimizzata". Non inviare mai la mail.'
  const label =
    'LABEL: con list_labels leggi le etichette dell\'account e applica con label_thread quella più pertinente tra le ' +
    'esistenti. Non creare etichette nuove. Poi archivia il thread con unlabel_thread togliendo INBOX.'
  const task =
    'TASK: crea un task con notion-create-pages nel data source ' + TASKS_DB + ' (database Tasks). ' +
    'Non usare notion-fetch, notion-search né altre letture: lo schema è qui. Proprietà da compilare tutte:\n- ' + TASKS_SCHEMA +
    '\nNon compilare Progetto e Contesto. Ora locale adesso: ' + nowLocal() + '. Scegli la scadenza in base alla mail, ' +
    'altrimenti domani alle 09:00. Nel corpo della pagina metti una riga con il link alla mail (' + (mail.url ?? 'senza link') + ') e due righe di contesto. ' +
    'Poi archivia il thread con unlabel_thread togliendo INBOX.'
  const parts = { bozza: [draft], label: [label], misto: [draft, label], task: [task] }[action]
  return ['Gestione posta.', mailLine, read, ...parts, 'Chiudi con una riga di esito.'].join('\n')
}

// Le azioni dei bottoni: cosa fanno alla mail dopo l'invio (archiviata = esce dall'elenco)
const ACTIONS = [
  { key: 'bozza', label: 'Bozza', hotkey: 'b', archives: false },
  { key: 'label', label: 'Label', hotkey: 'l', archives: true },
  { key: 'misto', label: 'Bozza+Label', hotkey: 'm', archives: true },
  { key: 'task', label: 'Task', hotkey: 't', archives: true },
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
        const res = await callGmail($, account, 'search_threads', { query: 'in:inbox', pageSize: PAGE_SIZE, view: 'THREAD_VIEW_MINIMAL' })
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
    const res = await callGmail($, item.box.account, 'get_thread', { threadId: item.mail.threadId, messageFormat: 'PLAIN_TEXT' })
    const messages = res.isError ? [] : parseThread(res)
    bodies.set(item.mail.threadId, messages.length ? messages : { error: res.isError ? clip(res.content?.[0]?.text, 300) : 'testo non disponibile' })
  } catch (err) {
    bodies.set(item.mail.threadId, { error: clip(err?.message ?? err, 300) })
  }
  $.ui.invalidate('ui.render')
}

// Apre il pannello (carica la inbox) o lo chiude; risponde con la riga di esito
async function setOpen($, want) {
  enabled = want
  outcome = ''
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

export function register(on) {
  on('session.start', async ($, e, next) => {
    try {
      const saved = await $.store.get('accounts')
      if (Array.isArray(saved) && saved.length) accounts = saved
    } catch {}
    await $.command.register({ name: 'posta', description: 'Apre o chiude la inbox con i bottoni Bozza, Label e Task', argumentHint: '[on|off|aggiorna]', immediate: true })
    return next(e)
  })

  on('command.run', { command: 'posta' }, async ($, e) => {
    const arg = String(e.args ?? '').trim().toLowerCase()
    return { text: await setOpen($, arg === 'aggiorna' ? true : parseToggle(e.args, enabled)) }
  })

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
      void loadBody($, all[cursor])
      $.ui.invalidate('ui.render')
    }

    const refresh = async () => {
      bodies.clear()
      await load($)
      void loadBody($, flat()[0])
      $.ui.invalidate('ui.render')
    }

    // Il bottone toglie la mail dall'elenco se l'azione la archivia e invia il prompt come se l'avessi scritto tu
    const act = (action) => () => {
      if (!current) return
      const { account } = current.box
      const mail = current.mail
      outcome = action.label + ' · ' + clip(mail.subject, 50)
      if (action.archives) {
        current.box.mails = current.box.mails.filter((m) => m !== mail)
        cursor = Math.min(cursor, Math.max(0, flat().length - 1))
        void loadBody($, flat()[cursor])
      }
      $.ui.invalidate('ui.render')
      return $.prompt.submit({ text: buildPrompt(action.key, account, mail, threadText(bodies.get(mail.threadId))), asUser: true })
    }

    // La lista: una finestra di poche righe che scorre con la selezione, con l'intestazione di ogni account
    const top = Math.min(Math.max(0, cursor - Math.floor(WINDOW / 2)), Math.max(0, all.length - WINDOW))
    const shown = all.slice(top, top + WINDOW)
    const list = []
    let lastBox = null
    shown.forEach((item, i) => {
      if (item.box !== lastBox) {
        lastBox = item.box
        list.push(Text({ key: 'h-' + item.box.account.name + i, bold: true, children: [item.box.account.email + ' · ' + item.box.mails.length + ' mail'] }))
      }
      const selected = top + i === cursor
      list.push(
        Text({
          key: 'm-' + (top + i),
          bold: selected,
          dimColor: !selected,
          children: [(selected ? '▸ ' : '  ') + formatWhen(item.mail.date).padEnd(5) + '  ' + clip(shortSender(item.mail.sender), 16).padEnd(16) + '  ' + clip(item.mail.subject, 90)],
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
      body.forEach((m, i) => {
        if (i > 0) detail.push(Text({ key: 'sep-' + i, dimColor: true, children: ['── messaggio precedente ──'] }))
        detail.push(Text({ key: 'da-' + i, bold: true, children: ['Da:      ' + m.from] }))
        detail.push(Text({ key: 'a-' + i, children: ['A:       ' + m.to] }))
        detail.push(Text({ key: 'dt-' + i, children: ['Data:    ' + formatLong(m.date)] }))
        detail.push(Text({ key: 'og-' + i, bold: true, children: ['Oggetto: ' + (m.subject ?? current.mail.subject)] }))
        detail.push(Text({ key: 'sp-' + i, children: [' '] }))
        detail.push(Text({ key: 'tx-' + i, children: [m.body || '(vuoto)'] }))
        if (m.attachments.length) detail.push(Text({ key: 'al-' + i, dimColor: true, children: ['Allegati: ' + m.attachments.join(', ')] }))
      })
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
        outcome ? Text({ key: 'esito', dimColor: true, children: ['Inviato: ' + outcome] }) : null,
        Box({
          flexDirection: 'row',
          children: [
            ...ACTIONS.flatMap((a) => [Button({ key: a.key, label: a.label, hotkey: a.hotkey, variant: a.key === 'bozza' ? 'primary' : undefined, onPress: act(a) }), Text({ children: [' '] })]),
            Text({ children: ['  '] }),
            Button({ key: 'su', label: 'Su', hotkey: 'k', onPress: move(-1) }),
            Text({ children: [' '] }),
            Button({ key: 'giu', label: 'Giù', hotkey: 'j', onPress: move(1) }),
            Text({ children: ['  '] }),
            Button({ key: 'aggiorna', label: 'Aggiorna', hotkey: 'r', onPress: refresh }),
            Text({ children: [' '] }),
            Button({ key: 'chiudi', label: 'Chiudi', hotkey: 'x', onPress: () => setOpen($, false) }),
          ],
        }),
        rule,
        ...detail,
      ].filter(Boolean),
    })
  })
}
