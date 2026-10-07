// rec: /rec prima di registrare un video o lavorare in una sessione live con ospiti.
// Adattato da recording-mode di Nate Herk (MIT, vedi NOTICE.md).
// Finché è acceso, in ogni sessione di Claude Code su questa macchina:
// - chiavi, valori dei .env, email, nomi, telefoni, indirizzi, codice fiscale, partita IVA, IBAN,
//   importi e cifre d'affari vengono mascherati dove la chat disegna testo
// - i risultati di posta, chat, task, file, calendario e strumenti di pagamento si disegnano nascosti
// - Claude non può aprire i file privati (.env, credenziali, memoria di Claude, fatture, contratti,
//   preventivi e quanto elenchi nel file di configurazione) né gli strumenti di pagamento
// - ogni prompt porta una nota nascosta che chiede a Claude di tenere nomi e cifre fuori dalle risposte
// - un ● REC rosso sopra il prompt e nel piè di pagina ricorda che è acceso
// Claude lavora sempre sui dati reali: cambia solo ciò che si vede a schermo.
// /rec rigoroso maschera anche ogni cifra grande. /rec off spegne tutto.
// /rec config crea ~/.claude/mods-data/rec/config.json per il tuo nome, le persone da nascondere,
// le cartelle private e gli strumenti extra.

import { makeMasker, deepMask, hideText, privatePathHit, toolCallTargets, secretValuesFromEnv, businessSource, financeTool } from './privacy.js'

const FLAG_PATH = '/.claude/mods-data/rec/stato.json'
const CONFIG_PATH = '/.claude/mods-data/rec/config.json'

const CONFIG_TEMPLATE = {
  nomiVisibili: ['Andrea Brugnoli', 'abcomunica'],
  nomiNascosti: ['Un cliente', 'Un collaboratore'],
  percorsiPrivati: ['clienti/', 'trattative/', 'appunti-privati.md'],
  strumentiAffari: [],
  strumentiChiusi: [],
}

const CONFIG_HELP = [
  'nomiVisibili: il tuo nome e il tuo marchio, mostrati anche durante la registrazione.',
  'nomiNascosti: persone sempre mascherate (clienti, collaboratori). I nomi nelle email e nei campi contatto si imparano da soli.',
  'percorsiPrivati: cartelle o file che Claude non può aprire durante la registrazione. Vale qualsiasi parte del percorso, maiuscole comprese.',
  'strumentiAffari: nomi di tool o comandi (anche solo una parte) i cui risultati si disegnano nascosti, oltre all\'elenco già previsto.',
  'strumentiChiusi: nomi di tool che Claude non può chiamare durante la registrazione, oltre agli strumenti di pagamento già previsti.',
]

// Un punto rosso che pulsa e la scritta REC. Si disegna come immagine semplice: un Svg interattivo
// finisce in un iframe che nel tema scuro dipinge un riquadro bianco e si ricarica a ogni ridisegno.
const REC_RED = '#e5484d'
const REC_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="54" height="18" viewBox="0 0 54 18">' +
  `<circle cx="8" cy="9" r="5" fill="${REC_RED}"><animate attributeName="opacity" values="1;0.35;1" dur="1.6s" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.5;1" keySplines="0.45 0 0.55 1;0.45 0 0.55 1"/></circle>` +
  `<text x="19" y="13.2" font-family="-apple-system,'Segoe UI',system-ui,sans-serif" font-size="12" font-weight="700" letter-spacing="0.8" fill="${REC_RED}">REC</text>` +
  '</svg>'

let home = ''
let cwd = ''
let rec = { on: false, strict: false, since: 0 }
// I valori dei .env: restano solo in memoria, non vengono scritti da nessuna parte
let values = []
let config = { nomiVisibili: [], nomiNascosti: [], percorsiPrivati: [], strumentiAffari: [], strumentiChiusi: [] }
let mask = (s) => s
let blocked = 0
let noteSent = false
// Gli id delle chiamate i cui risultati sono dati d'affari
const businessCalls = new Set()

function strings(v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()).slice(0, 500) : []
}

