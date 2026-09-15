import { describe, expect, it, vi } from 'vitest'
import { registerTaskControlRoute } from '../src/task-control-routes.ts'
import type { PluginUnaryRoute } from '../src/http.ts'
const captured = vi.hoisted(() => ({ route: undefined as PluginUnaryRoute | undefined }))
vi.mock('../src/http.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/http.ts')>(),
  registerPluginRoute: (_ctx: unknown, route: PluginUnaryRoute) => { captured.route = route },
}))

describe('task stop routing', () => {
  it('checks session ownership and task identity before dispatch and redacts control failures', async () => {
    const stop = vi.fn(async () => true)
    registerTaskControlRoute({} as never, stop, id => id === 'code')
    const request = async (sessionId: string, body: unknown) => captured.route!.handler({
      method: 'POST', url: new URL(`http://localhost/?sessionId=${sessionId}`),
      signal: new AbortController().signal, body: async <T,>() => body as T,
    })
    expect((await request('cowork', { taskId: 'task' })).status).toBe(409)
    expect((await request('code', { taskId: 12 })).status).toBe(400)
    expect((await request('', { taskId: 'task' })).status).toBe(400)
    expect(stop).not.toHaveBeenCalled()
    expect((await request('code', { taskId: 'task' })).status).toBe(200)
    expect(stop).toHaveBeenCalledWith('code', 'task')
    stop.mockResolvedValueOnce(false)
    expect((await request('code', { taskId: 'stale' })).status).toBe(409)
    stop.mockRejectedValueOnce(new Error('private process diagnostics'))
    expect(await request('code', { taskId: 'task' })).toEqual({ status: 502, value: { error: 'task-stop-failed' } })
  })
})
