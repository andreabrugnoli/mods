// Il segno che sostituisce ciò che viene nascosto
const MASK = '••••••'

// Gli elementi del transcript che mostrano testo: tutti passano dalla stessa maschera
const COMPONENTS = ['UserMessage', 'AssistantMessage', 'ToolUse', 'ToolResult', 'ToolGroup', 'CommandOutput']

// Segreti riconoscibili dalla forma: sostituiti per intero
const SECRETS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /sk-ant-[\w-]{10,}|sk-[A-Za-z0-9_-]{20,}|(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/g,
  /gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g,
]

// Dati personali riconoscibili dalla forma, sostituiti per intero
const PERSONAL = [
  /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){4,7}(?:\s?[A-Z0-9]{1,3})?\b/g,
  /\b[A-Z]{6}\d{2}[A-EHLMPR-T]\d{2}[A-Z]\d{3}[A-Z]\b/gi,
  /\b\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{1,4}\b/g,
  /\+\d{1,3}[\s.-]?\d{2,4}[\s.-]?\d{3,4}[\s.-]?\d{3,4}\b/g,
  /\b3\d{2}[\s.-]?\d{3}[\s.-]?\d{3,4}\b/g,
]

// Importi in euro o dollari, nascosti solo in modalità strict
const AMOUNTS = /[€$]\s?\d[\d.,]*|\b(?:EUR|USD)\s?\d[\d.,]*|\d[\d.,]*\s?(?:[€$]|\b(?:euro|EUR|USD)\b)/gi

