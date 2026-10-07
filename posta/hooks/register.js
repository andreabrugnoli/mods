// Quante mail dell'inbox mostrare per account
const PAGE_SIZE = 12

// Gli account: il connettore MCP che li legge e un nome breve. Si sostituiscono
// scrivendo un elenco con la stessa forma nello store (chiave "accounts")
const DEFAULT_ACCOUNTS = [
  { name: 'hello', email: 'hello@andreabrugnoli.it', server: 'claude.ai Gmail' },
]

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
    'Mail: account ' + account.email + ' (connettore MCP "' + account.server + '"), thread ' + mail.threadId +
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
        const res = await $.mcp.call(account.server, 'search_threads', { query: 'in:inbox', pageSize: PAGE_SIZE, view: 'THREAD_VIEW_MINIMAL' })
        if (res.isError) return { account, mails: [], error: clip((res.content?.[0]?.text) ?? 'errore', 80) }
        return { account, mails: parseThreads(res), error: '' }
      } catch (err) {
        return { account, mails: [], error: clip(err?.message ?? err, 80) }
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

    const lines = []
    let index = 0
    for (const box of boxes) {
      lines.push(Text({ key: 'h-' + box.account.name, bold: true, children: [box.account.email + ' · ' + box.mails.length] }))
      if (box.error) lines.push(Text({ key: 'e-' + box.account.name, color: 'red', children: ['errore: ' + box.error] }))
      for (const mail of box.mails) {
        const selected = index === cursor
        lines.push(Text({ key: 'm-' + index, inverse: selected, dimColor: !selected, children: [(selected ? '> ' : '  ') + formatWhen(mail.date) + '  ' + clip(mail.sender, 22) + '  ' + clip(mail.subject, 70)] }))
        index += 1
      }
    }

    return Box({
      flexDirection: 'column',
      children: [
        ...lines,
        current ? Text({ children: [clip(current.mail.sender + ' · ' + current.mail.subject, 100)] }) : Text({ dimColor: true, children: ['Inbox vuota'] }),
        current ? Text({ dimColor: true, children: [clip(current.mail.snippet, 220)] }) : null,
        Box({
          flexDirection: 'row',
          children: [
            Button({ key: 'su', label: 'Su', hotkey: 'k', onPress: move(-1) }),
            Text({ children: [' '] }),
            Button({ key: 'giu', label: 'Giù', hotkey: 'j', onPress: move(1) }),
            Text({ children: ['  '] }),
            ...ACTIONS.flatMap((a) => [Button({ key: a.key, label: a.label, hotkey: a.hotkey, variant: a.key === 'bozza' ? 'primary' : undefined, onPress: act(a) }), Text({ children: [' '] })]),
          ],
        }),
        outcome ? Text({ dimColor: true, children: ['Inviato: ' + outcome] }) : null,
        theirs,
      ].filter(Boolean),
    })
  })
}
