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

// Il nuovo stato dopo un comando: "on" accende, "off" spegne, senza argomento alterna
export function parseToggle(args, current) {
  const arg = String(args ?? '').trim().toLowerCase()
  if (/^(on|acceso|attiva|si|sì)$/.test(arg)) return true
  if (/^(off|spento|disattiva|no)$/.test(arg)) return false
  return !current
}

// Acceso o spento: lo decide /correggi e resta nello store tra una sessione e l'altra
let enabled = true

export function register(on) {
  // Ogni chiamata passa; se è stata negata o è fallita, la annotiamo
  on('tool.call', async ($, e, next) => {
    if (!enabled) return next(e)
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
    if (enabled && isCorrection(e.text)) {
      incidents.push({ kind: 'correzione', what: clip(e.text, 100) })
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  // /correggi alterna acceso e spento; /correggi elenco mostra gli inciampi anche dove la banda non si vede
  on('command.run', { command: 'correggi' }, async ($, e) => {
    if (String(e.args ?? '').trim().toLowerCase() === 'elenco') {
      if (!incidents.length) return { text: 'correggi · nessun inciampo in questa sessione' }
      return { text: 'correggi · ' + incidents.length + ' inciampi\n' + listIncidents(incidents) + (skills.size ? '\nskill usate: ' + [...skills].join(', ') : '') }
    }
    enabled = parseToggle(e.args, enabled)
    incidents = []
    skills = new Set()
    try {
      await $.store.set('attiva', enabled)
    } catch {}
    $.ui.invalidate('ui.render')
    return { text: 'correggi · ' + (enabled ? 'acceso' : 'spento') }
  })

  on('session.start', async ($, e, next) => {
    try {
      if ((await $.store.get('attiva')) === false) enabled = false
    } catch {}
    await $.command.register({ name: 'correggi', description: 'Accende o spegne la raccolta degli inciampi (elenco: li mostra)', argumentHint: '[on|off|elenco]', immediate: true })
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const theirs = await next(e)
    if (!enabled || incidents.length < MIN_INCIDENTS || e.props.isWorking) return theirs
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
            Text({ color: 'yellow', children: ['correggi · ' + incidents.length + ' inciampi'] }),
            Text({ dimColor: true, children: [skills.size ? ' · skill: ' + [...skills].join(', ') + '  ' : '  '] }),
            Button({ key: 'correggi', label: 'Proponi correzione', hotkey: 'l', onPress: propose }),
          ],
        }),
        theirs,
      ].filter(Boolean),
    })
  })
}
