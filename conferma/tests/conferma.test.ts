import { expect, test } from 'claude-code/testing'
import { findProposal } from '../hooks/register.js'

const BAND = {
  plugin: 'conferma',
  component: 'AbovePrompt',
  viewport: { columns: 160, rows: 40 },
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 160, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const END = (answer: string) => ({ answer, durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' }) as const

test('riconosce una proposta dall\'ultimo paragrafo', () => {
  expect(findProposal('Ho letto i file.\n\nVuoi che li sposti nella cartella archivio?')).toContain('archivio')
  expect(findProposal('Ecco il piano. Procedo con la fase 4')).toContain('Procedo')
  expect(findProposal('Fatto. Ho aggiornato il file.')).toBeNull()
  expect(findProposal('')).toBeNull()
})

test('a fine turno con una proposta compaiono i due bottoni, e Sì invia la risposta', async ($, on) => {
  const sent: string[] = []
  on('turn.complete', () => ({ text: 'ok' }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['altra mod'] }))
  on('prompt.submit', async (_$, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    await $.turn.complete(END('Ho trovato 40 casi.\n\nProcedo con la migrazione?'))
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Button', key: 'si' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'no' })).toBeDefined()
    await ui.press({ key: 'si' })
    expect(sent.at(-1)).toBe('Sì, procedi.')
    await ui.unmount()
  }
})

test('senza proposta non compare niente', async ($, on) => {
  on('turn.complete', () => ({ text: 'ok' }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['altra mod'] }))
  await $.turn.complete(END('Fatto, ho aggiornato il file.'))
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'si' })).toBeUndefined()
})