// La nota che Claude legge accanto a ogni prompt mentre si registra
export function noteOn(keepNames = []) {
  const keep = keepNames.length ? ` (a parte ${keepNames.join(', ')})` : ''
  return (
    `Modalità rec attiva: lo schermo è in registrazione per un video pubblico o una sessione live con ospiti. Nelle risposte e nei comandi lascia fuori nomi di persone${keep}, email, telefoni, indirizzi, numeri di conto, importi, fatturato, utili, prezzi, compensi e altre cifre d'affari, e piani interni, strategie, trattative e questioni di clienti. ` +
    'Scrivi segnaposto come [nome], [importo] o [piano interno] e tieni i riassunti generici. I file privati e gli strumenti di pagamento restano chiusi finché la registrazione non finisce.'
  )
}
const NOTE_OFF = 'La modalità rec è finita. La nota precedente sulla registrazione non vale più.'

function apply() {
  mask = rec.on ? makeMasker({ strict: rec.strict, values, names: config.nomiNascosti, keepNames: config.nomiVisibili }) : (s) => s
}

async function load($) {
  await loadEnvValues($)
  await loadConfig($)
}

function unload() {
  values = []
  businessCalls.clear()
}

async function loadConfig($) {
  try {
    const path = home + CONFIG_PATH
    if (!(await $.fs.exists(path))) return
    const raw = JSON.parse(await $.fs.read(path))
    config = {
      nomiVisibili: strings(raw.nomiVisibili),
      nomiNascosti: strings(raw.nomiNascosti),
      percorsiPrivati: strings(raw.percorsiPrivati),
      strumentiAffari: strings(raw.strumentiAffari),
      strumentiChiusi: strings(raw.strumentiChiusi),
    }
  } catch {
    // file di configurazione rotto: valgono le regole già previste
  }
}

function parentDirs(path, levels) {
  const parts = String(path || '').replace(/\\/g, '/').split('/')
  const out = []
  for (let i = parts.length; i > 0 && out.length <= levels; i--) out.push(parts.slice(0, i).join('/'))
  return out.filter(Boolean)
}

async function loadEnvValues($) {
  const found = []
  for (const dir of parentDirs(cwd, 3)) {
    for (const name of ['.env', '.env.local']) {
      const p = dir + '/' + name
      try {
        if (await $.fs.exists(p)) found.push(...secretValuesFromEnv(await $.fs.read(p)))
      } catch {
        // illeggibile: i pattern coprono comunque i formati di chiave più comuni
      }
    }
  }
  values = [...new Set(found)].sort((a, b) => b.length - a.length)
}

async function readFlag($) {
  try {
    const path = home + FLAG_PATH
    if (!(await $.fs.exists(path))) return { on: false, strict: false, since: 0 }
    const flag = JSON.parse(await $.fs.read(path))
    return { on: !!flag.on, strict: !!flag.strict, since: flag.since || 0 }
  } catch {
    return { on: false, strict: false, since: 0 }
  }
}

// Un'altra sessione può aver acceso o spento la registrazione
async function syncFlag($) {
  const flag = await readFlag($)
  if (flag.on === rec.on && flag.strict === rec.strict) return
  rec = flag
  if (rec.on) await load($)
  else unload()
  apply()
  $.ui.invalidate('ui.render')
}

async function setFlag($, on, strict) {
  rec = { on, strict: on && strict, since: on ? await $.clock.now() : 0 }
  try {
    await $.fs.write(home + FLAG_PATH, JSON.stringify(rec))
  } catch {
    // dove il file non si scrive la modalità vale solo per questa sessione
  }
  if (rec.on) await load($)
  else unload()
  apply()
  $.ui.invalidate('ui.render')
}

// /rec config: crea il file la prima volta, poi dice dov'è e cosa contiene
async function configText($) {
  const path = home + CONFIG_PATH
  let made = false
  try {
    if (!(await $.fs.exists(path))) {
      await $.fs.write(path, JSON.stringify(CONFIG_TEMPLATE, null, 2) + '\n')
      made = true
    }
  } catch {
    return `Non riesco a scrivere ${path}. Crealo a mano con questa forma:\n${JSON.stringify(CONFIG_TEMPLATE, null, 2)}`
  }
  await loadConfig($)
  apply()
  return [
    `${made ? 'Creato' : 'Il tuo'} file di configurazione di rec: ${path}`,
    made
      ? 'Contiene valori d\'esempio. Sostituiscili con i tuoi, salva e lancia di nuovo /rec.'
      : `Caricati: ${config.nomiVisibili.length} nomi visibili, ${config.nomiNascosti.length} nomi nascosti, ${config.percorsiPrivati.length} percorsi privati.`,
    ...CONFIG_HELP,
  ].join('\n')
}

