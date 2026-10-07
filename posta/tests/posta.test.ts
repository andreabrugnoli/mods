import { expect, test } from 'claude-code/testing'
import { buildPrompt, cleanBody, formatLong, formatWhen, parseThread, parseThreads, parseToggle, senderName, serverList, shortSender, threadText, nowLocal } from '../hooks/register.js'

const BAND = {
  plugin: 'posta',
  component: 'Pane',
  requestId: 'posta',
  viewport: { columns: 160, rows: 40 },
  props: { title: 'Posta', isFocused: true, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 30 } },
} as const

// Il motore sotto la mod: apre e chiude i pannelli
const closed: string[] = []
function engine(on: (event: any, hook: any) => void) {
  closed.length = 0
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', (_$: unknown, e: { id: string }) => {
    closed.push(e.id)
    return { value: undefined }
  })
}

const THREADS = {
  threads: [
    { id: 't1', viewUrl: 'u1', messages: [{ id: 'm1', sender: 'Ada Rossi <ada@x.it>', subject: 'Preventivo', date: '2026-10-06T12:27:03Z', snippet: 'Ciao Andrea' }] },
    { id: 't2', viewUrl: 'u2', messages: [{ id: 'm2', sender: 'info@y.it', subject: 'Fattura', date: '2026-10-06T08:03:36Z', snippet: 'In allegato' }] },
  ],
}

const REPLY = { content: [{ type: 'text', text: JSON.stringify(THREADS) }], isError: false } as const

test('legge i thread e il nome del mittente', () => {
  const mails = parseThreads(REPLY)
  expect(mails).toHaveLength(2)
  expect(mails[0].sender).toBe('Ada Rossi')
  expect(mails[1].sender).toBe('info@y.it')
  expect(parseThreads({ content: [{ type: 'text', text: 'non json' }], isError: false })).toEqual([])
  expect(senderName('"Bianchi, Luca" <l@z.it>')).toBe('Bianchi, Luca')
})

test('on e off alternano e riconoscono le parole', () => {
  expect(parseToggle('', false)).toBe(true)
  expect(parseToggle('off', true)).toBe(false)
  expect(parseToggle('on', false)).toBe(true)
})

test('il prompt della bozza non invia e quello del task chiede data e ora', () => {
  const account = { name: 'hello', email: 'hello@a.it', server: 'claude.ai Gmail' }
  const mail = { threadId: 't1', messageId: 'm1', sender: 'Ada', subject: 'Preventivo' }
  expect(buildPrompt('bozza', account, mail)).toContain('Non inviare mai la mail')
  expect(buildPrompt('task', account, mail)).toContain('data e ora di scadenza')
  expect(buildPrompt('misto', account, mail)).toContain('create_draft')
  expect(buildPrompt('misto', account, mail)).toContain('list_labels')
  expect(formatWhen('data sbagliata')).toBe('')
})

test('/posta apre la inbox e Label invia il prompt e toglie la mail', async ($, on) => {
  engine(on)
  const sent: string[] = []
  on('mcp.call', () => ({ value: REPLY }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['altra mod'] }))
  on('prompt.submit', async (_$, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  const opened = await $.command.run({ command: 'posta' })
  expect(opened.text).toContain('2 mail')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Button', key: 'label' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'task' })).toBeDefined()
    await ui.unmount()
  }
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'label' })
  expect(sent.at(-1)).toContain('thread t1')
  expect(sent.at(-1)).toContain('LABEL')
  await ui.unmount()
  const closed = await $.command.run({ command: 'posta', args: 'off' })
  expect(closed.text).toContain('chiusa')
})

test('prova i nomi del connettore finché uno risponde', async ($, on) => {
  engine(on)
  const tried: string[] = []
  on('mcp.call', (_$, e) => {
    tried.push(e.server)
    return e.server === 'Gmail' ? { value: REPLY } : { value: { content: [{ type: 'text', text: 'no connected MCP tool "search_threads" on a server named "' + e.server + '"' }], isError: true } }
  })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['altra mod'] }))
  const opened = await $.command.run({ command: 'posta', args: 'aggiorna' })
  expect(opened.text).toContain('2 mail')
  expect(tried.slice(0, 2)).toEqual(['claude.ai Gmail', 'Gmail'])
  expect(serverList({ server: ['a', 'b'], resolved: 'b' })).toEqual(['b', 'a'])
})

