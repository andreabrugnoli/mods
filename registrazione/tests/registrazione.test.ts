import { expect, test } from 'claude-code/testing'
import { mask, maskDeep, parseWords, touchesSensitive } from '../hooks/register.js'

const BAND = {
  plugin: 'registrazione',
  component: 'AbovePrompt',
  viewport: { columns: 160, rows: 40 },
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 160, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

test('nasconde chiavi, token e variabili d\'ambiente', () => {
  expect(mask('chiave sk-ant-api03-abcdefghijklmnop1234')).not.toContain('abcdefghij')
  expect(mask('ghp_abcdefghijklmnopqrstuvwxyz0123456789')).toBe('••••••')
  expect(mask('ANTHROPIC_API_KEY=abcd1234efgh')).toBe('ANTHROPIC_API_KEY=••••••')
  expect(mask('{"apiKey": "abcd1234efgh"}')).toBe('{"apiKey": "••••••"}')
  expect(mask('Authorization: Bearer abcdefghijklmnop12345')).toBe('Authorization: Bearer ••••••')
  expect(mask('https://utente:segreta@host.it/x')).toBe('https://utente:••••••@host.it/x')
})

test('nasconde dati personali e lascia stare git@', () => {
  expect(mask('scrivi a mario.rossi@studio.it')).toBe('scrivi a ••••••')
  expect(mask('git@github.com:andreabrugnoli/mods.git')).toBe('git@github.com:andreabrugnoli/mods.git')
  expect(mask('IBAN IT60X0542811101000000123456')).toBe('IBAN ••••••')
  expect(mask('IBAN IT60 X054 2811 1010 0000 0123 456')).toBe('IBAN ••••••')
  expect(mask('CF RSSMRA80A01H501U')).toBe('CF ••••••')
  expect(mask('chiama +39 045 1234567')).not.toContain('1234567')
  expect(mask('cellulare 333 123 4567')).not.toContain('4567')
})

test('le parole scelte sono nascoste senza distinguere le maiuscole', () => {
  const words = parseWords(' FABI , Acme Srl, x ')
  expect(words).toEqual(['FABI', 'Acme Srl'])
  expect(mask('Corso per fabi e ACME SRL', { words })).toBe('Corso per •••••• e ••••••')
})

test('gli importi si nascondono solo in strict', () => {
  expect(mask('fattura da 1.200,50 € e $300')).toContain('1.200')
  const strict = mask('fattura da 1.200,50 € e $300', { strict: true })
  expect(strict).not.toContain('1.200')
  expect(strict).not.toContain('300')
})

test('il testo normale resta intatto', () => {
  const text = 'Ho modificato src/index.ts alle 10:30 (commit 374b38c).'
  expect(mask(text, { strict: true })).toBe(text)
})

test('maskDeep conserva la forma della struttura', () => {
  const out = maskDeep({ a: ['sk-ant-api03-abcdefghijklmnop1234', 5, null], b: { c: 'ok' } })
  expect(out.a[1]).toBe(5)
  expect(out.a[2]).toBeNull()
  expect(out.a[0]).toBe('••••••')
  expect(out.b.c).toBe('ok')
})

test('i file riservati sono riconosciuti, gli esempi no', () => {
  expect(touchesSensitive({ tool: 'Read', tool_use_id: 'x', file_path: '/home/a/app/.env' })).toBe(true)
  expect(touchesSensitive({ tool: 'Bash', tool_use_id: 'x', command: 'cat ~/.ssh/id_ed25519' })).toBe(true)
  expect(touchesSensitive({ tool: 'Read', tool_use_id: 'x', file_path: '/app/.env.example' })).toBe(false)
  expect(touchesSensitive({ tool: 'Bash', tool_use_id: 'x', command: 'git status' })).toBe(false)
})

test('/rec attiva la maschera sullo schermo e /rec off la toglie', async ($, on) => {
  on('ui.render', { component: 'AssistantMessage' }, (_$, e) => ({ type: 'Text', props: {}, children: [e.props.text] }))
  const secret = 'sk-ant-api03-abcdefghijklmnop1234'
  const mount = () =>
    $.ui.mount({
      plugin: 'registrazione',
      surface: 'terminal',
      component: 'AssistantMessage',
      viewport: { columns: 160, rows: 40 },
      props: { text: 'la chiave è ' + secret, isFirstOfReply: true },
    })
  let ui = await mount()
  expect(await ui.find({ type: 'Text', text: 'la chiave è ' + secret })).toBeDefined()
  await ui.unmount()
  await $.command.run({ command: 'rec', args: '' })
  ui = await mount()
  expect(await ui.find({ type: 'Text', text: 'la chiave è ••••••' })).toBeDefined()
  await ui.unmount()
  await $.command.run({ command: 'rec', args: 'off' })
  ui = await mount()
  expect(await ui.find({ type: 'Text', text: 'la chiave è ' + secret })).toBeDefined()
})

test('in strict una chiamata su .env è negata', async ($, on) => {
  on('tool.call', async () => ({ ref: 1, result: {}, text: 'ok' }))
  await $.command.run({ command: 'rec', args: 'strict' })
  const denied = await $.tool.call({ tool: 'Read', file_path: '/app/.env' })
  expect(denied.deny).toBeDefined()
  await $.command.run({ command: 'rec', args: 'on' })
  const allowed = await $.tool.call({ tool: 'Read', file_path: '/app/.env' })
  expect(allowed.deny).toBeUndefined()
})

test('con la registrazione attiva compare il segnale REC con il bottone Ferma', async ($, on) => {
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['altra mod'] }))
  await $.command.run({ command: 'rec', args: '' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: '● REC' })).toBeDefined()
    await ui.press({ key: 'stop' })
    await ui.unmount()
    await $.command.run({ command: 'rec', args: '' })
  }
})
