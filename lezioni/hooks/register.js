// Quanti inciampi servono prima di proporre la correzione, e quanti al massimo se ne riportano
const MIN_INCIDENTS = 2
const MAX_LISTED = 12

// Le frasi con cui di solito segnali che qualcosa non è andato come volevi
const CORRECTION = /(non (mi piace|va bene|funziona|vedo|capisco|ha|è)|sbagliat|errore|perch[eè] non|di nuovo|ancora una volta|riprova|correggi|dovevi|avevo detto|non voglio)/i

// Gli inciampi della sessione e le skill usate
let incidents = []
let skills = new Set()

// Accorcia un testo su una riga
function clip(text, n) {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n - 1) + '…' : one
}

// Su cosa agiva la chiamata: il comando, il file o il nome del tool
function targetOf(e) {
  return clip(e.command ?? e.file_path ?? e.url ?? e.tool, 80)
}

// Il testo dell'elenco, uguale per il comando e per il prompt
export function listIncidents(list) {
  return list.slice(-MAX_LISTED).map((i) => '- ' + i.kind + ': ' + i.what).join('\n')
}

// Il prompt che chiede di capire le cause e proporre le modifiche, senza applicarle
export function lessonsPrompt(list, usedSkills) {
  return (
    'Rivedi gli inciampi di questa sessione e proponi come evitare che si ripetano.\n\nInciampi:\n' +
    listIncidents(list) +
    (usedSkills.length ? '\n\nSkill usate: ' + usedSkills.join(', ') : '') +
    '\n\nPer ciascun inciampo individua la causa. Se dipende da una skill o da un file di istruzioni (SKILL.md, CLAUDE.md, regole), proponi la modifica esatta. Non applicare nulla: mostrami le modifiche e aspetta la mia conferma.'
  )
}

export function isCorrection(text) {
  return CORRECTION.test(text ?? '')
}

export function register(on) {
  // Ogni chiamata passa; se è stata negata o è fallita, la annotiamo
  on('tool.call', async ($, e, next) => {
    if (e.tool === 'Skill' && e.skill) skills.add(e.skill)
    const ran = await next(e)
    if (e.tool !== 'AskUserQuestion') {
      if (ran.deny !== undefined) incidents.push({ kind: 'negata', what: targetOf(e) + ' (' + clip(ran.deny, 80) + ')' })
      else if (ran.isError === true) incidents.push({ kind: 'errore', what: targetOf(e) + ' (' + clip(ran.text, 100) + ')' })
      $.ui.invalidate('ui.render')
    }
    return ran
  })

  // Le tue correzioni contano come inciampi
  on('prompt.submit', ($, e, next) => {
    if (isCorrection(e.text)) {
      incidents.push({ kind: 'correzione', what: clip(e.text, 100) })
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  // Il comando funziona anche dove la banda non si vede
  on('command.run', { command: 'lezioni' }, async () => {
    if (!incidents.length) return { text: 'lezioni · nessun inciampo in questa sessione' }
    return { text: 'lezioni · ' + incidents.length + ' inciampi\n' + listIncidents(incidents) + (skills.size ? '\nskill usate: ' + [...skills].join(', ') : '') }
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'lezioni', description: 'Elenca gli inciampi della sessione' })
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const theirs = await next(e)
    if (incidents.length < MIN_INCIDENTS || e.props.isWorking) return theirs
    const { Box, Text, Button } = $.ui.resolve(e)
    const propose = () => {
      const text = lessonsPrompt(incidents, [...skills])
      incidents = []
      $.ui.invalidate('ui.render')
      return $.prompt.submit({ text })
    }
    return Box({
      flexDirection: 'column',
      children: [
        Box({
          flexDirection: 'row',
          children: [
            Text({ color: 'yellow', children: ['lezioni · ' + incidents.length + ' inciampi'] }),
            Text({ dimColor: true, children: [skills.size ? ' · skill: ' + [...skills].join(', ') + '  ' : '  '] }),
            Button({ key: 'lezioni', label: 'Proponi correzione', hotkey: 'l', onPress: propose }),
          ],
        }),
        theirs,
      ].filter(Boolean),
    })
  })
}