// File che in modalità strict non si leggono né si toccano. Gli esempi (.env.example) sono ammessi
const SENSITIVE_PATH = /(?:^|[/\s"'=])(?:\.env(?!\.(?:example|sample|template)\b)(?:\.[\w-]+)?|\.npmrc|\.netrc|\.pypirc|\.git-credentials|\.credentials\.json|credentials(?:\.json)?|id_(?:rsa|ed25519|ecdsa|dsa)|[\w.-]+\.(?:pem|p12|pfx)|\.ssh\/|\.aws\/|\.gnupg\/|secrets?\.(?:json|ya?ml|env))(?=$|[/\s"'])/i

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Dall'opzione "parole" (separate da virgola) all'elenco pulito
export function parseWords(text) {
  return String(text ?? '').split(',').map((w) => w.trim()).filter((w) => w.length >= 2)
}

// Il testo con tutto ciò che va nascosto sostituito; lo strict nasconde anche gli importi
export function mask(text, { words = [], strict = false } = {}) {
  let out = String(text)
  for (const re of SECRETS) out = out.replace(re, MASK)
  // Credenziali dentro un indirizzo: https://utente:password@host
  out = out.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+(@)/gi, '$1' + MASK + '$2')
  // Autorizzazioni: Bearer xxx, Basic xxx
  out = out.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi, '$1 ' + MASK)
  // Variabili d'ambiente: NOME_TOKEN=valore
  out = out.replace(/\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD)[A-Z0-9_]*)(\s*[=:]\s*)(["']?)[^\s"']{4,}\3/g, '$1$2$3' + MASK + '$3')
  // Campi JSON: "apiKey": "valore"
  out = out.replace(/("[\w-]*(?:key|token|secret|password)[\w-]*"\s*:\s*")[^"]{4,}(")/gi, '$1' + MASK + '$2')
  for (const re of PERSONAL) out = out.replace(re, MASK)
  // Indirizzi email, tranne quelli di git (git@github.com)
  out = out.replace(/([A-Za-z0-9._%+-]+)@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (all, local) => (local === 'git' ? all : MASK))
  for (const word of words) out = out.replace(new RegExp(escapeRegExp(word), 'gi'), MASK)
  if (strict) out = out.replace(AMOUNTS, MASK)
  return out
}

// La stessa maschera su ogni testo dentro una struttura, senza cambiarne la forma
export function maskDeep(value, options, depth = 0) {
  if (typeof value === 'string') return mask(value, options)
  if (depth > 8 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => maskDeep(item, options, depth + 1))
  const out = {}
  for (const key of Object.keys(value)) out[key] = maskDeep(value[key], options, depth + 1)
  return out
}

// Vero se una chiamata a un tool nomina un file riservato
export function touchesSensitive(input) {
  const { tool, tool_use_id, ...args } = input
  return SENSITIVE_PATH.test(JSON.stringify(args))
}

// off, on o strict: ripreso dall'archivio se è la stessa sessione
let mode = 'off'

// Cambia modo, ridisegna e lo ricorda per questa sessione
async function setMode($, next) {
  mode = next
  $.ui.invalidate('ui.render')
  try {
    await $.store.set('mode', { id: await $.session.id(), mode })
  } catch {}
}

export function register(on, options) {
  const words = parseWords(options?.parole)
  const maskOptions = () => ({ words, strict: mode === 'strict' })

  on('session.start', async ($, e, next) => {
    try {
      const saved = await $.store.get('mode')
      if (saved && saved.id === (await $.session.id()) && (saved.mode === 'on' || saved.mode === 'strict')) mode = saved.mode
    } catch {}
    await $.command.register({ name: 'rec', description: 'Modalità registrazione: /rec, /rec strict, /rec off, /rec config' })
    return next(e)
  })

  on('command.run', { command: 'rec' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === '' || arg === 'on') {
      await setMode($, 'on')
      return { text: 'Registrazione attiva: chiavi, dati personali e parole scelte sono nascosti a schermo. Il modello continua a vedere i dati veri. I messaggi già in vista restano com\'erano finché non si ridisegnano: con /clear parti pulito. Il testo che scrivi nel prompt non viene nascosto.' }
    }
    if (arg === 'strict') {
      await setMode($, 'strict')
      return { text: 'Registrazione strict attiva: in più sono nascosti gli importi e Claude non apre file riservati (.env, chiavi SSH, credenziali).' }
    }
    if (arg === 'off') {
      await setMode($, 'off')
      return { text: 'Registrazione disattivata.' }
    }
    if (arg === 'config') {
      return { text: 'Modo: ' + mode + '. Parole personalizzate: ' + words.length + ' (opzione "parole" nel menu di configurazione del plugin). Nascosti sempre: chiavi API e token, chiavi private, credenziali negli indirizzi, variabili d\'ambiente, email, IBAN, codice fiscale, carte, telefoni. Solo in strict: importi e file riservati.' }
    }
    return { text: 'Uso: /rec (attiva), /rec strict, /rec off, /rec config' }
  })

  for (const component of COMPONENTS) {
    on('ui.render', { component }, async ($, e, next) => {
      if (mode === 'off') return next(e)
      return next({ ...e, props: maskDeep(e.props, maskOptions()) })
    })
  }

  // In strict, niente file riservati finché si registra
  on('tool.call', async ($, e, next) => {
    if (mode === 'strict' && touchesSensitive(e)) {
      return { deny: 'registrazione: in modalità strict non accedo a file riservati. Usa /rec off per sospendere la protezione.' }
    }
    return next(e)
  })

  // Il segnale rosso sopra il prompt: sempre in vista finché la registrazione è attiva
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const theirs = await next(e)
    if (mode === 'off') return theirs
    const { Box, Text, Button } = $.ui.resolve(e)
    return Box({
      flexDirection: 'column',
      children: [
        Box({
          flexDirection: 'row',
          children: [
            Text({ color: 'red', bold: true, children: ['● REC'] }),
            Text({ dimColor: true, children: [mode === 'strict' ? '  strict: dati, importi e file riservati nascosti  ' : '  chiavi e dati personali nascosti  '] }),
            Button({ key: 'stop', label: 'Ferma', hotkey: 'r', onPress: () => setMode($, 'off') }),
          ],
        }),
        theirs,
      ].filter(Boolean),
    })
  })
}
