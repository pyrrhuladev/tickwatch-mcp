/**
 * Тонкий клиент публичного API.
 *
 * MCP-сервер намеренно не ходит в базу и не знает про неё ничего. Отдельная
 * реализация доступа означала бы вторую поверхность аутентификации и вторую
 * копию правил изоляции — а такие копии рано или поздно расходятся, и
 * расходятся в сторону «стало видно чужое».
 */

export interface ClientConfig {
  baseUrl: string
  token: string
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export class TickwatchClient {
  constructor(private readonly cfg: ClientConfig) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.cfg.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.cfg.token}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      // Ассистент ждёт ответа синхронно; висеть минуту недопустимо.
      signal: AbortSignal.timeout(20_000),
    })

    if (res.status === 204) return undefined as T

    const text = await res.text()
    let parsed: unknown = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      throw new ApiError(res.status, 'bad_response', `Сервис вернул не JSON (${res.status})`)
    }

    if (!res.ok) {
      const err = (parsed as { error?: { code?: string; message?: string } })?.error
      throw new ApiError(
        res.status,
        err?.code ?? 'unknown',
        err?.message ?? `Запрос отклонён (${res.status})`,
      )
    }

    return parsed as T
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path)
  }
}

export interface Me {
  workspace: { id: string; name: string | null; slug: string | null }
  plan: { id: string; name: string; monitors_limit: number }
  scopes: string[]
  usage: { monitors: number; open_incidents: number }
}