// /rec alterna, /rec rigoroso accende anche la maschera sulle cifre grandi, /rec off spegne, /rec config crea la configurazione
async function runRec($, e) {
  const arg = String(e.args || '').trim().toLowerCase()
  if (arg === 'config') return { text: await configText($) }
  if (arg === 'off' || arg === 'spento' || (arg === '' && rec.on)) {
    await setFlag($, false, false)
    $.ui.toast('rec spento.' + (blocked ? ` Ha tenuto chiusi ${blocked} file privati.` : ''))
    blocked = 0
    return { text: 'rec · spento' }
  }
  const strict = arg === 'rigoroso' || arg === 'strict'
  await setFlag($, true, strict)
  $.ui.toast(`rec acceso${strict ? ' (rigoroso)' : ''}.`, { timeoutMs: 3000 })
  return { text: 'rec · acceso' + (strict ? ' (rigoroso)' : '') }
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || ''
    cwd = await $.session.cwd()
    await $.command.register({
      name: 'rec',
      description: 'Accende o spegne la modalità rec: nasconde chiavi, dati personali, importi e file privati a schermo',
      argumentHint: '[rigoroso|off|config]',
      immediate: true,
    })
    await loadConfig($)
    await syncFlag($)
    $.clock.every(3000, () => syncFlag($).catch(() => {}))
    return next(e)
  })

  on('command.run', { command: 'rec' }, runRec)
  // Il comando statico del plugin si chiama anche rec:registra
  on('command.run', { command: 'rec:registra' }, runRec)

  // Claude legge una nota accanto a ogni prompt mentre si registra, e una in più quando finisce
  on('prompt.submit', async ($, e, next) => {
    const note = rec.on ? noteOn(config.nomiVisibili) : noteSent ? NOTE_OFF : null
    if (!note) return next(e)
    noteSent = rec.on
    return next({ ...e, context: [...(e.context ?? []), note] })
  })

  // File privati e strumenti di pagamento restano chiusi mentre si registra
  on('tool.call', async ($, e, next) => {
    if (!rec.on) return next(e)
    const hit = financeTool(e.tool, config.strumentiChiusi) ? 'strumenti di pagamento' : privatePathHit(toolCallTargets(e).join('\n'), config.percorsiPrivati)
    if (!hit) {
      if (businessSource(e.tool, e, config.strumentiAffari)) businessCalls.add(e.tool_use_id)
      return next(e)
    }
    blocked += 1
    return {
      deny: `La modalità rec è attiva, quindi "${hit}" resta chiuso finché lo schermo è in registrazione. Continua senza, oppure chiedi all'utente di lanciare prima /rec off.`,
    }
  })

  // Righe di testo: prompt, risposte, output dei comandi
  on('ui.render', { component: ['UserMessage', 'AssistantMessage', 'CommandOutput'] }, async ($, e, next) => {
    if (!rec.on || typeof e.props.text !== 'string') return next(e)
    return next({ ...e, props: { ...e.props, text: mask(e.props.text) } })
  })

  // Righe dei tool: l'input si maschera, il risultato di un tool d'affari si nasconde per intero
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (!rec.on) return next(e)
    const business = businessSource(e.props.tool, e.props.input, config.strumentiAffari) || businessCalls.has(e.props.tool_use_id)
    if (business) businessCalls.add(e.props.tool_use_id)
    const props = { ...e.props, input: deepMask(e.props.input, mask) }
    if (e.props.output !== undefined) props.output = deepMask(e.props.output, business ? hideText : mask)
    return next({ ...e, props })
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (!rec.on) return next(e)
    const business = businessSource(e.props.tool, null, config.strumentiAffari) || businessCalls.has(e.props.tool_use_id)
    return next({ ...e, props: { ...e.props, output: deepMask(e.props.output, business ? hideText : mask) } })
  })

  // Solo l'indicatore: un punto rosso che pulsa e REC
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props && e.props.hasSurvey) return below
    if (!rec.on) return below
    const el = $.ui.resolve(e)
    const line =
      e.surface === 'terminal' || !el.Svg
        ? el.Text({ color: 'red', bold: true, children: ['● REC'] })
        : el.Svg({ source: REC_SVG, alt: 'REC', width: 54, height: 18 })
    return el.Box({ flexDirection: 'column', children: below ? [line, below] : [line] })
  })

  // L'etichetta nel piè di pagina si vede anche con la banda chiusa
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (!rec.on) return next(e)
    const modes = Array.isArray(e.props && e.props.modes) ? e.props.modes : []
    return next({ ...e, props: { ...e.props, modes: ['● REC', ...modes] } })
  })
}
