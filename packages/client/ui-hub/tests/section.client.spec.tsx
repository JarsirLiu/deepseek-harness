// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HubSection, type HubSectionProps, type HubStatusResult } from '../src/client/HubSection.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const READY = {
  kind: 'ready',
  status: {
    status: 'connected',
    uri: 'ws://hub.example.test',
    isConnected: true,
    serverInfo: { name: 'test-hub', version: '1' },
  },
} satisfies HubStatusResult

function renderSection(loadStatus: () => Promise<HubStatusResult>) {
  return render(<HubSection {...{
    loadStatus,
    t: (key: keyof typeof en) => en[key],
  } as unknown as HubSectionProps} />)
}

describe('remote hub settings section', () => {
  it('shows loading while the status request is pending', () => {
    renderSection(() => new Promise(() => {}))

    expect(screen.getByText(`${en.status}…`)).toBeTruthy()
  })

  it.each([
    ['connected', 'Connected'],
    ['connecting', 'Connecting…'],
    ['disconnected', 'Disconnected'],
    ['error', 'Connection error'],
  ] as const)('renders the %s connection state', async (status, label) => {
    renderSection(() => Promise.resolve({
      kind: 'ready',
      status: {
        ...READY.status,
        status,
        isConnected: status === 'connected',
        serverInfo: status === 'connected' ? READY.status.serverInfo : null,
      },
    }))

    expect(await screen.findByText(label)).toBeTruthy()
    expect(screen.getByText('ws://hub.example.test')).toBeTruthy()
    if (status === 'connected') {
      expect(screen.getByText('test-hub')).toBeTruthy()
      expect(screen.getByText('1')).toBeTruthy()
    } else {
      expect(screen.queryByText('test-hub')).toBeNull()
    }
  })

  it('renders an unavailable hub without inventing connection data', async () => {
    renderSection(() => Promise.resolve({ kind: 'unavailable' }))

    expect(await screen.findByText(en.notConfigured)).toBeTruthy()
    expect(screen.getByText(en.notConfiguredHint)).toBeTruthy()
    expect(screen.queryByText(en.uri)).toBeNull()
  })

  it('shows the error message and retries the injected loader', async () => {
    const loadStatus = vi.fn()
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce(READY)
    renderSection(loadStatus)

    expect(await screen.findByText('connection refused')).toBeTruthy()
    expect(screen.getByText(en.error)).toBeTruthy()

    await act(async () => {
      screen.getByRole('button', { name: en.retry }).click()
    })
    await waitFor(() => { expect(screen.getByText('test-hub')).toBeTruthy() })
    expect(loadStatus).toHaveBeenCalledTimes(2)
  })

})
