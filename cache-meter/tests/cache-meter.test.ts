import { expect, mock, test } from 'claude-code/testing'

const MINUTE = 60 * 1000

// Quello che Claude Code passa a un hook ui.render per la banda sopra il prompt
const BAND = {
  plugin: 'cache-meter',
  component: 'AbovePrompt',
  viewport: { columns: 160, rows: 40 },
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 160,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

// Una richiesta al modello andata a buon fine
function stubStep(on) {
  on('turn.step', async function* ($, e) {
    yield { kind: 'text', index: 0, text: 'ok' }
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'ok',
      toolUses: [],
      stopReason: 'end_turn',
      usage: {
        model: 'claude-test',
        output_tokens: 50,
        input_tokens: 500,
        cache_read_input_tokens: 9000,
        cache_creation_input_tokens: 500,
      },
    }
  })
}

async function runStep($, input = {}) {
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'claude-test', messageCount: 1, ...input })
  let step = await stream.next()
  while (step.done !== true) step = await stream.next()
  return step.value
}

test('la barra si svuota col tempo e una nuova richiesta la riempie', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  stubStep(on)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['altra mod'] }))

  for (const surface of ['terminal', 'desktop'] as const) {
    await runStep($)

    // Appena dopo la richiesta: barra piena, un'ora davanti
    let ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: '█'.repeat(12) })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '60 min' })).toBeDefined()
    // Il disegno delle altre mod resta nella banda
    expect(await ui.find({ type: 'Text', text: 'altra mod' })).toBeDefined()
    await ui.unmount()

    // Mezz'ora dopo: metà barra
    await clock.advance(30 * MINUTE)
    ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: '█'.repeat(6) })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '30 min' })).toBeDefined()
    await ui.unmount()

    // Passata l'ora: scaduta
    await clock.advance(31 * MINUTE)
    ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: 'scaduta' })).toBeDefined()
    await ui.unmount()
  }
})

test('le richieste dei subagent non rinnovano la barra', async ($, on) => {
  mock.clock(on)
  stubStep(on)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['altra mod'] }))

  await runStep($, { agentId: 'agent-1' })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'cache · in attesa della prima richiesta' })).toBeDefined()
  await ui.unmount()
})

test('il bottone Commit e push invia il prompt di commit', async ($, on) => {
  const sent: string[] = []
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['altra mod'] }))
  on('prompt.submit', async ($, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'commit' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'fresh' })).toBeDefined()
  await ui.press({ key: 'commit' })
  expect(sent.some((t) => t.includes('git push'))).toBe(true)
})

test('/cache risponde prima e dopo la prima richiesta', async ($, on) => {
  mock.clock(on, { now: 1000 })
  stubStep(on)
  const before = await $.command.run({ command: 'cache' })
  expect(before.text).toContain('in attesa')
  await runStep($)
  const after = await $.command.run({ command: 'cache' })
  expect(after.text).toContain('60 min')
})

// Dove git non è raggiungibile (le sessioni cloud non hanno $.process) la banda resta quella di prima
test('senza git la banda mostra Commit e Nuova chat e nessuna riga della repo', async ($, on) => {
  on('turn.complete', () => ({ text: 'ok' }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['altra mod'] }))
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'commit' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'fresh' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'push' })).toBeUndefined()
})

test('/push senza git chiede il push al modello', async ($, on) => {
  const sent: string[] = []
  on('prompt.submit', async (_$, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  on('turn.complete', () => ({ text: 'ok' }))
  const out = await $.command.run({ command: 'push' })
  expect(out.text).toContain('Push avviato')
  // Il prompt parte a fine turno, non dentro il comando
  expect(sent).toEqual([])
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  await new Promise((r) => setTimeout(r, 20))
  expect(sent.some((t) => t.includes('git push'))).toBe(true)
})

const END = { answer: 'ok', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as const

// Contesto e costo come li riporta il motore a ogni misura
async function measure($, percent: number, usd: number) {
  await $.session.measure({
    context: { tokens: percent * 2000, window: 200000, percent },
    rateLimits: [],
    cost: { usd },
    changed: ['context', 'cost'],
  })
}

test('la riga dei consumi mostra contesto, turno e cache letta', async ($, on) => {
  mock.clock(on, { now: 1000 })
  stubStep(on)
  on('session.measure', () => ({ changed: [] }))
  on('turn.complete', () => ({ text: 'ok' }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['altra mod'] }))

  for (const surface of ['terminal', 'desktop'] as const) {
    await runStep($)
    await measure($, 62, 3.4)
    await $.turn.complete(END)
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: '62%' })).toBeDefined()
    // 9000 letti su 10000 totali: 90% dalla cache
    expect(await ui.find({ type: 'Text', text: '90%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '1k nuovi · 50 generati' })).toBeDefined()
    await ui.unmount()
  }
})

test('oltre l\'80% di contesto la banda suggerisce Nuova chat', async ($, on) => {
  mock.clock(on, { now: 1000 })
  stubStep(on)
  on('session.measure', () => ({ changed: [] }))
  on('turn.complete', () => ({ text: 'ok' }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['altra mod'] }))
  await runStep($)
  await measure($, 85, 1)
  await $.turn.complete(END)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: ' · Nuova chat?' })).toBeDefined()
})

test('/cache riporta anche contesto, turno e cache letta', async ($, on) => {
  mock.clock(on, { now: 1000 })
  stubStep(on)
  on('session.measure', () => ({ changed: [] }))
  on('turn.complete', () => ({ text: 'ok' }))
  await runStep($)
  await measure($, 40, 2)
  await $.turn.complete(END)
  const out = await $.command.run({ command: 'cache' })
  expect(out.text).toContain('contesto · 40% (80k su 200k)')
  expect(out.text).toContain('cache letta · 90%')
  expect(out.text).toContain('sessione · $2,00')
})

test('senza misure dal motore la riga del contesto non compare', async ($, on) => {
  mock.clock(on, { now: 1000 })
  stubStep(on)
  on('turn.complete', () => ({ text: 'ok' }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['altra mod'] }))
  await runStep($)
  await $.turn.complete(END)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'contesto ' })).toBeUndefined()
})
