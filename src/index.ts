#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import { ApiError, TickwatchClient, type Me } from './client.js'

/**
 * MCP-сервер Tickwatch.
 *
 * Два сценария, ради которых он существует:
 *
 * 1. Разбор инцидента. «Почему ночной бэкап упал?» — ассистент достаёт
 *    монитор, последние запуски и хвост вывода задачи. Мы уже храним ровно
 *    тот контекст, который для этого нужен.
 * 2. Заведение мониторов. «Я добавил cron-задачу, поставь на неё
 *    мониторинг» — ассистент создаёт монитор с тем же расписанием и
 *    возвращает готовую строку с curl. Это бьёт в главное трение
 *    онбординга: мониторы приходится заводить руками, по одному.
 *
 * Сервер — тонкая обёртка над публичным REST API и ничего не знает о базе.
 */

const DEFAULT_API = 'https://tickwatch.dev/api/v1'

function readConfig(): { baseUrl: string; token: string } {
  const token = process.env.TICKWATCH_TOKEN?.trim()
  if (!token) {
    // stderr, а не stdout: stdout занят протоколом, и текст в нём
    // выглядит для клиента как повреждённое сообщение.
    console.error(
      'Не задан TICKWATCH_TOKEN. Выпустите ключ в настройках воркспейса ' +
        'и передайте его серверу переменной окружения.',
    )
    process.exit(1)
  }

  return {
    token,
    baseUrl: (process.env.TICKWATCH_API_URL?.trim() || DEFAULT_API).replace(/\/+$/, ''),
  }
}

/** Ошибку API показываем ассистенту текстом, а не роняем инструмент. */
function toolError(e: unknown): { content: { type: 'text'; text: string }[]; isError: true } {
  const text =
    e instanceof ApiError
      ? `Tickwatch отклонил запрос (${e.status} ${e.code}): ${e.message}`
      : `Не удалось обратиться к Tickwatch: ${String(e)}`
  return { content: [{ type: 'text', text }], isError: true }
}

function ok(data: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
}

