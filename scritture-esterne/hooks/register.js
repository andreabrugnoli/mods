// Quante righe mostrare al massimo nella banda
const MAX_ROWS = 6

// Nomi leggibili dei server MCP riconosciuti dal nome; i connettori con id opaco si nominano nelle opzioni
const KNOWN = [
  [/notion/i, 'Notion'],
  [/spreaker/i, 'Spreaker'],
  [/postpickr/i, 'Postpickr'],
  [/gmail/i, 'Gmail'],
  [/calendar/i, 'Calendar'],
  [/drive/i, 'Drive'],
  [/vercel/i, 'Vercel'],
  [/stripe/i, 'Stripe'],
  [/github/i, 'GitHub'],
  [/slack/i, 'Slack'],
  [/linear/i, 'Linear'],
]
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-/i

// Dall'opzione "servizi" ("id=Nome, id=Nome") alla mappa id -> nome
export function parseServices(text) {
  const map = {}
  for (const part of String(text ?? '').split(',')) {
    const [id, ...name] = part.split('=')
    if (id && name.length) map[id.trim()] = name.join('=').trim()
  }
  return map
}

// Il nome da mostrare per un server: prima le opzioni, poi il nome noto, poi l'id accorciato
export function serviceLabel(server, custom = {}) {
  if (custom[server]) return custom[server]
  const known = KNOWN.find(([re]) => re.test(server))
  if (known) return known[1]
  return UUID.test(server) ? server.slice(0, 8) : server
}

// Un tool MCP scrive se il nome contiene un verbo di scrittura e non uno di sola lettura
const READ_VERB = /^(get|list|search|fetch|query|read|find|check|validate|resolve|download)/
const WRITE_VERB = /(create|update|delete|trash|send|schedule|reschedule|publish|post|upload|move|duplicate|reply|forward|label|write|add|remove|set|save|stop|spawn)/

// Le chiavi dell'input che meglio dicono "su cosa" è stata fatta la scrittura
const TARGET_KEYS = ['title', 'name', 'subject', 'messaggio', 'page_id', 'id', 'project_id', 'url']

// Le scritture del turno in corso, e quelle del turno concluso da mostrare
let pending = []
let shown = []

// Accorcia un testo su una riga
function clip(text, n) {
  const one = String(text).replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n - 1) + '…' : one
}

// Dice se una chiamata è una scrittura esterna e la descrive, altrimenti null
export function describe(e, custom = {}) {
  if (e.tool === 'Bash') {
    const cmd = e.command ?? ''
    if (/\bgit\s+push\b/.test(cmd)) return { service: 'git', action: 'push', target: clip(cmd, 60) }
    if (/\bgh\s+(pr|issue|release|repo)\s+(create|merge|close|comment|edit|delete)/.test(cmd)) return { service: 'GitHub', action: 'modifica', target: clip(cmd, 60) }
    if (/\bcurl\b.*-X\s*(POST|PUT|PATCH|DELETE)/.test(cmd)) return { service: 'HTTP', action: 'scrittura', target: clip(cmd, 60) }
    if (/--(applica|elimina|apply|delete)\b/.test(cmd)) return { service: 'script', action: 'applica', target: clip(cmd, 60) }
    return null
  }
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(e.tool)
  if (!m) return null
  const [, server, tool] = m
  if (READ_VERB.test(tool) || !WRITE_VERB.test(tool)) return null
  const key = TARGET_KEYS.find((k) => e[k] !== undefined && typeof e[k] !== 'object')
  return {
    service: serviceLabel(server, custom),
    action: tool.replace(/^notion-/, '').replace(/_/g, ' '),
    target: key ? clip(e[key], 50) : '',
  }
}

