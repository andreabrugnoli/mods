import { expect, test } from 'claude-code/testing'
import { buildLabelDb, cleanBody, findLabels, labelTree, pickByNumbers, formatLong, formatWhen, matchLabel, nowLocal, parseJson, parseLabels, parseNextToken, parseThread, parseThreads, parseToggle, senderName, serverList, shortSender, taskFields, threadText, tomorrowNine } from '../hooks/register.js'

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
  on('ui.toast', () => ({ value: undefined }))
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

test('legge il token della pagina successiva', () => {
  const next = { content: [{ type: 'text', text: JSON.stringify({ ...THREADS, nextPageToken: 'abc' }) }], isError: false } as const
  expect(parseNextToken(next)).toBe('abc')
  expect(parseNextToken(REPLY)).toBe('')
  expect(parseNextToken({ content: [{ type: 'text', text: 'non json' }], isError: false })).toBe('')
})

test('on e off alternano e riconoscono le parole', () => {
  expect(parseToggle('', false)).toBe(true)
  expect(parseToggle('off', true)).toBe(false)
  expect(parseToggle('on', false)).toBe(true)
})

test('prova i nomi del connettore finché uno risponde', async ($, on) => {
  engine(on)
  const tried: string[] = []
  on('mcp.call', (_$, e) => {
    tried.push(e.server)
    return e.server === 'claude.ai Gmail' ? { value: REPLY } : { value: { content: [{ type: 'text', text: 'no connected MCP tool "search_threads" on a server named "' + e.server + '"' }], isError: true } }
  })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['altra mod'] }))
  const opened = await $.command.run({ command: 'posta', args: 'aggiorna' })
  expect(opened.text).toContain('2 mail')
  expect(tried.slice(0, 3)).toEqual(['Gmail', 'e14c09e8-d3bf-4f30-b839-ba795465d6b4', 'claude.ai Gmail'])
  expect(serverList({ server: ['a', 'b'], resolved: 'b' })).toEqual(['b', 'a'])
})

