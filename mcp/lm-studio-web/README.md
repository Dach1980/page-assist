# Page Assist Web MCP for LM Studio

Отдельный локальный MCP-сервер внутри репозитория Page Assist.

## Назначение

MCP предоставляет локальной модели в LM Studio два инструмента:

- web_search — поиск в интернете;
- web_fetch — загрузка страницы и очистка содержимого в Markdown через Defuddle.

Идея подпроекта — вынести веб-доступ Page Assist в стандартный MCP-интерфейс, чтобы LM Studio мог предоставлять его локальной модели без изменения основного расширения.

LM Studio поддерживает локальные MCP-серверы через mcp.json. Начиная с LM Studio 0.3.17 приложение может выступать MCP Host; для API-интеграции MCP требуется LM Studio 0.4.0+.

## Установка

Из корня репозитория:

~~~bash
cd mcp/lm-studio-web
npm install
npm run build
~~~

Для Bun:

~~~bash
bun install
bun run build
~~~

## Настройка поиска

По умолчанию используется DuckDuckGo без API-ключа:

~~~text
SEARCH_PROVIDER=duckduckgo
~~~

Также предусмотрены:

- searxng — через SEARXNG_URL;
- tavily — через TAVILY_API_KEY;
- brave — через BRAVE_API_KEY.

## Подключение к LM Studio

В LM Studio откройте Program → Install → Edit mcp.json и добавьте:

~~~json
{
  "mcpServers": {
    "page-assist-web": {
      "command": "node",
      "args": [
        "D:/Projects/page-assist/mcp/lm-studio-web/dist/index.js"
      ],
      "env": {
        "SEARCH_PROVIDER": "duckduckgo"
      }
    }
  }
}
~~~

Путь замените на фактический путь к вашему клонированному репозиторию.

После установки сервер должен предоставить инструменты web_search и web_fetch.

## Архитектура

~~~text
LM Studio
   │
   │ MCP / stdio
   ▼
page-assist-web MCP
   ├── web_search
   │    ├── DuckDuckGo
   │    ├── SearXNG
   │    ├── Tavily
   │    └── Brave
   │
   └── web_fetch
        └── HTTP → Defuddle → Markdown
~~~

MCP работает как отдельный Node-процесс. Он не зависит от UI расширения Page Assist и не требует запуска браузера.

## Безопасность

web_fetch принимает только HTTP(S) и блокирует localhost, локальные домены и приватные IP-адреса, чтобы модель не получила простой SSRF-доступ к локальной сети.

## Следующий этап

Это первая минимальная версия. Перед использованием как основной web tool стоит добавить:

1. тесты MCP-инструментов;
2. более точное переиспользование провайдеров Page Assist;
3. поддержку Exa;
4. более строгую защиту от DNS rebinding/SSRF;
5. fallback между провайдерами;
6. интеграционный тест с LM Studio.
