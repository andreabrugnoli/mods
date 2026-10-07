// Quanto dura la prompt cache dall'ultima richiesta che l'ha letta o scritta
const TTL_MS = 60 * 60 * 1000
// La durata breve della cache (5 minuti), e la pausa minima per capire quale delle due è in uso
const SHORT_TTL_MS = 5 * 60 * 1000
const GAP_MIN_MS = 6 * 60 * 1000
// La durata in uso: parte da un'ora e si corregge da sola osservando la cache letta dopo una pausa
let ttlMs = TTL_MS
// Ogni quanto la barra si ridisegna da sola
const TICK_MS = 30 * 1000

// L'istante dell'ultima richiesta della conversazione principale: da lì riparte l'ora
let lastAt = null
// L'ora letta all'ultimo tick o all'ultima richiesta
let now = 0
// Il timer che fa scorrere la barra, avviato alla prima richiesta
let ticking = null

// Soglie dei colori: contesto in percentuale, costo di un turno in dollari, cache letta in percentuale
const CONTEXT_WARN = 60
const CONTEXT_BAD = 80
const COST_WARN = 0.5
const CACHE_OK = 80
const CACHE_BAD = 50

// Il contesto e il costo letti dal motore: { percent, tokens, window, usd }, null dove non rispondono
let usage = null
// Il turno concluso: { usd, fresh, out }, dove "fresh" sono i token pagati interi (non letti dalla cache)
let lastTurn = null
// Il costo della sessione al termine del turno precedente, per sottrarlo
let costBefore = null
// I token del turno in corso, sommati richiesta per richiesta
let turnFresh = 0
let turnOut = 0
// Quanta parte dell'ultima richiesta è stata letta dalla cache, da 0 a 100
let cacheReadPct = null

// L'istante in cui è cominciata la sessione, ripreso dall'archivio se è la stessa sessione
let startedAt = null

// Durata in forma breve: 45 min, 2h 14m
function duration(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60000))
  return minutes < 60 ? minutes + ' min' : Math.floor(minutes / 60) + 'h ' + (minutes % 60) + 'm'
}

// Token in forma breve: 950, 12k, 1,2M
function short(n) {
  const one = (x) => x.toFixed(1).replace('.', ',').replace(/,0$/, '')
  if (n >= 1e6) return one(n / 1e6) + 'M'
  if (n >= 1e4) return Math.round(n / 1e3) + 'k'
  if (n >= 1e3) return one(n / 1e3) + 'k'
  return String(n)
}

// Token in parole: 950, 12mila, 1,2 milioni
function tokensIt(n) {
  const one = (x) => x.toFixed(1).replace('.', ',').replace(/,0$/, '')
  if (n >= 1e6) return one(n / 1e6) + ' milioni'
  if (n >= 1e4) return Math.round(n / 1e3) + 'mila'
  if (n >= 1e3) return one(n / 1e3) + 'mila'
  return String(n)
}

// Dollari con due decimali, la virgola e il simbolo dopo la cifra: 0,42 $
function dollars(n) {
  return n.toFixed(2).replace('.', ',') + ' $'
}

// Le finestre di consumo dell'abbonamento riportate dal motore: [{ kind, percentUsed }]
let limits = []
// Acceso o spento: lo decide /barra e resta nello store tra una sessione e l'altra
let enabled = true

// Il nuovo stato dopo un comando: "on" accende, "off" spegne, senza argomento alterna
export function parseToggle(args, current) {
  const arg = String(args ?? '').trim().toLowerCase()
  if (/^(on|acceso|attiva|si|sì)$/.test(arg)) return true
  if (/^(off|spento|disattiva|no)$/.test(arg)) return false
  return !current
}

function contextColor(percent) {
  return percent > CONTEXT_BAD ? 'red' : percent > CONTEXT_WARN ? 'yellow' : 'green'
}

function cacheColor(percent) {
  return percent >= CACHE_OK ? 'green' : percent >= CACHE_BAD ? 'yellow' : 'red'
}

// Registra i cifre che il motore riporta a ogni misura: contesto e costo (la banda si ridisegna da sola)
function applyMeasure(e) {
  usage = e.context.percent === undefined ? usage : { percent: e.context.percent, tokens: e.context.tokens ?? 0, window: e.context.window, usd: e.cost?.usd }
  if (e.cost && usage) usage.usd = e.cost.usd
  if (Array.isArray(e.rateLimits)) limits = e.rateLimits
}