test('il mittente breve è il nome, il dominio o la parte personale', () => {
  expect(shortSender('Ada Rossi')).toBe('Ada Rossi')
  expect(shortSender('linkedin@em.linkedin.com')).toBe('linkedin')
  expect(shortSender('notify@mail.notion.com')).toBe('notion')
  expect(shortSender('adrianosandri41@gmail.com')).toBe('adrianosandri41')
})

test('giù scorre la selezione oltre la finestra e Chiudi nasconde i bottoni', async ($, on) => {
  engine(on)
  const sent: string[] = []
  const many = { threads: Array.from({ length: 12 }, (_, i) => ({ id: 't' + i, viewUrl: 'u', messages: [{ id: 'm' + i, sender: 'a' + i + '@x.it', subject: 'Oggetto ' + i, date: '2026-10-06T12:00:00Z', snippet: 's' }] })) }
  on('mcp.call', () => ({ value: { content: [{ type: 'text', text: JSON.stringify(many) }], isError: false } }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['altra mod'] }))
  on('prompt.submit', async (_$, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  await $.command.run({ command: 'posta', args: 'aggiorna' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'task' })).toBeDefined()
  for (let i = 0; i < 7; i++) await ui.press({ key: 'giu' })
  await ui.press({ key: 'bozza' })
  expect(sent.at(-1)).toContain('thread t7')
  await ui.press({ key: 'chiudi' })
  expect(closed).toContain('posta')
})

test('legge il thread dal più recente e pulisce il testo', () => {
  const reply = { content: [{ type: 'text', text: JSON.stringify({ messages: [
    { sender: 'a@x.it', toRecipients: ['h@y.it'], date: '2026-10-06T08:00:00Z', subject: 'Uno', plaintextBody: 'Primo\n\n\n\n*************************\nfine', attachments: [{ filename: 'f.pdf' }] },
    { sender: 'h@y.it', toRecipients: ['a@x.it'], date: '2026-10-07T08:00:00Z', subject: 'Re: Uno', plaintextBody: 'Secondo' },
  ] }) }], isError: false } as const
  const messages = parseThread(reply)
  expect(messages.map((m) => m.subject)).toEqual(['Re: Uno', 'Uno'])
  expect(messages[1].attachments).toEqual(['f.pdf'])
  expect(messages[1].body).toBe('Primo\n\n────────\nfine')
  expect(cleanBody('')).toBe('')
  expect(formatLong('data sbagliata')).toBe('')
  expect(formatLong('2026-10-07T09:26:00')).toMatch(/^7 ott 2026, \d\d:\d\d$/)
})

test('scrivere posta apre il pannello senza arrivare al modello', async ($, on) => {
  engine(on)
  let reachedModel = false
  on('mcp.call', () => ({ value: REPLY }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['altra mod'] }))
  on('prompt.submit', async (_$, e) => {
    reachedModel = true
    return { text: e.text }
  })
  const out = await $.prompt.submit({ text: 'posta', asUser: true })
  expect(reachedModel).toBe(false)
  expect(JSON.stringify(out)).toContain('aperta')
})

test('il prompt del task contiene database e campi e non chiede letture', () => {
  const account = { name: 'hello', email: 'hello@a.it', server: 'Gmail' }
  const mail = { threadId: 't1', messageId: 'm1', sender: 'Ada', subject: 'Preventivo', url: 'https://mail/x' }
  const text = threadText([{ from: 'Ada', date: '2026-10-07T08:00:00Z', subject: 'Preventivo', body: 'Mandami il preventivo entro venerdì' }])
  const prompt = buildPrompt('task', account, mail, text)
  expect(prompt).toContain('1ee13fe7-1a52-8195-9008-000b5e44714d')
  expect(prompt).toContain('Non usare notion-fetch')
  expect(prompt).toContain('Mandami il preventivo entro venerdì')
  expect(prompt).not.toContain('Leggi il thread completo con get_thread')
  expect(prompt).toContain('Non iniziato')
  expect(buildPrompt('task', account, mail)).toContain('get_thread')
  expect(nowLocal(new Date(2026, 9, 7, 9, 5))).toMatch(/^2026-10-07T09:05[+-]\d\d:\d\d$/)
})
