import { expect, mock, test } from 'claude-code/testing'
import { makeMasker, privatePathHit, businessSource, financeTool } from '../hooks/privacy.js'
import { noteOn } from '../hooks/register.js'

const mask = makeMasker({ names: ['Giulia Bianchi'], keepNames: ['Andrea Brugnoli'] })
const strict = makeMasker({ strict: true })

test('maschera gli importi in euro nei formati italiani', () => {
  expect(mask('Il preventivo è di € 1.250,00 più IVA')).not.toContain('1.250')
  expect(mask('Ha pagato 3.400 euro ieri')).not.toContain('3.400')
  expect(mask('Totale 29 € e 1,2 milioni di euro')).not.toMatch(/29|1,2/)
  expect(mask('Prezzo: $29')).not.toContain('29')
})

test('maschera le cifre vicino alle parole del fatturato', () => {
  expect(mask('Il fatturato di quest\'anno è 84mila')).not.toContain('84mila')
  expect(mask('margine al 40%')).not.toContain('40%')
  expect(mask('Mi sono svegliato alle 7 e ho scritto 12 righe')).toContain('7')
})

test('maschera dati personali italiani', () => {
  expect(mask('CF RSSMRA80A01L781K')).not.toContain('RSSMRA80A01L781K')
  expect(mask('P.IVA 01234567890')).not.toContain('01234567890')
  expect(mask('IBAN IT60 X054 2811 1010 0000 0123 456')).not.toContain('0123 456')
  expect(mask('chiama il 347 123 4567')).not.toContain('123 4567')
  expect(mask('scrivi a +39 045 1234567')).not.toContain('1234567')
  expect(mask('sede in Via Roma 12, Verona')).not.toContain('Via Roma 12')
  expect(mask('37121 Verona (VR)')).not.toContain('37121')
  expect(mask('mario.rossi@banca.it')).not.toContain('mario.rossi')
})

test('nasconde i nomi dell\'elenco e lascia visibili i tuoi', () => {
  const out = mask('Giulia Bianchi ha scritto ad Andrea Brugnoli')
  expect(out).not.toContain('Giulia')
  expect(out).toContain('Andrea Brugnoli')
})

test('con rigoroso maschera ogni cifra grande', () => {
  expect(strict('Ci sono 1.250 utenti e il 18% torna')).not.toMatch(/1\.250|18%/)
})

test('maschera le chiavi', () => {
  expect(mask('ANTHROPIC_API_KEY=sk-ant-abcdefghijklmnopqrstu')).not.toContain('abcdefghij')
})

test('chiude i file privati italiani e gli .env', () => {
  expect(privatePathHit('cat .env')).toBeTruthy()
  expect(privatePathHit('clienti/bcc/fatture/2026.pdf')).toBeTruthy()
  expect(privatePathHit('src/index.js')).toBeNull()
  expect(privatePathHit('clienti/bcc/nota.md', ['clienti/'])).toBe('clienti/')
})

test('riconosce gli strumenti d\'affari e di pagamento', () => {
  expect(businessSource('mcp__46dded4b-f2d2__notion-fetch', {})).toBe(true)
  expect(businessSource('Bash', { command: 'notion-tasks list' })).toBe(true)
  expect(businessSource('Read', {})).toBe(false)
  expect(financeTool('mcp__d5287938__stripe_api_read')).toBe(true)
  expect(financeTool('Read')).toBe(false)
})

test('la nota per Claude chiede segnaposto e cita i nomi visibili', () => {
  expect(noteOn(['Andrea Brugnoli'])).toContain('a parte Andrea Brugnoli')
  expect(noteOn()).toContain('[importo]')
})

// Un disco in memoria sotto i file della mod
function stubFs(on, files: Record<string, string> = {}) {
  on('fs.exists', async (_$, e) => ({ exists: e.path in files }))
  on('fs.read', async (_$, e) => ({ text: files[e.path] ?? '' }))
  on('fs.write', async (_$, e) => {
    files[e.path] = e.text
    return {}
  })
}

test('/rec accende e /rec off spegne', async ($, on) => {
  mock.clock(on, { now: 1000 })
  stubFs(on)
  const on1 = await $.command.run({ command: 'rec' })
  expect(on1.text).toContain('acceso')
  const off = await $.command.run({ command: 'rec', args: 'off' })
  expect(off.text).toContain('spento')
})

test('con rec acceso un file privato viene negato e un prompt porta la nota', async ($, on) => {
  mock.clock(on, { now: 1000 })
  stubFs(on)
  const seen: string[] = []
  on('tool.call', async () => ({ ref: 1, result: {}, text: 'ok' }))
  on('prompt.submit', async (_$, e) => {
    seen.push(...(e.context ?? []))
    return { text: e.text }
  })
  await $.command.run({ command: 'rec' })
  const denied = await $.tool.call({ tool: 'Read', file_path: '/progetto/.env' })
  expect(denied.deny).toContain('rec')
  await $.prompt.submit({ text: 'ciao' })
  expect(seen.some((n) => n.includes('Modalità rec attiva'))).toBe(true)
  await $.command.run({ command: 'rec', args: 'off' })
})
