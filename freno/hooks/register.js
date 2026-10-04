// Le tre risposte della domanda: le etichette servono anche a riconoscere la scelta
const GO = 'Esegui'
const DRY = 'Prova a secco'
const NO = 'Annulla'

// Se il comando è già una prova a secco non c'è niente da frenare
const DRY_RUN = /--dry-run|--simulate|\bdry[-_ ]?run\b|--no-act/i

// Comandi Bash da frenare: [espressione, tipo, descrizione]. "cancella" non si annulla, "esterno" esce dalla macchina
const BASH_RULES = [
  [/\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b/, 'cancella', 'cancella file e cartelle in modo ricorsivo'],
  [/\bgit\s+push\b[^|;&]*(--force\b|--force-with-lease\b|\s-f\b)/, 'cancella', 'push forzato: riscrive la storia sul remoto'],
  [/\bgit\s+reset\s+--hard\b/, 'cancella', 'reset --hard: perde le modifiche non committate'],
  [/\bgit\s+clean\s+-[a-zA-Z]*[fd]/, 'cancella', 'git clean: cancella file non tracciati'],
  [/\bgit\s+(checkout|restore)\s+(--\s+)?\.(\s|$)/, 'cancella', 'ripristina tutto il working tree'],
  [/\bgit\s+branch\s+-D\b/, 'cancella', 'cancella un branch senza controllare che sia unito'],
  [/\b(drop|truncate)\s+(table|database|schema)\b/i, 'cancella', 'cancella una tabella o un database'],
  [/--(elimina|delete|purge|destroy)\b/, 'cancella', 'opzione di eliminazione di uno script'],
  [/--(applica|apply)\b/, 'esterno', 'applica davvero le modifiche di uno script'],
  [/\bcurl\b[^|;&]*-X\s*(DELETE|PUT|PATCH|POST)\b/i, 'esterno', 'scrive su un servizio esterno'],
  [/\bgh\s+(pr|issue|release|repo)\s+(merge|close|delete|create)\b/, 'esterno', 'modifica qualcosa su GitHub'],
]

// Tool MCP da frenare, dal nome: cancellare è irreversibile, inviare e pubblicare escono verso gli altri
const MCP_DELETE = /(delete|trash|remove|destroy|drop|purge)/i
const MCP_OUT = /(send|reply|forward|publish|schedule|post_|_post|create_post|update_post)/i
const MCP_READ = /^(get|list|search|fetch|query|read|find|check|validate|resolve|download)/i

// Dalla chiamata a una descrizione di cosa si sta per fare, oppure null se non c'è da frenare
export function classify(e) {
  if (e.tool === 'Bash') {
    const cmd = e.command ?? ''
    if (DRY_RUN.test(cmd)) return null
    const hit = BASH_RULES.find(([re]) => re.test(cmd))
    return hit ? { kind: hit[1], why: hit[2], what: cmd.replace(/\s+/g, ' ').trim().slice(0, 160) } : null
  }
  const m = /^mcp__(.+?)__(.+)$/.exec(e.tool ?? '')
  if (!m) return null
  const [, server, tool] = m
  const name = tool.replace(/^notion-/, '')
  if (MCP_READ.test(name)) return null
  const kind = MCP_DELETE.test(name) ? 'cancella' : MCP_OUT.test(name) ? 'esterno' : null
  if (!kind) return null
  const label = server.length > 24 ? server.slice(0, 8) : server
  return { kind, why: kind === 'cancella' ? 'cancella dati su un servizio esterno' : 'pubblica o invia verso l\'esterno', what: label + ' · ' + name.replace(/_/g, ' ') }
}

// Il testo della domanda, con tutto ciò che serve per decidere
export function question(info) {
  const head = info.kind === 'cancella' ? 'Azione irreversibile' : 'Azione verso l\'esterno'
  return head + ': ' + info.why + '. ' + info.what + '. Cosa faccio?'
}

// Il messaggio che il modello riceve quando la chiamata non parte
export function denial(choice) {
  if (choice === DRY)
    return 'Non eseguire ancora. Prima fai una prova a secco: mostra cosa verrebbe toccato (usa --dry-run se esiste, altrimenti un comando di sola lettura che elenchi gli elementi), poi chiedi conferma.'
  return 'L\'utente ha annullato questa azione. Non ritentarla né cercare un modo equivalente: chiedi come procedere.'
}

export function register(on) {
  // Con qualcuno al prompt una domanda chiusa senza risposta vale come Annulla; senza nessuno decide il sistema di permessi
  let isInteractive = true
  on('session.start', ($, e, next) => {
    isInteractive = e.isInteractive
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const info = classify(e)
    if (!info) return next(e)

    let choice = NO
    try {
      choice = await $.ui.ask(question(info), { options: [GO, DRY, NO], header: 'Freno' })
    } catch {
      if (!isInteractive) return next(e)
    }
    if (choice === GO) return next(e)
    return { deny: denial(choice === DRY ? DRY : NO) }
  })
}
