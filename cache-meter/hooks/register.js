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
  'Esegui ora: git status, poi git add delle modifiche pertinenti, un commit con messaggio breve in italiano e git push sul branch corrente (git push -u origin <branch>). Se non ci sono modifiche, dillo e fermati. Non modificare altro.'

// Il prompt del bottone "Nuova chat": il riassunto va in un file, poi la chat riparte da lì
function handoffPrompt(file) {
  return (
    'Prepara il passaggio a una nuova chat per risparmiare contesto. Scrivi in ' +
    file +
    ' (crea la cartella se manca) un riassunto che permetta di riprendere dallo stesso punto: obiettivo, decisioni prese, stato attuale, file toccati con percorso, comandi utili, prossimi passi, punti aperti. Solo fatti, niente cronaca. Non fare altro. Rispondi con una riga.'
  )
}

// Il file di passaggio per la sessione in corso, atteso dopo il riassunto
let handoffFile = null

// Avvia il passaggio a una nuova chat: il riassunto va in un file, il resto lo fa turn.complete
async function startHandoff($) {
  const id = await $.session.id()
  handoffFile = '~/.claude/handoffs/' + id + '.md'
  $.ui.toast('Riassunto in corso, poi la chat riparte pulita')
  await $.prompt.submit({ text: handoffPrompt(handoffFile) })
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
    await $.command.register({ name: 'cache', description: 'Quanto resta della prompt cache' })
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

  on('command.run', { command: 'nuova' }, async ($) => {
    void startHandoff($)
    return { text: 'Passaggio avviato: riassunto, poi chat pulita.' }
  })

  // Dopo il riassunto: svuota la chat e riparte dal file. Il comando va in coda, non si attende dentro il turno
  on('turn.complete', ($, e, next) => {
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
    return next(e)
  })

  // Una richiesta al modello rinnova la cache: l'ora riparte dal suo risultato
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    // Solo la conversazione principale: i subagent hanno una cache loro
    if (!e.agentId && result.usage) {
      lastAt = now = await $.clock.now()
      ticking ??= $.clock.every(TICK_MS, async () => {
        now = await $.clock.now()
        $.ui.invalidate('ui.render')
      })
      $.ui.invalidate('ui.render')
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Quello che disegnano le altre mod nella banda resta sotto la nostra riga
    const theirs = await next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const dim = (text) => Text({ dimColor: true, children: [text] })
    const buttons = Box({
      flexDirection: 'row',
      children: [
        Button({ key: 'commit', label: 'Commit e push', hotkey: 'g', onPress: () => $.prompt.submit({ text: COMMIT_PROMPT }) }),
        Text({ children: ['  '] }),
        Button({
          key: 'fresh',
          label: 'Nuova chat',
          hotkey: 'n',
          onPress: () => startHandoff($),
        }),
      ],
    })
    const withTheirs = (line) =>
      Box({ flexDirection: 'column', children: e.props.isWorking ? [line, theirs].filter(Boolean) : [line, buttons, theirs].filter(Boolean) })

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