test('il mittente breve è il nome, il dominio o la parte personale', () => {
  expect(shortSender('Ada Rossi')).toBe('Ada Rossi')
  expect(shortSender('linkedin@em.linkedin.com')).toBe('linkedin')
  expect(shortSender('notify@mail.notion.com')).toBe('notion')
  expect(shortSender('adrianosandri41@gmail.com')).toBe('adrianosandri41')
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
// Le risposte finte di Gmail e Notion per i bottoni: thread, etichette, scritture
const GET_THREAD = { content: [{ type: 'text', text: JSON.stringify({ messages: [{ sender: 'Ada Rossi <ada@x.it>', toRecipients: ['hello@andreabrugnoli.it'], date: '2026-10-06T12:27:03Z', subject: 'Preventivo', plaintextBody: 'Mandami il preventivo entro venerdì' }] }) }], isError: false } as const
const LABELS = { content: [{ type: 'text', text: JSON.stringify({ labels: [
  { labelId: 'INBOX', name: 'INBOX', labelType: 'SYSTEM' },
  { labelId: 'Label_64', name: 'Lavoro/Esami Finanza', labelType: 'USER' },
  { labelId: 'Label_19', name: '0-Lead/Consulenza AI', labelType: 'USER' },
] }) }], isError: false } as const
const OK = { content: [{ type: 'text', text: '{}' }], isError: false } as const

// Il motore con Gmail, Notion e il modello finti; registra ogni chiamata MCP
function fakeWorld(on: (event: any, hook: any) => void, modelText: (e: any) => string) {
  engine(on)
  const calls: { server: string; tool: string; args: any }[] = []
  on('mcp.call', (_$: unknown, e: any) => {
    calls.push({ server: e.server, tool: e.tool, args: e.args })
    const byTool: Record<string, unknown> = { search_threads: REPLY, get_thread: GET_THREAD, list_labels: LABELS }
    return { value: byTool[e.tool] ?? OK }
  })
  on('model.complete', (_$: unknown, e: any) => ({ value: { isAnswered: true, text: modelText(e), usage: { input_tokens: 1, output_tokens: 1 } } }))
  on('env.get', () => ({ value: '/Users/test' }))
  on('fs.read', () => ({ value: 'Regole di prova' }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['altra mod'] }))
  return calls
}

test('Label propone senza scrivere, poi Sì applica l\'etichetta e toglie INBOX', async ($, on) => {
  const calls = fakeWorld(on, () => '2, 1')
  await $.command.run({ command: 'posta', args: 'aggiorna' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'label' })
  expect(calls.some((c) => c.tool === 'label_thread' || c.tool === 'unlabel_thread')).toBe(false)
  await ui.press({ key: 'p-Label_64' })
  expect(calls.find((c) => c.tool === 'label_thread')?.args).toEqual({ threadId: 't1', labelIds: ['Label_64'] })
  expect(calls.find((c) => c.tool === 'unlabel_thread')?.args).toEqual({ threadId: 't1', labelIds: ['INBOX'] })
  await ui.unmount()
})

test('Label: l\'utente scrive un\'etichetta e si applica quella trovata', async ($, on) => {
  const calls = fakeWorld(on, () => '2')
  await $.command.run({ command: 'posta', args: 'aggiorna' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'label' })
  await ui.input({ key: 'p-altra', text: 'consulenza' })
  expect(calls.find((c) => c.tool === 'label_thread')?.args).toEqual({ threadId: 't1', labelIds: ['Label_19'] })
  await ui.unmount()
})

test('Label con una risposta senza numeri non scrive nulla e rimette la mail in elenco', async ($, on) => {
  const calls = fakeWorld(on, () => 'Etichetta che non esiste')
  await $.command.run({ command: 'posta', args: 'aggiorna' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'label' })
  expect(calls.some((c) => c.tool === 'label_thread' || c.tool === 'unlabel_thread')).toBe(false)
  expect(await ui.find({ type: 'Button', key: 'riprova' })).toBeDefined()
  // Sulla mail successiva l'errore e Riprova non compaiono
  await ui.press({ key: 'giu' })
  expect(await ui.find({ type: 'Button', key: 'riprova' })).toBeUndefined()
  await ui.press({ key: 'su' })
  expect(await ui.find({ type: 'Button', key: 'riprova' })).toBeDefined()
  await ui.unmount()
})

test('Task crea la pagina con campi validati e lascia la mail in inbox', async ($, on) => {
  const calls = fakeWorld(on, () => '```json\n{"titolo":"Inviare il preventivo ad Ada","scadenza":"2020-01-01T09:00:00+01:00","Urgenza":"Urgentissimo","Importanza":"Importante","Impegno":"Veloce","contesto":"Lo chiede entro venerdì."}\n```')
  await $.command.run({ command: 'posta', args: 'aggiorna' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'task' })
  const page = calls.find((c) => c.tool === 'notion-create-pages')
  expect(page?.server).toBe('Notion')
  expect(page?.args.parent).toEqual({ type: 'data_source_id', data_source_id: '1ee13fe7-1a52-8195-9008-000b5e44714d' })
  const props = page?.args.pages[0].properties
  expect(props.Task).toBe('Inviare il preventivo ad Ada')
  expect(props.Urgenza).toBe('Non urgente')
  expect(props.Impegno).toBe('Veloce')
  expect(props[' ']).toBe('Non iniziato')
  expect(props['date:Data:start']).toMatch(/T09:00:00[+-]\d\d:\d\d$/)
  expect(calls.some((c) => c.tool === 'unlabel_thread')).toBe(false)
  await ui.unmount()
})

test('Bozza crea una bozza di risposta con le regole e non invia', async ($, on) => {
  const systems: string[] = []
  const calls = fakeWorld(on, (e) => {
    systems.push(e.system)
    return 'Gentile Ada,\n\nti invio il preventivo entro venerdì.\n\nCordiali saluti.\nAndrea'
  })
  await $.command.run({ command: 'posta', args: 'aggiorna' })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'bozza' })
  const draft = calls.find((c) => c.tool === 'create_draft')
  expect(draft?.args.replyToMessageId).toBe('m1')
  expect(draft?.args.body).toContain('ti invio il preventivo')
  expect(systems[0]).toBe('Regole di prova')
  expect(calls.some((c) => /send|unlabel/.test(c.tool))).toBe(false)
  await ui.unmount()
})

