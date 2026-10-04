import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'registro-scritture',
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

test('una scrittura su Postpickr compare a fine turno con il link', async ($, on) => {
  stubTool(on, 'creato https://app.postpickr.com/post/123')
  await $.tool.call({ tool: 'mcp__1ff0d358-ee8f-4832-ba13-c6e721d4279a__create_post', project_id: 1 })
  await $.turn.complete(END)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'scritto fuori dalla repo · 1 azione' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Postpickr · create post · 1' })).toBeDefined()
  expect(await ui.find({ type: 'Link' })).toBeDefined()
})

test('le letture non entrano nel registro', async ($, on) => {
  stubTool(on, 'ok')
  await $.tool.call({ tool: 'mcp__46dded4b-f2d2-4af7-9ae7-1db030709c49__notion-fetch', id: 'x' })
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
