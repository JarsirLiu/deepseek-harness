/** Real Hub Server/Client process isolation for endpoint identity ownership. */

import { createServer } from 'node:net'
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

interface RunningProcess {
  child: ChildProcess
  ready: Promise<Record<string, unknown>>
  directoryUpdated: Promise<Record<string, unknown>>
}

const tsconfigPath = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))
const serverFixture = fileURLToPath(new URL('./fixtures/hub-server.ts', import.meta.url))
const clientFixture = fileURLToPath(new URL('./fixtures/hub-client.ts', import.meta.url))
const agentFixture = fileURLToPath(new URL('./fixtures/hub-agent.ts', import.meta.url))
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

  it('registers an Endpoint Agent and exposes its workspace through discovery', async () => {
    const port = await freePort()
    const server = startProcess(serverFixture, [String(port), 'remote:broker-owned'])
    children.push(server.child)
    await expect(server.ready).resolves.toMatchObject({ type: 'ready', endpointId: 'remote:broker-owned' })

    const agent = startProcess(agentFixture, [String(port)])
    children.push(agent.child)
    await expect(agent.ready).resolves.toMatchObject({ type: 'ready', endpointId: 'remote:registered-agent' })

    const secondAgent = startProcess(agentFixture, [String(port), 'remote:second-agent'])
    children.push(secondAgent.child)
    await expect(secondAgent.ready).resolves.toMatchObject({ type: 'ready', endpointId: 'remote:second-agent' })

    const client = startProcess(clientFixture, [`ws://127.0.0.1:${port}/hub`])
    children.push(client.child)
    const clientReady = await client.ready
    expect(clientReady.type).toBe('ready')
    const endpointList = clientReady.endpoints as {
      endpoints: Array<{ endpointId: string; workspaces: Array<{ id: string }> }>
    }
    expect(endpointList.endpoints.some(endpoint => endpoint.endpointId === 'remote:registered-agent'
      && endpoint.workspaces.some(workspace => workspace.id === 'workspace-agent'))).toBe(true)
    expect(endpointList.endpoints.some(endpoint => endpoint.endpointId === 'remote:second-agent'
      && endpoint.workspaces.some(workspace => workspace.id === 'workspace-agent'))).toBe(true)
    const workspaceList = clientReady.workspaces as {
      endpointId: string
      workspaces: Array<{ endpointId: string; id: string }>
    }
    expect(workspaceList.workspaces).toEqual(expect.arrayContaining([
      expect.objectContaining({ endpointId: 'remote:registered-agent', id: 'workspace-agent' }),
      expect.objectContaining({ endpointId: 'remote:second-agent', id: 'workspace-agent' }),
    ]))

    const routedClient = startProcess(clientFixture, [
      `ws://127.0.0.1:${port}/hub`, 'remote:registered-agent', 'workspace-agent',
    ])
    children.push(routedClient.child)
    await expect(routedClient.ready).resolves.toMatchObject({
      request: { ok: true, value: { source: 'remote:registered-agent' } },
    })

    const secondRoutedClient = startProcess(clientFixture, [
      `ws://127.0.0.1:${port}/hub`, 'remote:second-agent', 'workspace-agent',
    ])
    children.push(secondRoutedClient.child)
    await expect(secondRoutedClient.ready).resolves.toMatchObject({
      request: { ok: true, value: { source: 'remote:second-agent' } },
    })

    const unknownEndpointClient = startProcess(clientFixture, [
      `ws://127.0.0.1:${port}/hub`, 'remote:missing', 'workspace-agent',
    ])
    children.push(unknownEndpointClient.child)
    await expect(unknownEndpointClient.ready).rejects.toThrow('remote endpoint unavailable: remote:missing')

    const duplicateAgent = startProcess(agentFixture, [String(port)])
    children.push(duplicateAgent.child)
    await expect(duplicateAgent.ready).rejects.toThrow('endpoint already connected: remote:registered-agent')
  }, 15_000)

  it('rejects a routed request after the owning Agent disconnects', async () => {
    const port = await freePort()
    const server = startProcess(serverFixture, [String(port), 'remote:broker-owned'])
    children.push(server.child)
    await server.ready

    const agent = startProcess(agentFixture, [String(port)])
    children.push(agent.child)
    await agent.ready
    await stopProcess(agent.child)

    const client = startProcess(clientFixture, [
      `ws://127.0.0.1:${port}/hub`, 'remote:registered-agent', 'workspace-agent',
    ])
    children.push(client.child)
    await expect(client.ready).rejects.toThrow('remote endpoint unavailable: remote:registered-agent')
  }, 15_000)

  it('projects only the selected workspace when session ids collide within one Agent', async () => {
    const port = await freePort()
    const server = startProcess(serverFixture, [String(port), 'remote:broker-owned'])
    children.push(server.child)
    await server.ready

    const agent = startProcess(agentFixture, [String(port), 'remote:multi-agent', 'workspace-a,workspace-b'])
    children.push(agent.child)
    await agent.ready

    const client = startProcess(clientFixture, [
      `ws://127.0.0.1:${port}/hub`, 'remote:multi-agent', 'workspace-b',
    ])
    children.push(client.child)
    const ready = await client.ready
    const workspaces = ready.workspaces as { workspaces: Array<{ id: string; sessions: Array<{ sessionId: string }> }> }
    expect(workspaces.workspaces).toEqual([
      expect.objectContaining({
        id: 'workspace-b',
        sessions: [expect.objectContaining({ sessionId: 'shared-session' })],
      }),
    ])
  }, 15_000)

  it('discovers a workspace added by the Agent after registration', async () => {
    const port = await freePort()
    const server = startProcess(serverFixture, [String(port), 'remote:broker-owned'])
    children.push(server.child)
    await server.ready

    const agent = startProcess(agentFixture, [String(port), 'remote:registered-agent', 'workspace-agent', 'workspace-new'])
    children.push(agent.child)
    await agent.ready
    await expect(agent.directoryUpdated).resolves.toMatchObject({ workspaceId: 'workspace-new' })

    const client = startProcess(clientFixture, [`ws://127.0.0.1:${port}/hub`, 'remote:registered-agent', 'workspace-new'])
    children.push(client.child)
    await expect(client.ready).resolves.toMatchObject({
      workspaces: { workspaces: [expect.objectContaining({ id: 'workspace-new', endpointId: 'remote:registered-agent' })] },
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
  let resolveDirectoryUpdated: (value: Record<string, unknown>) => void
  const directoryUpdated = new Promise<Record<string, unknown>>((resolve) => {
    resolveDirectoryUpdated = resolve
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
          if (value.type === 'error') reject(new Error(String(value.message)))
          else resolve(value)
        }
        if (value.type === 'directory-updated') resolveDirectoryUpdated(value)
      } catch {
        // Non-JSON diagnostics are retained in the child stderr or ignored here.
      }
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      reject(new Error(`Hub fixture exited before ready: code=${String(code)} signal=${String(signal)} stderr=${stderr.join('')}`))
      resolveDirectoryUpdated({ type: 'directory-update-unavailable', code, signal, stderr: stderr.join('') })
    })
  })
  child.stdin?.end()
  return { child, ready, directoryUpdated }
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
