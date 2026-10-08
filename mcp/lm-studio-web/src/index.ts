import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { parseHTML } from "linkedom"
import { Defuddle } from "defuddle/node"
import { load } from "cheerio"
import { z } from "zod"
import dns from "node:dns/promises"
import net from "node:net"

const DEFAULT_TIMEOUT = Number(process.env.WEB_FETCH_TIMEOUT_MS || 30000)
const MAX_CHARS = Number(process.env.WEB_FETCH_MAX_CHARS || 30000)
const MAX_RESULTS = Number(process.env.WEB_SEARCH_MAX_RESULTS || 8)
const USER_AGENT = "Page-Assist-LM-Studio-Web-MCP/0.1"

type SearchResult = {
  title: string
  url: string
  snippet: string
  provider: string
}

function privateIpv4(ip: string): boolean {
  const p = ip.split(".").map(Number)
  if (p.length !== 4 || p.some(Number.isNaN)) return false
  const a = p[0]
  const b = p[1]
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

function privateIpv6(ip: string): boolean {
  const v = ip.toLowerCase()
  return v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80:")
}

async function publicUrl(raw: string): Promise<URL> {
  let url: URL
  try { url = new URL(raw) } catch { throw new Error("Invalid URL") }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only HTTP(S) URLs are allowed")
  }
  const host = url.hostname.toLowerCase()
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
      host === "host.docker.internal" || host === "gateway.docker.internal") {
    throw new Error("Private/local host is not allowed")
  }
  if (net.isIP(host)) {
    if ((net.isIPv4(host) && privateIpv4(host)) || (net.isIPv6(host) && privateIpv6(host))) {
      throw new Error("Private/local IP address is not allowed")
    }
    return url
  }
  const addresses = await dns.lookup(host, { all: true })
  for (const item of addresses) {
    if ((net.isIPv4(item.address) && privateIpv4(item.address)) ||
        (net.isIPv6(item.address) && privateIpv6(item.address))) {
      throw new Error("URL resolves to a private/local IP address")
    }
  }
  return url
}

async function get(url: URL): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT)
  try {
    return await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8"
      }
    })
  } finally {
    clearTimeout(timer)
  }
}

async function duckduckgo(query: string, limit: number): Promise<SearchResult[]> {
  const url = new URL("https://html.duckduckgo.com/html/")
  url.searchParams.set("q", query)
  const response = await get(url)
  if (!response.ok) throw new Error("DuckDuckGo HTTP " + response.status)
  const $ = load(await response.text())
  const results: SearchResult[] = []
  $(".result").each((_, element) => {
    if (results.length >= limit) return
    const link = $(element).find(".result__a").first()
    const href = link.attr("href")
    const title = link.text().trim()
    const snippet = $(element).find(".result__snippet").first().text().trim()
    if (href && title) results.push({ title, url: href, snippet, provider: "duckduckgo" })
  })
  return results
}

async function searxng(query: string, limit: number): Promise<SearchResult[]> {
  const base = process.env.SEARXNG_URL
  if (!base) throw new Error("SEARXNG_URL is not configured")
  const url = new URL("/search", base)
  url.searchParams.set("q", query)
  url.searchParams.set("format", "json")
  url.searchParams.set("categories", "general")
  const response = await get(url)
  if (!response.ok) throw new Error("SearXNG HTTP " + response.status)
  const data = await response.json() as { results?: Array<{title?: string; url?: string; content?: string}> }
  return (data.results || []).slice(0, limit).flatMap(item =>
    item.url && item.title ? [{title: item.title, url: item.url, snippet: item.content || "", provider: "searxng"}] : []
  )
}

async function tavily(query: string, limit: number): Promise<SearchResult[]> {
  const key = process.env.TAVILY_API_KEY
  if (!key) throw new Error("TAVILY_API_KEY is not configured")
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT)
  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      signal: controller.signal,
      headers: {"Authorization": "Bearer " + key, "Content-Type": "application/json"},
      body: JSON.stringify({query, max_results: limit, topic: "general", search_depth: "basic"})
    })
    if (!response.ok) throw new Error("Tavily HTTP " + response.status)
    const data = await response.json() as {results?: Array<{title?: string; url?: string; content?: string}>}
    return (data.results || []).flatMap(item =>
      item.url && item.title ? [{title: item.title, url: item.url, snippet: item.content || "", provider: "tavily"}] : []
    )
  } finally {
    clearTimeout(timer)
  }
}

async function brave(query: string, limit: number): Promise<SearchResult[]> {
  const key = process.env.BRAVE_API_KEY
  if (!key) throw new Error("BRAVE_API_KEY is not configured")
  const url = new URL("https://api.search.brave.com/res/v1/web/search")
  url.searchParams.set("q", query)
  url.searchParams.set("count", String(limit))
  const response = await fetch(url, {headers: {"Accept": "application/json", "X-Subscription-Token": key}})
  if (!response.ok) throw new Error("Brave HTTP " + response.status)
  const data = await response.json() as {web?: {results?: Array<{title?: string; url?: string; description?: string}>}}
  return (data.web?.results || []).flatMap(item =>
    item.url && item.title ? [{title: item.title, url: item.url, snippet: item.description || "", provider: "brave"}] : []
  )
}

async function search(query: string, provider: string, limit: number): Promise<SearchResult[]> {
  if (provider === "searxng") return searxng(query, limit)
  if (provider === "tavily") return tavily(query, limit)
  if (provider === "brave") return brave(query, limit)
  return duckduckgo(query, limit)
}

const server = new McpServer({name: "page-assist-web", version: "0.1.0"})

server.registerTool("web_search", {
  description: "Search the public web using a Page Assist-style search provider.",
  inputSchema: {
    query: z.string().min(1).max(1000),
    provider: z.enum(["duckduckgo", "searxng", "tavily", "brave"]).optional(),
    max_results: z.number().int().min(1).max(20).optional()
  }
}, async ({query, provider, max_results}) => {
  const selected = provider || process.env.SEARCH_PROVIDER || "duckduckgo"
  const results = await search(query, selected, Math.min(max_results || MAX_RESULTS, 20))
  return {content: [{type: "text", text: JSON.stringify({query, provider: selected, results}, null, 2)}]}
})

server.registerTool("web_fetch", {
  description: "Fetch a public page and return clean Markdown using Defuddle.",
  inputSchema: {
    url: z.string().url(),
    max_chars: z.number().int().min(1000).max(100000).optional(),
    language: z.string().min(2).max(20).optional()
  }
}, async ({url: rawUrl, max_chars, language}) => {
  const url = await publicUrl(rawUrl)
  const response = await get(url)
  if (!response.ok) throw new Error("Fetch HTTP " + response.status)
  const contentType = response.headers.get("content-type") || ""
  if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
    const content = (await response.text()).slice(0, max_chars || MAX_CHARS)
    return {content: [{type: "text", text: JSON.stringify({url: response.url, content_type: contentType, content}, null, 2)}]}
  }
  const html = await response.text()
  const parsed = parseHTML(html)
  const result = await Defuddle(parsed.document, response.url, {markdown: true, language, useAsync: false})
  const content = String(result.content || "").slice(0, max_chars || MAX_CHARS)
  return {content: [{type: "text", text: JSON.stringify({
    url: response.url,
    title: result.title || "",
    description: result.description || "",
    author: result.author || "",
    published: result.published || "",
    site: result.site || "",
    word_count: result.wordCount || 0,
    content
  }, null, 2)}]}
})

await server.connect(new StdioServerTransport())
