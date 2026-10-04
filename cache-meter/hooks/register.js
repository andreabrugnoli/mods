// Quanto dura la prompt cache dall'ultima richiesta che l'ha letta o scritta
const TTL_MS = 60 * 60 * 1000
// Ogni quanto la barra si ridisegna da sola
const TICK_MS = 30 * 1000

// L'istante dell'ultima richiesta della conversazione principale: da lì riparte l'ora
let lastAt = null
// L'ora letta all'ultimo tick o all'ultima richiesta
let now = 0
// Il timer che fa scorrere la barra, avviato alla prima richiesta
let ticking = null

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
    ' (crea la cartella se manca) un riassunto che permetta di riprendere dallo stesso punto: obiettivo, decisioni prese, stato attuale, file toccati con percorso, comandi utili, prossimi passi, punti aperti. Solo fatti, niente cronaca. Non fare altro. Rispondi con una riga.'
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
    now = await $.clock.now()
    $.ui.invalidate('ui.render')
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
      if (saved && saved.id === (await $.session.id()) && t - saved.at < TTL_MS) {
        lastAt = saved.at
        now = t
        startTicking($)
      }
    } catch {}
    await $.command.register({ name: 'cache', description: 'Quanto resta della prompt cache' })
    await $.command.register({ name: 'push', description: 'Pubblica i commit del branch corrente' })
    void refreshGit($)
    await $.command.register({ name: 'nuova', description: 'Riassume e riparte da una chat pulita' })
    return next(e)
  })

  on('command.run', { command: 'cache' }, async ($) => {
    if (lastAt === null) return { text: 'cache · in attesa della prima richiesta' }
    const t = await $.clock.now()
    const leftMs = Math.max(0, TTL_MS - (t - lastAt))
    if (leftMs === 0) return { text: 'cache scaduta: la prossima richiesta la riscrive' }
    const minutes = Math.ceil(leftMs / 60000)
    return { text: 'cache · ' + minutes + ' min rimasti, ' + (60 - minutes) + ' min dall\'ultima richiesta' }
  })

  on('command.run', { command: 'push' }, async ($) => {
    queued = 'push'
    return { text: 'Push avviato.' }
  })

  on('command.run', { command: 'nuova' }, async ($) => {
    queued = 'nuova'
    return { text: 'Passaggio avviato: riassunto, poi chat pulita.' }
  })

  // Dopo il riassunto: svuota la chat e riparte dal file. Il comando va in coda, non si attende dentro il turno
  on('turn.complete', async ($, e, next) => {
    // git status dura pochi millisecondi: lo si attende, così la banda è già aggiornata a fine turno
    if (!e.agentId) await refreshGit($)
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

  // Una richiesta al modello rinnova la cache: l'ora riparte dal suo risultato
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    // Solo la conversazione principale: i subagent hanno una cache loro
    if (!e.agentId && result.usage) {
      lastAt = now = await $.clock.now()
      startTicking($)
      try {
        await $.store.set('last', { id: await $.session.id(), at: lastAt })
      } catch {}
      $.ui.invalidate('ui.render')
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Quello che disegnano le altre mod nella banda resta sotto la nostra riga
    const theirs = await next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const dim = (text) => Text({ dimColor: true, children: [text] })
    // Con lo stato di git i bottoni compaiono solo se c'è qualcosa da fare
    const hasChanges = git === null || git.changed > 0
    const canPush = git !== null && git.changed === 0 && (git.ahead > 0 || !git.hasUpstream)
    const gap = Text({ children: ['  '] })
    const buttons = Box({
      flexDirection: 'row',
      children: [
        hasChanges && Button({ key: 'commit', label: 'Commit e push', hotkey: 'g', onPress: () => $.prompt.submit({ text: COMMIT_PROMPT }) }),
        hasChanges && gap,
        canPush && Button({ key: 'push', label: 'Push', hotkey: 'p', onPress: () => pushNow($) }),
        canPush && gap,
        Button({
          key: 'fresh',
          label: 'Nuova chat',
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
    const withTheirs = (line) =>
      Box({ flexDirection: 'column', children: e.props.isWorking ? [line, theirs].filter(Boolean) : [line, gitLine, buttons, theirs].filter(Boolean) })

    if (lastAt === null) return withTheirs(dim('cache · in attesa della prima richiesta'))

    const width = e.props.bodyColumns >= 110 ? 24 : 12
    const leftMs = Math.max(0, TTL_MS - (now - lastAt))

    if (leftMs === 0) {
      return withTheirs(
        Box({
          flexDirection: 'row',
          children: [
            dim('cache  ' + '░'.repeat(width) + '  '),
            Text({ color: 'red', children: ['scaduta'] }),
            dim(' · la prossima richiesta la riscrive'),
          ],
        }),
      )
    }

    // La parte piena è il tempo che resta: la barra si svuota da destra
    const minutes = Math.ceil(leftMs / 60000)
    const full = Math.ceil((leftMs / TTL_MS) * width)
    const color = leftColor(minutes)
    return withTheirs(
      Box({
        flexDirection: 'row',
        children: [
          dim('cache  '),
          Text({ color, children: ['█'.repeat(full)] }),
          dim('░'.repeat(width - full) + '  '),
          Text({ color, children: [minutes + ' min rimasti'] }),
          dim(' · ' + (60 - minutes) + ' min dall\'ultima richiesta'),
        ],
      }),
    )
  })
}
