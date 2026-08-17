/** Real Hub Server/Client process isolation for endpoint identity ownership. */

import { createServer } from 'node:net'
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

interface RunningProcess {
  child: ChildProcess
  ready: Promise<Record<string, unknown>>
}

const tsconfigPath = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))
const serverFixture = fileURLToPath(new URL('./fixtures/hub-server.ts', import.meta.url))
const clientFixture = fileURLToPath(new URL('./fixtures/hub-client.ts', import.meta.url))
const children: ChildProcess[] = []

afterEach(async () => {
  await Promise.all(children.splice(0).map(stopProcess))
})

describe('Hub endpoint identity across isolated processes', () => {
  it('uses the Hub handshake identity in a real Server/Client connection', async () => {
    const port = await freePort()
    const server = startProcess(serverFixture, [String(port), 'remote:process-owned'])
    children.push(server.child)
    await expect(server.ready).resolves.toMatchObject({ type: 'ready', endpointId: 'remote:process-owned' })

    const client = startProcess(clientFixture, [`ws://127.0.0.1:${port}/hub`])
    children.push(client.child)
    await expect(client.ready).resolves.toMatchObject({
      type: 'ready',
      endpointId: 'remote:process-owned',
      serverInfo: { name: 'deepseek-harness-hub', version: '0.1.0' },
    })
  }, 15_000)
})

function startProcess(script: string, args: readonly string[]): RunningProcess {
  const child = spawn(process.execPath, ['--import', 'tsx/esm', script, ...args], {
    cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
    env: { ...process.env, TSX_TSCONFIG_PATH: tsconfigPath },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const ready = new Promise<Record<string, unknown>>((resolve, reject) => {
    const stdout = child.stdout
    if (stdout === null) {
      reject(new Error('Hub fixture did not provide stdout'))
      return
    }
    const lines = createInterface({ input: stdout })
    const stderr: string[] = []
    child.stderr?.on('data', (chunk) => { stderr.push(String(chunk)) })
    lines.on('line', (line) => {
      try {
        const value = JSON.parse(line) as Record<string, unknown>
        if (value.type === 'ready' || value.type === 'error') {
          lines.close()
          if (value.type === 'error') reject(new Error(String(value.message)))
          else resolve(value)
        }
      } catch {
        // Non-JSON diagnostics are retained in the child stderr or ignored here.
      }
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      reject(new Error(`Hub fixture exited before ready: code=${String(code)} signal=${String(signal)} stderr=${stderr.join('')}`))
    })
  })
  child.stdin?.end()
  return { child, ready }
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve) => {
    child.once('exit', () => { resolve() })
    child.kill('SIGTERM')
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, 1_000).unref()
  })
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { resolve() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('failed to allocate a TCP port')
  const port = address.port
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    })
  })
  return port
}
