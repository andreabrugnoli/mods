// Quante mail dell'inbox mostrare per account
const PAGE_SIZE = 12

// Quante mail mostrare insieme nella lista: il resto scorre con j e k
const WINDOW = 5

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

// Le regole di scrittura delle bozze, lette dal modello quando serve
const RULES_FILE = '~/.claude/mods-data/posta/sistematore.md'

// Acceso o spento: lo decide /posta e resta nello store tra una sessione e l'altra
let enabled = false

// Lo stato della vista: gli account con le loro mail, la mail selezionata, l'ultimo esito
let accounts = DEFAULT_ACCOUNTS
let boxes = []
let cursor = 0
let outcome = ''

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

// Il prompt che un bottone invia al modello. Bozza, etichetta e task passano da lui:
// servono giudizio (scrivere, scegliere l'etichetta, compilare i campi)
export function buildPrompt(action, account, mail) {
  const mailLine =
    'Mail: account ' + account.email + ' (connettore Gmail "' + (serverList(account)[0] ?? 'Gmail') + '", se non risponde usa quello disponibile), thread ' + mail.threadId +
    ', messaggio ' + mail.messageId + ', da ' + mail.sender + ', oggetto "' + mail.subject + '".'
  const read = 'Leggi il thread completo con get_thread prima di agire.'
  const draft =
    'BOZZA: scrivi la risposta seguendo le regole in ' + RULES_FILE + ' e crea una bozza di risposta con create_draft ' +
    '(replyToMessageId = ' + mail.messageId + '). Nella bozza metti solo il blocco "Email ottimizzata". Non inviare mai la mail.'
  const label =
    'LABEL: con list_labels leggi le etichette dell\'account e applica con label_thread quella più pertinente tra le ' +
    'esistenti. Non creare etichette nuove. Poi archivia il thread con unlabel_thread togliendo INBOX.'
  const task =
    'TASK: crea un task in Notion nel database Tasks sotto Backend (non toccare i database con prefisso CB-). ' +
    'Leggi prima lo schema reale con notion-fetch e compila tutti i campi. Il task ha sempre data con giorno e ora. ' +
    'Il titolo (Name) descrive cosa fare, con un link alla mail. Poi archivia il thread con unlabel_thread togliendo INBOX.'
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
    enabled = arg === 'aggiorna' ? true : parseToggle(e.args, enabled)
    outcome = ''
    if (enabled) await load($)
    $.ui.invalidate('ui.render')
    return { text: 'posta · ' + (enabled ? 'aperta, ' + flat().length + ' mail' : 'chiusa') }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const theirs = await next(e)
    if (!enabled || e.props.isWorking) return theirs
    const { Box, Text, Button } = $.ui.resolve(e)
    const all = flat()
    const current = all[cursor]

    const close = () => {
      enabled = false
      $.ui.invalidate('ui.render')
    }

    const move = (step) => () => {
      if (all.length) cursor = (cursor + step + all.length) % all.length
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
      }
      $.ui.invalidate('ui.render')
      return $.prompt.submit({ text: buildPrompt(action.key, account, mail), asUser: true })
    }

    // La finestra di mail visibili: poche righe, che scorrono con la selezione
    const room = Math.max(3, Math.min(WINDOW, (e.props.maxRows ?? 10) - 6))
    const top = Math.min(Math.max(0, cursor - Math.floor(room / 2)), Math.max(0, all.length - room))
    const shown = all.slice(top, top + room)
    const errors = boxes.filter((box) => box.error)
    const total = boxes.map((box) => box.account.name + ' ' + box.mails.length).join(' · ')

    const rows = shown.map((item, i) => {
      const selected = top + i === cursor
      const when = formatWhen(item.mail.date).padEnd(5)
      return Text({
        key: 'm-' + (top + i),
        bold: selected,
        dimColor: !selected,
        children: [(selected ? '▸ ' : '  ') + when + '  ' + clip(shortSender(item.mail.sender), 18).padEnd(18) + '  ' + clip(item.mail.subject, 80)],
      })
    })

    return Box({
      flexDirection: 'column',
      children: [
        Text({ key: 'head', bold: true, children: ['Posta · ' + total + (all.length ? '  (' + (cursor + 1) + '/' + all.length + ')' : '')] }),
        ...errors.map((box) => Text({ key: 'e-' + box.account.name, color: 'red', children: ['errore: ' + box.error] })),
        ...rows,
        current ? Text({ key: 'det', children: [clip(current.mail.sender + '  ·  ' + current.mail.subject, 140)] }) : Text({ key: 'vuota', dimColor: true, children: ['Inbox vuota'] }),
        current ? Text({ key: 'snip', dimColor: true, children: [clip(current.mail.snippet, 160)] }) : null,
        Box({
          flexDirection: 'row',
          children: [
            Button({ key: 'su', label: 'Su', hotkey: 'k', onPress: move(-1) }),
            Text({ children: [' '] }),
            Button({ key: 'giu', label: 'Giù', hotkey: 'j', onPress: move(1) }),
            Text({ children: ['  '] }),
            ...ACTIONS.flatMap((a) => [Button({ key: a.key, label: a.label, hotkey: a.hotkey, variant: a.key === 'bozza' ? 'primary' : undefined, onPress: act(a) }), Text({ children: [' '] })]),
            Text({ children: [' '] }),
            Button({ key: 'chiudi', label: 'Chiudi', hotkey: 'x', onPress: close }),
          ],
        }),
        outcome ? Text({ dimColor: true, children: ['Inviato: ' + outcome] }) : null,
        theirs,
      ].filter(Boolean),
    })
  })
}
