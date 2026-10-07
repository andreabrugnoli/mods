import { expect, test } from 'claude-code/testing'
import { isCorrection, lessonsPrompt } from '../hooks/register.js'

const BAND = {
  plugin: 'correggi',
  component: 'AbovePrompt',
  viewport: { columns: 160, rows: 40 },
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 160, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

// Il tool sotto la mod: risponde con errore o con successo
function stubTools(on, isError: boolean, sent: string[] = []) {
  on('tool.call', async () => ({ ref: 1, result: {}, text: isError ? 'boom' : 'ok', ...(isError ? { isError: true } : {}) }))
  on('prompt.submit', async (_$, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['altra mod'] }))
}

test('riconosce le tue correzioni', () => {
  expect(isCorrection('non vedo i post su postpickr')).toBe(true)
  expect(isCorrection('rivedi la skill, hai sbagliato il tono')).toBe(true)
  expect(isCorrection('sì procedi')).toBe(false)
})

test('il prompt elenca gli inciampi e chiede di non applicare nulla', () => {
  const text = lessonsPrompt([{ kind: 'errore', what: 'git push (rejected)' }], ['grill-me'])
  expect(text).toContain('- errore: git push (rejected)')
  expect(text).toContain('Skill usate: grill-me')
  expect(text).toContain('Non applicare nulla')
})

test('con due inciampi compare Proponi correzione e il bottone invia il prompt', async ($, on) => {
  const sent: string[] = []
  stubTools(on, true, sent)
  await $.tool.call({ tool: 'Bash', command: 'git push' })
  let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'correggi' })).toBeUndefined()
  await ui.unmount()
  await $.tool.call({ tool: 'Bash', command: 'python3 run.py' })
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'correggi · 2 inciampi' })).toBeDefined()
  await ui.press({ key: 'correggi' })
  expect(sent.some((t) => t.includes('git push') && t.includes('python3 run.py'))).toBe(true)
})

test('i tool riusciti non contano e /correggi elenco elenca gli inciampi', async ($, on) => {
  stubTools(on, false)
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  const none = await $.command.run({ command: 'correggi', args: 'elenco' })
  expect(none.text).toContain('nessun inciampo')
})

test('/correggi spento non raccoglie inciampi', async ($, on) => {
  stubTools(on, true)
  const off = await $.command.run({ command: 'correggi' })
  expect(off.text).toContain('spento')
  await $.tool.call({ tool: 'Bash', command: 'git push' })
  const list = await $.command.run({ command: 'correggi', args: 'elenco' })
  expect(list.text).toContain('nessun inciampo')
})