async function main(): Promise<void> {
  const cfg = readConfig()
  const api = new TickwatchClient(cfg)

  // Права выясняем на старте: показывать ассистенту «создать монитор»,
  // зная, что ключ только на чтение, значит обещать невыполнимое.
  let me: Me
  try {
    me = await api.get<Me>('/me')
  } catch (e) {
    console.error(
      e instanceof ApiError && e.status === 401
        ? 'Ключ недействителен: проверьте TICKWATCH_TOKEN.'
        : `Не удалось связаться с Tickwatch (${cfg.baseUrl}): ${String(e)}`,
    )
    process.exit(1)
  }

  const canWrite = me.scopes.includes('write')

  const server = new McpServer({
    name: 'tickwatch',
    version: '0.1.0',
  })

  // ── чтение ──────────────────────────────────────────────────────────────

  server.registerTool(
    'list_monitors',
    {
      title: 'Список мониторов',
      description:
        'Мониторы cron-задач воркспейса с текущим состоянием: up (работает), ' +
        'down (не выполнилась), late (опаздывает), running (выполняется), ' +
        'paused (на паузе), new (ждёт первого пинга).',
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe('Сколько вернуть, по умолчанию 50'),
        cursor: z.string().optional().describe('Курсор следующей страницы из next_cursor'),
      },
    },
    async ({ limit, cursor }) => {
      try {
        const query = new URLSearchParams()
        if (limit) query.set('limit', String(limit))
        if (cursor) query.set('cursor', cursor)
        return ok(await api.get(`/monitors?${query}`))
      } catch (e) {
        return toolError(e)
      }
    },
  )

  server.registerTool(
    'get_monitor',
    {
      title: 'Монитор целиком',
      description:
        'Один монитор со всеми настройками расписания и адресом пинга. ' +
        'Адрес пинга — секрет: он даёт право отчитаться за эту задачу.',
      inputSchema: { id: z.string().describe('Идентификатор монитора') },
    },
    async ({ id }) => {
      try {
        return ok(await api.get(`/monitors/${encodeURIComponent(id)}`))
      } catch (e) {
        return toolError(e)
      }
    },
  )

  server.registerTool(
    'get_runs',
    {
      title: 'История запусков',
      description:
        'Последние запуски задачи: код возврата, длительность и сохранённый хвост её вывода. ' +
        'ВНИМАНИЕ: вывод — это stderr клиентской задачи; в нём попадаются пути, имена баз ' +
        'и другие внутренние подробности, и он будет передан модели целиком.',
      inputSchema: {
        monitor_id: z.string().describe('Идентификатор монитора'),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ monitor_id, limit }) => {
      try {
        const query = limit ? `?limit=${limit}` : ''
        return ok(await api.get(`/monitors/${encodeURIComponent(monitor_id)}/runs${query}`))
      } catch (e) {
        return toolError(e)
      }
    },
  )

  server.registerTool(
    'list_incidents',
    {
      title: 'Инциденты',
      description:
        'Инциденты мониторов: когда началось, чем вызвано (missed — задача не отчиталась, ' +
        'failed — сообщила о падении, too_long — идёт дольше допустимого), устранено ли. ' +
        'Для вопроса «что сломано прямо сейчас» используйте status=open.',
      inputSchema: {
        status: z.enum(['open', 'all']).optional().describe('open — только незакрытые'),
        monitor_id: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ status, monitor_id, limit }) => {
      try {
        const query = new URLSearchParams()
        if (status === 'open') query.set('status', 'open')
        if (monitor_id) query.set('monitor_id', monitor_id)
        if (limit) query.set('limit', String(limit))
        return ok(await api.get(`/incidents?${query}`))
      } catch (e) {
        return toolError(e)
      }
    },
  )

  server.registerTool(
    'get_workspace',
    {
      title: 'Воркспейс',
      description: 'Текущий воркспейс, тариф, права ключа и сколько мониторов уже заведено.',
      inputSchema: {},
    },
    async () => {
      try {
        return ok(await api.get('/me'))
      } catch (e) {
        return toolError(e)
      }
    },
  )

  // ── запись ──────────────────────────────────────────────────────────────
  //
  // Регистрируются только при праве write. Инструмент, который гарантированно
  // ответит «нет доступа», хуже отсутствующего: ассистент потратит на него
  // ход и объяснит пользователю несуществующую проблему.

  if (canWrite) {
    server.registerTool(
      'create_monitor',
      {
        title: 'Создать монитор',
        description:
          'Заводит монитор и возвращает адрес пинга, который надо дописать в конец задачи ' +
          '(например `&& curl -fsS <ping_url>`). Расписание должно совпадать с настоящим ' +
          'расписанием задачи, иначе будут ложные тревоги. grace_sec — насколько задача ' +
          'может опоздать со стартом, а не сколько она работает.',
        inputSchema: {
          name: z.string().min(1).max(200).describe('Понятное человеку название задачи'),
          kind: z.enum(['cron', 'interval', 'manual']),
          cron_expr: z.string().optional().describe('Для kind=cron, пять полей как в crontab'),
          interval_sec: z.number().int().min(60).optional().describe('Для kind=interval'),
          tz: z.string().optional().describe('Пояс сервера с задачей, по умолчанию Europe/Moscow'),
          grace_sec: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe('Допустимое опоздание, по умолчанию 300'),
          max_duration_sec: z
            .number()
            .int()
            .min(1)
            .optional()
            .describe('Сообщить, если задача идёт дольше. Требует сигнала start от задачи.'),
          description: z.string().max(2000).optional(),
        },
      },
      async (input) => {
        try {
          const body: Record<string, unknown> = {
            kind: input.kind,
            name: input.name,
            tz: input.tz ?? 'Europe/Moscow',
            grace_sec: input.grace_sec ?? 300,
          }
          if (input.description) body.description = input.description
          if (input.kind === 'cron') body.cron_expr = input.cron_expr
          if (input.kind === 'interval') body.interval_sec = input.interval_sec
          if (input.kind !== 'manual' && input.max_duration_sec) {
            body.max_duration_sec = input.max_duration_sec
          }

          return ok(await api.request('POST', '/monitors', body))
        } catch (e) {
          return toolError(e)
        }
      },
    )

    server.registerTool(
      'pause_monitor',
      {
        title: 'Пауза монитора',
        description:
          'Ставит монитор на паузу или снимает с неё. Пауза нужна на время планового ' +
          'переезда или отключения задачи: удалять монитор ради этого не надо, ' +
          'вместе с ним пропадёт вся история.',
        inputSchema: {
          id: z.string(),
          paused: z.boolean().describe('true — на паузу, false — вернуть в работу'),
        },
      },
      async ({ id, paused }) => {
        try {
          return ok(await api.request('PATCH', `/monitors/${encodeURIComponent(id)}`, { paused }))
        } catch (e) {
          return toolError(e)
        }
      },
    )

    server.registerTool(
      'ack_incident',
      {
        title: 'Отметить инцидент',
        description:
          'Помечает, что инцидентом уже занимаются, чтобы остальные не бросались на ту же ' +
          'аварию. Инцидент при этом НЕ закрывается: закрыть его может только успешный ' +
          'пинг от самой задачи.',
        inputSchema: { id: z.string().describe('Идентификатор инцидента') },
      },
      async ({ id }) => {
        try {
          return ok(await api.request('POST', `/incidents/${encodeURIComponent(id)}/ack`))
        } catch (e) {
          return toolError(e)
        }
      },
    )
  }

  await server.connect(new StdioServerTransport())

  console.error(
    `Tickwatch MCP: воркспейс «${me.workspace.name ?? me.workspace.id}», ` +
      `тариф ${me.plan.name}, мониторов ${me.usage.monitors}, ` +
      `права: ${me.scopes.join(', ')}${canWrite ? '' : ' (инструменты записи отключены)'}`,
  )
}

main().catch((e) => {
  console.error('Tickwatch MCP не запустился:', e)
  process.exit(1)
})
