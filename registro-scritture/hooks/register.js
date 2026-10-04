// Quante righe mostrare al massimo nella banda
const MAX_ROWS = 6

// Nomi leggibili dei server MCP, per id: gli id di connettore non dicono nulla a chi legge
const SERVICES = {
  '46dded4b-f2d2-4af7-9ae7-1db030709c49': 'Notion',
  'notion-dynamopet': 'Notion',
  '1ff0d358-ee8f-4832-ba13-c6e721d4279a': 'Postpickr',
  spreaker: 'Spreaker',
  'e14c09e8-d3bf-4f30-b839-ba795465d6b4': 'Gmail',
  'a285c429-44b8-44f9-b44f-9c08802563f2': 'Calendar',
  'fddf164c-988b-40b7-8e10-230200893b51': 'Drive',
  '2c0cccdf-c9e4-4599-8288-c7436f57125a': 'Vercel',
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
export function describe(e) {
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
    service: SERVICES[server] ?? server,
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

export function register(on) {
  // Ogni chiamata: la lasciamo passare, poi annotiamo che cosa è successo
  on('tool.call', async ($, e, next) => {
    const what = describe(e)
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
    if (!e.agentId) {
      shown = pending
      pending = []
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const theirs = await next(e)
    if (!shown.length || e.props.isWorking) return theirs
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
