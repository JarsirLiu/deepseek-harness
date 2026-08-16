import { describe, expect, it } from 'vitest'
import type { HostFrame } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { isHostFrameVisibleToWorkspaces } from '../src/workspace-subscription.ts'

const selected = new Set(['workspace-a'])
const workspaces = [{ id: 'workspace-a', path: 'D:/projects/a', sessionIds: ['session-a' as SessionId] }]

describe('Hub workspace event filtering', () => {
  it('rejects every frame when no workspace is selected', () => {
    expect(isHostFrameVisibleToWorkspaces({ type: 'host/session-status', sessionId: 'session-a' as SessionId, running: true }, new Set(), workspaces)).toBe(false)
  })

  it('accepts a selected workspace session and rejects an unselected session', () => {
    const frame: HostFrame = { type: 'host/session-status', sessionId: 'session-a' as SessionId, running: true }
    expect(isHostFrameVisibleToWorkspaces(frame, selected, workspaces)).toBe(true)
    expect(isHostFrameVisibleToWorkspaces({ ...frame, sessionId: 'session-b' as SessionId }, selected, workspaces)).toBe(false)
  })

  it('accepts a new selected-workspace session before membership is recorded', () => {
    expect(isHostFrameVisibleToWorkspaces({ type: 'host/session-added', sessionId: 'session-new' as SessionId, blank: true, cwd: 'D:/projects/a' }, selected, workspaces)).toBe(true)
  })

  it('filters workspace lifecycle frames by selected workspace', () => {
    expect(isHostFrameVisibleToWorkspaces({ type: 'host/workspace-changed', workspace: { workspaceId: 'workspace-a' } } as never, selected, workspaces)).toBe(true)
    expect(isHostFrameVisibleToWorkspaces({ type: 'host/workspace-removed', workspaceId: 'workspace-b' } as never, selected, workspaces)).toBe(false)
    expect(isHostFrameVisibleToWorkspaces({ type: 'host/workspace-order-changed', workspaceIds: ['workspace-b', 'workspace-a'] }, selected, workspaces)).toBe(true)
  })

  it('keeps selected-project control frames and filters unrelated archive snapshots', () => {
    expect(isHostFrameVisibleToWorkspaces({ type: 'host/remote-event', event: 'settings/document-updated', args: [] }, selected, workspaces)).toBe(true)
    expect(isHostFrameVisibleToWorkspaces({ type: 'stream/error', error: { code: 'internal', message: 'down' } } as never, selected, workspaces)).toBe(true)
    expect(isHostFrameVisibleToWorkspaces({ type: 'host/archived-sessions-changed', archivedSessionIds: ['session-b' as SessionId] }, selected, workspaces)).toBe(false)
    expect(isHostFrameVisibleToWorkspaces({ type: 'host/archived-sessions-changed', archivedSessionIds: ['session-a' as SessionId] }, selected, workspaces)).toBe(true)
  })
})
