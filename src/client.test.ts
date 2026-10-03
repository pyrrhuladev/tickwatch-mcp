import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError, TickwatchClient } from './client.js'

/**
 * Разбор ответов API.
 *
 * Ошибка, дошедшая до ассистента, — это то, что он покажет человеку. Если
 * вместо «ключу не хватает доступа write» он получит «TypeError: cannot read
 * property», человек услышит выдуманное объяснение проблемы.
 */

const client = () => new TickwatchClient({ baseUrl: 'http://api.test/v1', token: 'twk_test' })

function reply(status: number, body: string, ok = status < 400) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () => new Response(body, { status, headers: { 'content-type': 'application/json' } }),
    ),
  )
  return ok
}

afterEach(() => vi.unstubAllGlobals())

describe('TickwatchClient', () => {
  it('передаёт токен заголовком', async () => {
    const spy = vi.fn(async () => new Response('{"data":[]}', { status: 200 }))
    vi.stubGlobal('fetch', spy)

    await client().get('/monitors')

    const [, init] = spy.mock.calls[0]!
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer twk_test' })
  })

  it('204 не пытается разбирать как JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 })),
    )
    await expect(client().request('DELETE', '/monitors/x')).resolves.toBeUndefined()
  })

  it('ошибку API превращает в читаемое сообщение', async () => {
    reply(
      403,
      JSON.stringify({ error: { code: 'forbidden', message: 'Ключу не хватает доступа' } }),
    )

    await expect(client().get('/monitors')).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
      message: 'Ключу не хватает доступа',
    })
  })

  it('ответ не в формате JSON не роняет клиент', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>502 Bad Gateway</html>', { status: 502 })),
    )

    const err = await client()
      .get('/monitors')
      .catch((e) => e)

    expect(err).toBeInstanceOf(ApiError)
    expect(err.code).toBe('bad_response')
    expect(err.message).toContain('502')
  })

  it('ошибка без ожидаемого тела всё равно осмысленна', async () => {
    reply(500, '{}')

    const err = await client()
      .get('/monitors')
      .catch((e) => e)

    expect(err.code).toBe('unknown')
    expect(err.message).toContain('500')
  })

  it('тело отправляется только когда есть что отправлять', async () => {
    const spy = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', spy)

    await client().get('/me')
    const [, getInit] = spy.mock.calls[0]!
    // Заголовок content-type на GET без тела сбивает с толку прокси и логи.
    expect((getInit as RequestInit).headers).not.toHaveProperty('content-type')

    await client().request('POST', '/monitors', { name: 'x' })
    const [, postInit] = spy.mock.calls[1]!
    expect((postInit as RequestInit).headers).toMatchObject({
      'content-type': 'application/json',
    })
    expect((postInit as RequestInit).body).toBe('{"name":"x"}')
  })
})
