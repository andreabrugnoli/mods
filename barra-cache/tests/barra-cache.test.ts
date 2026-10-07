import { expect, mock, test } from 'claude-code/testing'

const MINUTE = 60 * 1000

// Quello che Claude Code passa a un hook ui.render per la banda sopra il prompt
const BAND = {
  plugin: 'barra-cache',
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
function stubStep(on, usage = { input_tokens: 500, cache_read_input_tokens: 9000, cache_creation_input_tokens: 500 }) {
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
        ...usage,
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
    expect(await ui.find({ type: 'Text', text: '🔥 cache calda ancora ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '60 min' })).toBeDefined()
    // Il disegno delle altre mod resta nella banda
    expect(await ui.find({ type: 'Text', text: 'altra mod' })).toBeDefined()
    await ui.unmount()

    // Mezz'ora dopo: ne restano trenta
    await clock.advance(30 * MINUTE)
    ui = await $.ui.mount({ ...BAND, surface })
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
  expect(await ui.find({ type: 'Text', text: '🔥 cache in attesa della prima richiesta' })).toBeDefined()
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

test('la riga della memoria mostra i token e la spesa a listino', async ($, on) => {
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
    expect(await ui.find({ type: 'Text', text: '🧠 memoria della chat ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '124mila token' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' · speso 3,40 $ a listino' })).toBeDefined()
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
  expect(out.text).toContain('sessione · 2,00 $')
})

test('senza misure dal motore la riga del contesto non compare', async ($, on) => {
  mock.clock(on, { now: 1000 })
  stubStep(on)
  on('turn.complete', () => ({ text: 'ok' }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['altra mod'] }))
  await runStep($)
  await $.turn.complete(END)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '🧠 memoria della chat ' })).toBeUndefined()
})

test('la durata della sessione cresce col tempo e compare anche in /cache', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  stubStep(on)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['altra mod'] }))
  await runStep($)
  await clock.advance(134 * MINUTE)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '2h 14m' })).toBeDefined()
  await ui.unmount()
  const out = await $.command.run({ command: 'cache' })
  expect(out.text).toContain('sessione · 2h 14m')
})

test('dopo una pausa con la cache riscritta la durata scende a 5 minuti', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  stubStep(on, { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 9000 })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['altra mod'] }))
  await runStep($)
  // 10 minuti dopo: la cache avrebbe retto un'ora, ma è stata riscritta, quindi dura 5 minuti
  await clock.advance(10 * MINUTE)
  await runStep($)
  await clock.advance(2 * MINUTE)
  const out = await $.command.run({ command: 'cache' })
  expect(out.text).toContain('3 min rimasti')
})

test('dopo una pausa con la cache letta la durata resta un\'ora', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  stubStep(on)
  await runStep($)
  await clock.advance(10 * MINUTE)
  await runStep($)
  await clock.advance(2 * MINUTE)
  const out = await $.command.run({ command: 'cache' })
  expect(out.text).toContain('58 min rimasti')
})

test('con la cache scaduta e un contesto grande compare l\'avviso', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  stubStep(on)
  on('session.measure', () => ({ changed: [] }))
  on('turn.complete', () => ({ text: 'ok' }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['altra mod'] }))
  await runStep($)
  await $.session.measure({ context: { tokens: 120000, window: 200000, percent: 60 }, rateLimits: [], cost: { usd: 1 }, changed: ['context'] })
  await clock.advance(61 * MINUTE)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Cache scaduta · il prossimo prompt riscrive 120mila token' })).toBeDefined()
})

test('le finestre di consumo mostrano uso 5 ore e uso settimana', async ($, on) => {
  mock.clock(on, { now: 1000 })
  stubStep(on)
  on('session.measure', () => ({ changed: [] }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['altra mod'] }))
  await runStep($)
  await $.session.measure({
    context: { tokens: 91000, window: 200000, percent: 45 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 19 },
      { kind: 'seven_day', percentUsed: 28 },
    ],
    cost: { usd: 0.42 },
    changed: ['rateLimits'],
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '⏳ uso 5 ore ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '19%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '📅 uso settimana ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '28%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '91mila token' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' · speso 0,42 $ a listino' })).toBeDefined()
})

test('/barra spegne e riaccende la banda', async ($, on) => {
  mock.clock(on, { now: 1000 })
  stubStep(on)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['altra mod'] }))
  await runStep($)
  const off = await $.command.run({ command: 'barra' })
  expect(off.text).toContain('spenta')
  let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '🔥 cache calda ancora ' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'altra mod' })).toBeDefined()
  await ui.unmount()
  const on2 = await $.command.run({ command: 'barra', args: 'on' })
  expect(on2.text).toContain('accesa')
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '🔥 cache calda ancora ' })).toBeDefined()
})