// Il primo link https nel risultato del tool, se c'è
export function findLink(text) {
  const m = /https:\/\/[^\s"'<>)\]]+/.exec(text ?? '')
  return m ? m[0].replace(/[.,;]+$/, '') : null
}

// Un esito è dubbio se il tool ha segnalato errore o il testo dice che è fallito
export function isBad(result) {
  if (result.isError === true) return true
  return /"?(error|errore|failed|unauthorized|forbidden)"?\s*[:=]/i.test(result.text ?? '')
}

// Il nuovo stato dopo un comando: "on" accende, "off" spegne, senza argomento alterna
export function parseToggle(args, current) {
  const arg = String(args ?? '').trim().toLowerCase()
  if (/^(on|acceso|attiva|si|sì)$/.test(arg)) return true
  if (/^(off|spento|disattiva|no)$/.test(arg)) return false
  return !current
}

// Acceso o spento: lo decide /scritture e resta nello store tra una sessione e l'altra
let enabled = true

export function register(on, options) {
  // I nomi dei connettori con id opaco, scritti dall'utente nelle opzioni
  const custom = parseServices(options?.servizi)

  on('session.start', async ($, e, next) => {
    try {
      if ((await $.store.get('attiva')) === false) enabled = false
    } catch {}
    await $.command.register({ name: 'scritture', description: 'Accende o spegne il registro delle scritture esterne', argumentHint: '[on|off]', immediate: true })
    return next(e)
  })

  on('command.run', { command: 'scritture' }, async ($, e) => {
    enabled = parseToggle(e.args, enabled)
    pending = []
    shown = []
    try {
      await $.store.set('attiva', enabled)
    } catch {}
    $.ui.invalidate('ui.render')
    return { text: 'scritture-esterne · ' + (enabled ? 'acceso' : 'spento') }
  })

  // Ogni chiamata: la lasciamo passare, poi annotiamo che cosa è successo
  on('tool.call', async ($, e, next) => {
    if (!enabled) return next(e)
    const what = describe(e, custom)
    const ran = await next(e)
    if (what && !e.agentId) {
      const denied = ran.deny !== undefined
      pending.push({
        ...what,
        state: denied ? 'negata' : isBad(ran) ? 'errore' : 'ok',
        link: denied ? null : findLink(ran.text),
      })
    }
    return ran
  })

  // Un nuovo turno cancella il registro del precedente
  on('turn.start', ($, e, next) => {
    if (!e.agentId) {
      pending = []
      if (shown.length) {
        shown = []
        $.ui.invalidate('ui.render')
      }
    }
    return next(e)
  })

  // A fine turno il registro diventa visibile
  on('turn.complete', ($, e, next) => {
    if (enabled && !e.agentId) {
      shown = pending
      pending = []
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const theirs = await next(e)
    if (!enabled || !shown.length || e.props.isWorking) return theirs
    const { Box, Text, Link } = $.ui.resolve(e)
    const bad = shown.filter((r) => r.state !== 'ok').length
    const head = Text({
      color: bad ? 'red' : undefined,
      dimColor: !bad,
      children: ['scritto fuori dalla repo · ' + shown.length + (shown.length === 1 ? ' azione' : ' azioni') + (bad ? ' · ' + bad + ' da controllare' : '')],
    })
    const rows = shown.slice(0, MAX_ROWS).map((r) =>
      Box({
        flexDirection: 'row',
        children: [
          Text({ color: r.state === 'ok' ? 'green' : 'red', children: [r.state === 'ok' ? '✓ ' : '✗ '] }),
          Text({ children: [r.service + ' · ' + r.action + (r.target ? ' · ' + r.target : '')] }),
          r.state !== 'ok' && Text({ color: 'red', children: [' (' + r.state + ')'] }),
          r.link && Text({ children: ['  '] }),
          r.link && Link({ href: r.link, label: 'apri' }),
        ].filter(Boolean),
      }),
    )
    const more = shown.length > MAX_ROWS ? [Text({ dimColor: true, children: ['… e altre ' + (shown.length - MAX_ROWS)] })] : []
    return Box({ flexDirection: 'column', children: [head, ...rows, ...more, theirs].filter(Boolean) })
  })
}
