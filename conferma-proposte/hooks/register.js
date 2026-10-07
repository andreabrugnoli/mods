// Il testo che chiude una proposta: una domanda, o una formula tipica di richiesta di conferma
const PROPOSAL = /(\?\s*[)"»]?\s*$)|(procedo|procediamo|vuoi che|ti va( bene)?|confermi|lo faccio|vado avanti|dimmi se)/i

// La proposta in attesa di risposta: { text } finché non arriva un prompt
let proposal = null

// Accorcia un testo su una riga
function clip(text, n) {
  const one = String(text).replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n - 1) + '…' : one
}

// Dall'ultima risposta di Claude al passaggio che propone, oppure null se non propone niente
export function findProposal(answer) {
  const paragraphs = String(answer ?? '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  const last = paragraphs[paragraphs.length - 1]
  return last && PROPOSAL.test(last) ? last : null
}

// Il nuovo stato dopo un comando: "on" accende, "off" spegne, senza argomento alterna
export function parseToggle(args, current) {
  const arg = String(args ?? '').trim().toLowerCase()
  if (/^(on|acceso|attiva|si|sì)$/.test(arg)) return true
  if (/^(off|spento|disattiva|no)$/.test(arg)) return false
  return !current
}

// Acceso o spento: lo decide /conferma e resta nello store tra una sessione e l'altra
let enabled = true

async function runConferma($, e) {
  enabled = parseToggle(e.args, enabled)
  proposal = null
  try {
    await $.store.set('attiva', enabled)
  } catch {}
  $.ui.invalidate('ui.render')
  return { text: 'conferma-proposte · ' + (enabled ? 'acceso' : 'spento') }
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    try {
      if ((await $.store.get('attiva')) === false) enabled = false
    } catch {}
    await $.command.register({ name: 'conferma', description: 'Accende o spegne i bottoni Sì e No sulle proposte', argumentHint: '[on|off]', immediate: true })
    return next(e)
  })

  on('command.run', { command: 'conferma' }, runConferma)
  // Il comando statico del plugin si chiama anche conferma-proposte:conferma
  on('command.run', { command: 'conferma-proposte:conferma' }, runConferma)

  // Un nuovo prompt, scritto da te o inviato da un bottone: la proposta non vale più
  on('prompt.submit', ($, e, next) => {
    if (proposal) {
      proposal = null
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  // A fine turno, solo la conversazione principale e solo se Claude ha davvero risposto
  on('turn.complete', ($, e, next) => {
    if (enabled && !e.agentId && e.reason === 'answer') {
      const found = findProposal(e.answer)
      proposal = found ? { text: found } : null
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const theirs = await next(e)
    if (!enabled || !proposal || e.props.isWorking) return theirs
    const { Box, Text, Button } = $.ui.resolve(e)
    // Il bottone toglie la proposta e invia la risposta come se l'avessi scritta tu
    const reply = (text) => () => {
      proposal = null
      $.ui.invalidate('ui.render')
      return $.prompt.submit({ text, asUser: true })
    }
    return Box({
      flexDirection: 'column',
      children: [
        Text({ dimColor: true, children: ['Claude propone · ' + clip(proposal.text, 220)] }),
        Box({
          flexDirection: 'row',
          children: [
            Button({ key: 'si', label: 'Sì, procedi', hotkey: 's', variant: 'primary', onPress: reply('Sì, procedi.') }),
            Text({ children: ['  '] }),
            Button({ key: 'no', label: 'No, fermati', hotkey: 'x', onPress: reply('No, fermati qui e aspetta le mie istruzioni.') }),
          ],
        }),
        theirs,
      ].filter(Boolean),
    })
  })
}