test('i campi del task restano negli elenchi ammessi', () => {
  const now = new Date(2026, 9, 7, 15, 0)
  const mail = { subject: 'Preventivo' }
  const f = taskFields(parseJson('niente json'), mail, now)
  expect(f.title).toBe('Preventivo')
  expect(f.due).toBe(tomorrowNine(now))
  expect([f.Urgenza, f.Importanza, f.Impegno]).toEqual(['Non urgente', 'Importante', 'Facile'])
  const ok = taskFields({ titolo: 'Chiamare Ada', scadenza: '2026-10-09T15:00:00+02:00', Urgenza: 'Urgente' }, mail, now)
  expect(ok.due).toBe('2026-10-09T15:00:00+02:00')
  expect(ok.Urgenza).toBe('Urgente')
  expect(tomorrowNine(new Date(2026, 9, 31, 23, 30))).toMatch(/^2026-11-01T09:00:00[+-]\d\d:\d\d$/)
  expect(nowLocal(new Date(2026, 9, 7, 9, 5))).toMatch(/^2026-10-07T09:05[+-]\d\d:\d\d$/)
})

test('le etichette: solo quelle utente, e solo un nome esistente', () => {
  const labels = parseLabels(LABELS)
  expect(labels.map((l) => l.id)).toEqual(['Label_64', 'Label_19'])
  expect(matchLabel('"0-lead/consulenza ai".', labels)?.id).toBe('Label_19')
  expect(matchLabel('INBOX', labels)).toBeNull()
  expect(matchLabel('', labels)).toBeNull()
  expect(threadText([])).toBe('')
})

test('giù scorre oltre la finestra, il bottone agisce sulla mail selezionata e Chiudi chiude', async ($, on) => {
  engine(on)
  const many = { threads: Array.from({ length: 12 }, (_, i) => ({ id: 't' + i, viewUrl: 'u', messages: [{ id: 'm' + i, sender: 'a' + i + '@x.it', subject: 'Oggetto ' + i, date: '2026-10-06T12:00:00Z', snippet: 's' }] })) }
  const drafts: any[] = []
  on('mcp.call', (_$: unknown, e: any) => {
    if (e.tool === 'create_draft') drafts.push(e.args)
    const byTool: Record<string, unknown> = { search_threads: { content: [{ type: 'text', text: JSON.stringify(many) }], isError: false }, get_thread: GET_THREAD }
    return { value: byTool[e.tool] ?? OK }
  })
  on('model.complete', () => ({ value: { isAnswered: true, text: 'Ciao.', usage: { input_tokens: 1, output_tokens: 1 } } }))
  on('env.get', () => ({ value: '/Users/test' }))
  on('fs.read', () => ({ value: 'Regole' }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['altra mod'] }))
  await $.command.run({ command: 'posta', args: 'aggiorna' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  for (let i = 0; i < 7; i++) await ui.press({ key: 'giu' })
  await ui.press({ key: 'bozza' })
  expect(drafts.at(-1)?.replyToMessageId).toBe('m7')
  await ui.press({ key: 'chiudi' })
  expect(closed).toContain('posta')
})

test('la mappatura delle etichette conosce le sottoetichette e le trova a pezzi', () => {
  const db = buildLabelDb([
    { id: 'a', name: 'Lavoro/AI news' },
    { id: 'b', name: 'Lavoro' },
    { id: 'c', name: 'Pagamenti/AI tools (Anthropic - Open AI)' },
  ])
  expect(db.map((l) => l.id)).toEqual(['b', 'a', 'c'])
  expect(db[1]).toMatchObject({ depth: 1, leaf: 'AI news' })
  expect(labelTree(db)).toContain('  AI news  [a]')
  expect(findLabels('lavoro/ai news', db)[0].id).toBe('a')
  expect(findLabels('ai news', db)[0].id).toBe('a')
  expect(findLabels('lavoro', db)[0].id).toBe('b')
  expect(findLabels('zzz', db)).toEqual([])
  expect(pickByNumbers('2, 1, 9, 2', db).map((l) => l.id)).toEqual(['a', 'b'])
})
