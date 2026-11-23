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

test('le finestre mostrano la scadenza e il limite di spesa', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-07T10:00:00') })
  stubStep(on)
  on('session.measure', () => ({ changed: [] }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['altra mod'] }))
  await runStep($)
  await $.session.measure({
    context: { tokens: 91000, window: 200000, percent: 45 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 19, resetsAt: '2026-10-07T14:30:00' },
      { kind: 'seven_day', percentUsed: 28, resetsAt: '2026-10-12T09:05:00' },
      { kind: 'spend_limit', percentUsed: 40, resetsAt: '2026-11-01T00:00:00' },
    ],
    cost: { usd: 0.42 },
    changed: ['rateLimits'],
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: ' scade 14:30' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' scade lun 12 ott 09:05' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '💳 limite di spesa ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' scade dom 1 nov 00:00' })).toBeDefined()
  const out = await $.command.run({ command: 'cache' })
  expect(out.text).toContain('uso settimana · 28%, scade lun 12 ott 09:05')
})

test('una finestra non nota compare con il suo nome e la scadenza', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-07T10:00:00') })
  stubStep(on)
  on('session.measure', () => ({ changed: [] }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['altra mod'] }))
  await runStep($)
  await $.session.measure({
    context: { tokens: 91000, window: 200000, percent: 45 },
    rateLimits: [{ kind: 'monthly', percentUsed: 12, resetsAt: '2026-11-01T00:00:00' }],
    cost: { usd: 0.42 },
    changed: ['rateLimits'],
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '📆 limite monthly ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: ' scade dom 1 nov 00:00' })).toBeDefined()
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

// Contesto in token assoluti, come lo riporta il motore
async function measureTokens($, tokens: number) {
  await $.session.measure({
    context: { tokens, window: 1000000, percent: Math.round(tokens / 10000) },
    rateLimits: [],
    cost: { usd: 1 },
    changed: ['context'],
  })
}

function watchNudge(on) {
  const toasts: string[] = []
  const contexts: string[][] = []
  on('session.measure', () => ({ changed: [] }))
  on('ui.toast', (_$, e) => {
    toasts.push(JSON.stringify(e))
    return { value: undefined }
  })
  on('prompt.submit', async (_$, e) => {
    contexts.push(e.context ?? [])
    return { text: e.text }
  })
  return { toasts, contexts }
}

test('oltre 200mila token compare l\'avviso e Claude legge il promemoria una volta sola', async ($, on) => {
  mock.clock(on, { now: 1000 })
  const { toasts, contexts } = watchNudge(on)
  await measureTokens($, 190000)
  expect(toasts).toHaveLength(0)
  await measureTokens($, 205000)
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toContain('205mila')
  await $.prompt.submit({ text: 'continua' })
  expect(contexts[0].join('\n')).toContain('Promemoria della mod barra-cache')
  expect(contexts[0].join('\n')).toContain('Nuova chat')
  // Il promemoria non torna al prompt successivo
  await $.prompt.submit({ text: 'ancora' })
  expect(contexts[1]).toHaveLength(0)
})

test('l\'avviso torna ogni 50mila token e si riarma sotto la soglia', async ($, on) => {
  mock.clock(on, { now: 1000 })
  const { toasts } = watchNudge(on)
  await measureTokens($, 205000)
  await measureTokens($, 230000)
  await measureTokens($, 249000)
  expect(toasts).toHaveLength(1)
  await measureTokens($, 255000)
  expect(toasts).toHaveLength(2)
  // Dopo /clear il contesto riparte e l'avviso si riarma
  await measureTokens($, 3000)
  await measureTokens($, 201000)
  expect(toasts).toHaveLength(3)
})

test('con la barra spenta non ci sono avvisi né promemoria', async ($, on) => {
  mock.clock(on, { now: 1000 })
  const { toasts, contexts } = watchNudge(on)
  await $.command.run({ command: 'barra', args: 'off' })
  await measureTokens($, 300000)
  await $.prompt.submit({ text: 'continua' })
  expect(toasts).toHaveLength(0)
  expect(contexts[0]).toHaveLength(0)
})

// Il passaggio a una chat nuova: registra la domanda sul modello, i comandi e i prompt, e risponde alla domanda con `answer`
function watchHandoff(on, answer?: string) {
  const asked: string[] = []
  const commands: string[] = []
  const sent: string[] = []
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    const q = e.questions[0]
    asked.push(q.question + ' | ' + q.options.map((o) => o.label).join(', '))
    if (answer === undefined) return { deny: 'chiusa' }
    return { result: { questions: e.questions, answers: { [q.question]: answer } } }
  })
  on('command.run', (_$, e) => {
    commands.push(e.command + (e.args ? ' ' + e.args : ''))
    return { text: '' }
  })
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.id', () => ({ value: 'sessione-1' }))
  on('prompt.submit', async (_$, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  on('turn.complete', () => ({ text: 'ok' }))
  on('ui.toast', () => ({ value: undefined }))
  return { asked, commands, sent }
}

async function finishTurn($) {
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  // La ripartenza non si attende dentro il turno: le si lascia il tempo di finire
  for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0))
}

test('Nuova chat chiede il modello e riparte con quello scelto', async ($, on) => {
  const { asked, commands, sent } = watchHandoff(on, 'Haiku 5.5')
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['altra mod'] }))
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'fresh' })
  expect(asked).toHaveLength(1)
  expect(asked[0]).toContain('Ora usi claude-opus-5-5')
  expect(asked[0]).toContain('Sonnet 5.5 (consigliato), Opus 5.5, Haiku 5.5, Resta sul modello attuale')
  expect(sent[0]).toContain('~/.claude/handoffs/')
  await finishTurn($)
  expect(commands).toEqual(['clear', 'model haiku'])
  expect(sent[1]).toContain('Riprendi il lavoro')
})

test('/nuova con un modello salta la domanda', async ($, on) => {
  const { asked, commands, sent } = watchHandoff(on, 'Haiku 5.5')
  await $.command.run({ command: 'nuova', args: 'opus' })
  await finishTurn($)
  expect(asked).toHaveLength(0)
  expect(sent[0]).toContain('~/.claude/handoffs/')
  await finishTurn($)
  expect(commands).toContain('model opus')
  expect(commands.indexOf('clear')).toBeLessThan(commands.indexOf('model opus'))
})

for (const [name, answer] of [['domanda chiusa', undefined], ['"Resta sul modello attuale"', 'Resta sul modello attuale']] as const) {
  test(name + ': la chat riparte senza cambiare modello', async ($, on) => {
    const { commands, sent } = watchHandoff(on, answer)
    await $.command.run({ command: 'nuova' })
    await finishTurn($)
    expect(sent[0]).toContain('~/.claude/handoffs/')
    await finishTurn($)
    expect(commands).toContain('clear')
    expect(commands.some((c) => c.startsWith('model'))).toBe(false)
    expect(sent[1]).toContain('Riprendi il lavoro')
  })
}
