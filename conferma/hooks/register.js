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

export function register(on) {
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
    if (!e.agentId && e.reason === 'answer') {
      const found = findProposal(e.answer)
      proposal = found ? { text: found } : null
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const theirs = await next(e)
    if (!proposal || e.props.isWorking) return theirs
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
