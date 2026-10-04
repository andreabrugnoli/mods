import { expect, test } from 'claude-code/testing'
import { classify, denial, question } from '../hooks/register.js'

test('riconosce i comandi distruttivi e quelli verso l\'esterno', () => {
  expect(classify({ tool: 'Bash', command: 'rm -rf build' })?.kind).toBe('cancella')
  expect(classify({ tool: 'Bash', command: 'git push --force origin main' })?.kind).toBe('cancella')
  expect(classify({ tool: 'Bash', command: 'git reset --hard HEAD~1' })?.kind).toBe('cancella')
  expect(classify({ tool: 'Bash', command: 'python3 fase4.py --elimina --applica' })?.kind).toBe('cancella')
  expect(classify({ tool: 'Bash', command: 'python3 fase4.py --applica' })?.kind).toBe('esterno')
  expect(classify({ tool: 'Bash', command: 'curl -X POST https://api.example.com/x' })?.kind).toBe('esterno')
})

test('lascia passare comandi innocui e prove a secco', () => {
  expect(classify({ tool: 'Bash', command: 'ls -la' })).toBeNull()
  expect(classify({ tool: 'Bash', command: 'git push origin main' })).toBeNull()
  expect(classify({ tool: 'Bash', command: 'rm file.txt' })).toBeNull()
  expect(classify({ tool: 'Bash', command: 'python3 fase4.py --elimina --dry-run' })).toBeNull()
  expect(classify({ tool: 'Read', file_path: '/tmp/x' })).toBeNull()
})

test('i tool MCP: cancellare e pubblicare sì, leggere no', () => {
  expect(classify({ tool: 'mcp__notion__notion-fetch', id: 'x' })).toBeNull()
  expect(classify({ tool: 'mcp__gmail__search_threads' })).toBeNull()
  expect(classify({ tool: 'mcp__gmail__trash_message' })?.kind).toBe('cancella')
  expect(classify({ tool: 'mcp__gmail__send_message' })?.kind).toBe('esterno')
  expect(classify({ tool: 'mcp__postpickr__create_post' })?.kind).toBe('esterno')
  expect(classify({ tool: 'mcp__spreaker__schedule_episode' })?.kind).toBe('esterno')
  expect(classify({ tool: 'mcp__notion__notion-update-page' })).toBeNull()
})

test('la domanda dice cosa sta per succedere e i messaggi di rifiuto guidano il modello', () => {
  const info = classify({ tool: 'Bash', command: 'rm -rf build' })
  expect(question(info)).toContain('Azione irreversibile')
  expect(question(info)).toContain('rm -rf build')
  expect(denial('Prova a secco')).toContain('prova a secco')
  expect(denial('Annulla')).toContain('annullato')
})

// Il motore sotto la mod: risponde alla domanda con la scelta data, esegue il resto
function stubUser(on, answer: string, ran: string[] = []) {
  on('tool.call', async (_$, e) => {
    if (e.tool === 'AskUserQuestion') {
      return { ref: 1, result: { questions: e.questions, answers: { [e.questions[0].question]: answer } }, text: 'ok' }
    }
    ran.push(e.tool)
    return { ref: 2, result: {}, text: 'eseguito' }
  })
  return ran
}

test('Esegui lascia partire la chiamata', async ($, on) => {
  const ran = stubUser(on, 'Esegui')
  const r = await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
  expect(r.deny).toBeUndefined()
  expect(ran).toEqual(['Bash'])
})

test('Annulla e Prova a secco bloccano la chiamata con il messaggio giusto', async ($, on) => {
  const ran = stubUser(on, 'Prova a secco')
  const dry = await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
  expect(dry.deny).toContain('prova a secco')
  expect(ran).toEqual([])
})

test('un comando innocuo non fa nessuna domanda', async ($, on) => {
  const asked: string[] = []
  on('tool.call', async (_$, e) => {
    asked.push(e.tool)
    return { ref: 1, result: {}, text: 'ok' }
  })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(asked).toEqual(['Bash'])
})
