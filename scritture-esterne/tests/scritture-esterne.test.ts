import { expect, test } from 'claude-code/testing'
import { parseServices, serviceLabel } from '../hooks/register.js'

const BAND = {
  plugin: 'scritture-esterne',
  component: 'AbovePrompt',
  viewport: { columns: 160, rows: 40 },
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 160, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const END = { answer: 'ok', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as const

// Il tool sotto la mod risponde col testo dato, o con un errore
function stubTool(on, text: string, isError = false) {
  on('tool.call', async (_$, e) => ({ ref: 1, result: {}, text, ...(isError ? { isError: true } : {}) }))
  on('turn.complete', () => ({ text: 'ok' }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['altra mod'] }))
}

test('una scrittura su un connettore noto compare a fine turno con il link', async ($, on) => {
  stubTool(on, 'creato https://app.postpickr.com/post/123')
  await $.tool.call({ tool: 'mcp__postpickr__create_post', project_id: 1 })
  await $.turn.complete(END)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'scritto fuori dalla repo · 1 azione' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Postpickr · create post · 1' })).toBeDefined()
  expect(await ui.find({ type: 'Link' })).toBeDefined()
})

test('le opzioni nominano i connettori con id opaco', () => {
  const custom = parseServices(' 1a2b3c4d-0000-4000-8000-000000000001 = Postpickr , abc=Notion=Team ')
  expect(custom['1a2b3c4d-0000-4000-8000-000000000001']).toBe('Postpickr')
  expect(custom.abc).toBe('Notion=Team')
  expect(serviceLabel('1a2b3c4d-0000-4000-8000-000000000001', custom)).toBe('Postpickr')
  expect(serviceLabel('1a2b3c4d-0000-4000-8000-000000000002', custom)).toBe('1a2b3c4d')
  expect(serviceLabel('mcp-notion-x', {})).toBe('Notion')
  expect(parseServices('')).toEqual({})
})

test('le letture non entrano nel registro', async ($, on) => {
  stubTool(on, 'ok')
  await $.tool.call({ tool: 'mcp__notion__notion-fetch', id: 'x' })
  await $.turn.complete(END)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'scritto fuori dalla repo · 1 azione' })).toBeUndefined()
})

test('un errore è segnalato in rosso e contato', async ($, on) => {
  stubTool(on, 'boom', true)
  await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
  await $.turn.complete(END)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'scritto fuori dalla repo · 1 azione · 1 da controllare' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' (errore)' })).toBeDefined()
})

test('un connettore con id opaco senza opzioni mostra l\'id accorciato', async ($, on) => {
  stubTool(on, 'ok')
  await $.tool.call({ tool: 'mcp__1a2b3c4d-0000-4000-8000-000000000001__create_post', project_id: 1 })
  await $.turn.complete(END)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '1a2b3c4d · create post · 1' })).toBeDefined()
})

test('/scritture spento non registra niente', async ($, on) => {
  stubTool(on, 'creato https://app.postpickr.com/post/123')
  const off = await $.command.run({ command: 'scritture' })
  expect(off.text).toContain('spento')
  await $.tool.call({ tool: 'mcp__postpickr__create_post', project_id: 1 })
  await $.turn.complete(END)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'scritto fuori dalla repo · 1 azione' })).toBeUndefined()
  const back = await $.command.run({ command: 'scritture', args: 'on' })
  expect(back.text).toContain('acceso')
})