// Chiude il turno: costo e token del turno appena finito, poi si riparte da zero
function closeTurn() {
  if (turnFresh > 0 || turnOut > 0) {
    const usd = usage && usage.usd !== undefined && costBefore !== null ? Math.max(0, usage.usd - costBefore) : null
    lastTurn = { usd, fresh: turnFresh, out: turnOut }
  }
  if (usage && usage.usd !== undefined) costBefore = usage.usd
  turnFresh = 0
  turnOut = 0
}

// Le stesse cifre della banda, in righe di testo per il comando /cache
function usageLines() {
  const lines = []
  if (usage) lines.push('contesto · ' + usage.percent + '% (' + short(usage.tokens) + ' su ' + short(usage.window) + ')' + (usage.percent > CONTEXT_BAD ? ', conviene /nuova' : ''))
  if (lastTurn) lines.push('ultimo turno · ' + (lastTurn.usd === null ? '' : dollars(lastTurn.usd) + ' · ') + short(lastTurn.fresh) + ' token nuovi, ' + short(lastTurn.out) + ' generati')
  if (usage && usage.usd !== undefined) lines.push('sessione · ' + dollars(usage.usd))
  if (startedAt !== null) lines.push('sessione · ' + duration(Math.max(0, now - startedAt)))
  if (cacheReadPct !== null) lines.push('cache letta · ' + cacheReadPct + '% dell\'ultima richiesta')
  return lines
}

// Il prompt del bottone "Commit e push"
const COMMIT_PROMPT =
  'Esegui ora: git status, poi git add delle modifiche pertinenti, un commit con messaggio breve in italiano e git push sul branch corrente (git push -u origin <branch>). Prima di aggiungere, controlla i file: se tra le modifiche ci sono file sensibili (.env, chiavi, token, credenziali, certificati), non aggiungerli e chiedimi conferma. Se non ci sono modifiche, dillo e fermati. Non modificare altro.'

// Il prompt del push quando git non è raggiungibile
const PUSH_PROMPT = 'Esegui ora git push sul branch corrente (git push -u origin <branch> se manca l\'upstream). Non modificare altro.'

// Lo stato della repo letto da git: { branch, changed, ahead, hasUpstream }, null se non disponibile
// (fuori da una repo, o dove $.process non esiste, come nelle sessioni cloud)
let git = null

