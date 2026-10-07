import { expect, test } from 'claude-code/testing'
import { buildPrompt, formatWhen, parseThreads, parseToggle, senderName, serverList } from '../hooks/register.js'

const BAND = {
  plugin: 'posta',
  component: 'AbovePrompt',
  viewport: { columns: 160, rows: 40 },
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 160, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

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
  expect(buildPrompt('task', account, mail)).toContain('data con giorno e ora')
  expect(buildPrompt('misto', account, mail)).toContain('create_draft')
  expect(buildPrompt('misto', account, mail)).toContain('list_labels')
  expect(formatWhen('data sbagliata')).toBe('')
})

test('/posta apre la inbox e Label invia il prompt e toglie la mail', async ($, on) => {
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