// Legge l'intestazione e le righe di `git status --porcelain=v1 -b`
function parseGit(stdout) {
  const lines = stdout.split('\n').filter(Boolean)
  const head = (lines.shift() ?? '').replace(/^## /, '')
  const m = head.match(/^(.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/)
  const ahead = Number(/ahead (\d+)/.exec(m?.[3] ?? '')?.[1] ?? 0)
  return { branch: m?.[1] ?? head, changed: lines.length, ahead, hasUpstream: Boolean(m?.[2]) }
}

// Rilegge lo stato; in caso di errore la banda torna ai bottoni che passano dal modello
async function refreshGit($) {
  try {
    const { exitCode, stdout } = await $.process.run(['git', 'status', '--porcelain=v1', '-b'])
    git = exitCode === 0 ? parseGit(stdout) : null
  } catch {
    git = null
  }
  $.ui.invalidate('ui.render')
}

// Fa il push direttamente con git, senza token. Dove non si può, lo chiede al modello
async function pushNow($) {
  if (git === null) return $.prompt.submit({ text: PUSH_PROMPT })
  const argv = git.hasUpstream ? ['git', 'push'] : ['git', 'push', '-u', 'origin', 'HEAD']
  try {
    const { exitCode, stderr } = await $.process.run(argv, { timeoutMs: 60000 })
    const last = stderr.trim().split('\n').pop() ?? ''
    $.ui.toast(exitCode === 0 ? 'Push fatto su ' + git.branch : 'Push fallito: ' + last.slice(0, 120))
  } catch {
    $.ui.toast('Push non riuscito: git non risponde')
  }
  await refreshGit($)
}

// Il prompt del bottone "Nuova chat": il riassunto va in un file, poi la chat riparte da lì
function handoffPrompt(file) {
  return (
    'Prepara il passaggio a una nuova chat per risparmiare contesto. Scrivi in ' +
    file +
    ' (crea la cartella se manca) un riassunto che permetta di riprendere dallo stesso punto: obiettivo, decisioni prese, stato attuale, file toccati con percorso assoluto, cartella di lavoro corrente, comandi utili, prossimi passi, punti aperti. Solo fatti, niente cronaca. Non fare altro. Rispondi con una riga.'
  )
}

// Un'azione chiesta da un comando: prompt.submit non si può chiamare dentro command.run, parte a fine turno
let queued = null

// Il file di passaggio per la sessione in corso, atteso dopo il riassunto
let handoffFile = null

// Avvia il passaggio a una nuova chat: il riassunto va in un file, il resto lo fa turn.complete
async function startHandoff($) {
  const id = await $.session.id()
  handoffFile = '~/.claude/handoffs/' + id + '.md'
  $.ui.toast('Riassunto in corso, poi la chat riparte pulita')
  await $.prompt.submit({ text: handoffPrompt(handoffFile) })
}

// Fa scorrere la barra, una volta sola
function startTicking($) {
  ticking ??= $.clock.every(TICK_MS, async () => {
    try {
      now = await $.clock.now()
      $.ui.invalidate('ui.render')
    } catch {}
  })
}

// Verde finché c'è margine, rosso quando la cache sta per scadere
function leftColor(minutes) {
  if (minutes > 20) return 'green'
  if (minutes > 5) return 'yellow'
  return 'red'
}

export function register(on) {
  // Gli stessi servizi come comandi, per le superfici che non disegnano la banda
  on('session.start', async ($, e, next) => {
    // Un ricaricamento della mod o una ripresa della stessa sessione non azzerano la barra
    try {
      const saved = await $.store.get('last')
      const t = await $.clock.now()
      const savedTtl = await $.store.get('ttl')
      if (savedTtl === SHORT_TTL_MS || savedTtl === TTL_MS) ttlMs = savedTtl
      const started = await $.store.get('started')
      if (started && started.id === (await $.session.id())) startedAt = started.at
      if (saved && saved.id === (await $.session.id()) && t - saved.at < ttlMs) {
        lastAt = saved.at
        now = t
        startTicking($)
      }
    } catch {}
    try {
      if ((await $.store.get('attiva')) === false) enabled = false
    } catch {}
    const specs = [
      { name: 'barra', description: 'Accende o spegne la barra sopra il prompt', argumentHint: '[on|off]', immediate: true },
      { name: 'cache', description: 'Quanto resta della prompt cache' },
      { name: 'push', description: 'Pubblica i commit del branch corrente' },
      { name: 'nuova', description: 'Riassume e riparte da una chat pulita' },
      { name: 'handoff', description: 'Riassume e riparte da una chat pulita (come il bottone Handoff)' },
    ]
    for (const spec of specs) await $.command.register(spec)
    void refreshGit($)
    // Nelle chat nuove l'elenco dei comandi può essere già chiuso a questo punto: si ripete dopo poco
    for (const ms of [1500, 5000]) {
      $.clock.after(ms, () => {
        for (const spec of specs) void $.command.register(spec).catch(() => {})
      })
    }
    return next(e)
  })

  on('command.run', { command: 'barra' }, async ($, e) => {
    enabled = parseToggle(e.args, enabled)
    try {
      await $.store.set('attiva', enabled)
    } catch {}
    if (enabled) void refreshGit($)
    $.ui.invalidate('ui.render')
    return { text: 'barra-cache · ' + (enabled ? 'accesa' : 'spenta') }
  })

  on('command.run', { command: 'cache' }, async ($) => {
    const extra = usageLines()
    const join = (first) => [first, ...extra].join('\n')
    if (lastAt === null) return { text: join('cache · in attesa della prima richiesta') }
    const t = await $.clock.now()
    const leftMs = Math.max(0, ttlMs - (t - lastAt))
    if (leftMs === 0) return { text: join('cache scaduta: la prossima richiesta la riscrive') }
    const minutes = Math.ceil(leftMs / 60000)
    return { text: join('cache · ' + minutes + ' min rimasti, ' + (60 - minutes) + ' min dall\'ultima richiesta') }
  })

  on('command.run', { command: 'push' }, async ($) => {
    queued = 'push'
    return { text: 'Push avviato.' }
  })

  for (const command of ['nuova', 'handoff']) {
    on('command.run', { command }, async ($) => {
      queued = 'nuova'
      return { text: 'Passaggio avviato: riassunto, poi chat pulita.' }
    })
  }

  // Dopo il riassunto: svuota la chat e riparte dal file. Il comando va in coda, non si attende dentro il turno
  on('turn.complete', async ($, e, next) => {
    // git status dura pochi millisecondi: lo si attende, così la banda è già aggiornata a fine turno
    if (!e.agentId) {
      if (enabled) await refreshGit($)
      closeTurn()
    }
    if (!e.agentId && handoffFile) {
      const file = handoffFile
      handoffFile = null
      void (async () => {
        try {
          await $.command.run({ command: 'clear' })
          await $.prompt.submit({ text: 'Riprendi il lavoro dal punto in cui eravamo: leggi ' + file + ' e continua da lì. Conferma in una riga cosa hai capito, poi procedi.' })
        } catch {
          $.ui.toast('Riassunto in ' + file + ': lancia /clear e fallo leggere')
        }
      })()
    }
    if (!e.agentId && queued) {
      const action = queued
      queued = null
      void (action === 'push' ? pushNow($) : startHandoff($))
    }
    return next(e)
  })

  // Il motore riporta contesto e costo quando si muovono: la banda li mostra
  on('session.measure', ($, e, next) => {
    applyMeasure(e)
    $.ui.invalidate('ui.render')
    return next(e)
  })

  // Una richiesta al modello rinnova la cache: l'ora riparte dal suo risultato
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    // Solo la conversazione principale: i subagent hanno una cache loro
    if (!e.agentId && result.usage) {
      const u = result.usage
      turnFresh += u.input_tokens + u.cache_creation_input_tokens
      turnOut += u.output_tokens
      const total = u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens
      cacheReadPct = total > 0 ? Math.round((u.cache_read_input_tokens / total) * 100) : null
      const t = await $.clock.now()
      // Dopo una pausa lunga la cache letta dice quale durata ha davvero: letta = dura, riscritta = è scaduta
      if (lastAt !== null && total >= 2000 && t - lastAt >= GAP_MIN_MS) {
        const ratio = u.cache_read_input_tokens / total
        const learned = ratio > 0.6 ? TTL_MS : ratio < 0.2 && t - lastAt < TTL_MS ? SHORT_TTL_MS : null
        if (learned !== null && learned !== ttlMs) {
          ttlMs = learned
          $.ui.toast('Cache: durata rilevata ' + Math.round(ttlMs / 60000) + ' min')
          try {
            await $.store.set('ttl', ttlMs)
          } catch {}
        }
      }
      lastAt = now = t
      if (startedAt === null) {
        startedAt = lastAt
        try {
          await $.store.set('started', { id: await $.session.id(), at: startedAt })
        } catch {}
      }
      startTicking($)
      try {
        await $.store.set('last', { id: await $.session.id(), at: lastAt })
      } catch {}
      $.ui.invalidate('ui.render')
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Quello che disegnano le altre mod nella banda resta sotto le nostre righe
    const theirs = await next(e)
    if (!enabled) return theirs
    // L'ora si rilegge a ogni disegno: non dipende dal timer, che può fermarsi
    try {
      now = await $.clock.now()
    } catch {}
    const { Box, Text, Button } = $.ui.resolve(e)
    const dim = (text) => Text({ dimColor: true, children: [text] })
    const strong = (text, color) => Text(color ? { bold: true, color, children: [text] } : { bold: true, children: [text] })
    const row = (children) => Box({ flexDirection: 'row', flexWrap: 'wrap', children: children.filter(Boolean) })
    const gap = Text({ children: ['  '] })
    // Con lo stato di git i bottoni compaiono solo se c'è qualcosa da fare
    const hasChanges = git === null || git.changed > 0
    const canPush = git !== null && git.changed === 0 && (git.ahead > 0 || !git.hasUpstream)
    const buttons = Box({
      flexDirection: 'row',
      children: [
        hasChanges && Button({ key: 'commit', label: 'Commit e push', hotkey: 'g', onPress: () => $.prompt.submit({ text: COMMIT_PROMPT }) }),
        hasChanges && gap,
        canPush && Button({ key: 'push', label: 'Push', hotkey: 'p', onPress: () => pushNow($) }),
        canPush && gap,
        Button({
          key: 'fresh',
          label: 'Handoff',
          hotkey: 'n',
          onPress: () => startHandoff($),
        }),
      ].filter(Boolean),
    })
    const gitLine =
      git === null
        ? null
        : Box({
            flexDirection: 'row',
            children: [
              dim('repo · ' + git.branch + ' · '),
              Text(git.changed > 0 ? { color: 'yellow', children: [git.changed + ' modificati'] } : { dimColor: true, children: ['0 modificati'] }),
              dim(' · '),
              Text(git.ahead > 0 ? { color: 'yellow', children: [git.ahead + ' da pushare'] } : { dimColor: true, children: ['0 da pushare'] }),
            ],
          })
    // Niente props indefinite: il colore è scelto prima
    const paint = (text, color) => Text(color ? { color, children: [text] } : { dimColor: true, children: [text] })
    const barWidth = e.props.bodyColumns >= 110 ? 12 : 8

    // Una barra piena per la parte usata, vuota per il resto
    const bar = (fraction, color) => {
      const full = Math.min(barWidth, Math.max(0, Math.ceil(fraction * barWidth)))
      return [paint('█'.repeat(full), color), dim('░'.repeat(barWidth - full))]
    }

    // Riga 1: la memoria della chat, cioè il contesto occupato, e quanto è costata a listino
    const memory = usage
      ? row([
          dim('🧠 memoria della chat '),
          ...bar(usage.percent / 100, contextColor(usage.percent)),
          dim(' '),
          strong(tokensIt(usage.tokens) + ' token'),
          usage.usd !== undefined && dim(' · speso ' + dollars(usage.usd) + ' a listino'),
          usage.percent > CONTEXT_BAD && paint(' · Nuova chat?', 'red'),
        ])
      : null

    // Riga 2: i consumi dell'abbonamento, ognuno solo se il motore ha riportato la cifra
    const limitRow = (kind, icon, label) => {
      const found = limits.find((l) => l.kind === kind)
      if (!found) return null
      const percent = Math.round(found.percentUsed)
      return row([dim(icon + ' ' + label + ' '), ...bar(found.percentUsed / 100, contextColor(percent)), dim(' '), strong(percent + '%', percent > CONTEXT_BAD ? 'red' : null)])
    }
    const five = limitRow('five_hour', '⏳', 'uso 5 ore')
    const week = limitRow('seven_day', '📅', 'uso settimana')
    const usageRow = five || week ? row([five, five && week && gap, week]) : null

    // Riga 3: da quanto è aperta la sessione e quanto resta della cache
    let isCold = false
    let cacheSeg
    if (lastAt === null) {
      cacheSeg = dim('🔥 cache in attesa della prima richiesta')
    } else {
      const leftMs = Math.max(0, ttlMs - (now - lastAt))
      if (leftMs === 0) {
        isCold = true
        cacheSeg = row([dim('🧊 cache '), paint('scaduta', 'red')])
      } else {
        const minutes = Math.ceil(leftMs / 60000)
        cacheSeg = row([dim('🔥 cache calda ancora '), strong(minutes + ' min', leftColor(minutes) === 'green' ? null : leftColor(minutes))])
      }
    }
    const sessionRow = row([startedAt !== null && dim('🕒 sessione aperta da '), startedAt !== null && strong(duration(Math.max(0, now - startedAt))), startedAt !== null && gap, cacheSeg])

    // Cache scaduta con un contesto grande: il prossimo prompt riscrive tutto a prezzo pieno
    const coldWarn =
      isCold && usage && usage.tokens >= 20000
        ? Box({ flexDirection: 'row', children: [paint('Cache scaduta · il prossimo prompt riscrive ' + tokensIt(usage.tokens) + ' token', 'red'), dim(' · se cambi argomento conviene Nuova chat')] })
        : null

    const lines = [memory, usageRow, sessionRow]
    return Box({
      flexDirection: 'column',
      children: (e.props.isWorking ? [...lines, theirs] : [...lines, coldWarn, gitLine, buttons, theirs]).filter(Boolean),
    })
  })
}
