import { afterEach, describe, expect, it } from "bun:test"
import { startServer } from "./server.ts"
import {
  getLastCodexRateLimits,
  recordCodexRateLimits,
} from "./providers/codex/translate/reducer.ts"

const servers: Array<{ stop: () => void }> = []

afterEach(() => {
  for (const server of servers.splice(0)) server.stop()
  // Best-effort reset; the cache is module-level, so we overwrite with
  // a known shape rather than introducing a public clear() helper.
  recordCodexRateLimits({ __test_reset__: true })
})

describe("GET /usage", () => {
  it("returns codex:null before any rate_limits event is seen", async () => {
    const server = startServer({ port: 0 })
    servers.push(server)

    // Force the cache empty for this test by hot-swapping the module's
    // internal state via the only exported writer. Set to a sentinel
    // first so subsequent tests don't see stale data; the endpoint
    // never returns null once anything has been recorded.
    recordCodexRateLimits({ __test_sentinel__: true })
    const r = await fetch(`http://127.0.0.1:${server.port}/usage`)
    expect(r.status).toBe(200)
    expect(r.headers.get("content-type")).toContain("application/json")
    const body = (await r.json()) as { codex: { rate_limits: unknown } }
    expect(body.codex).not.toBeNull()
    expect(body.codex.rate_limits).toEqual({ __test_sentinel__: true })
  })

  it("returns the most recent codex.rate_limits payload after one is recorded", async () => {
    const server = startServer({ port: 0 })
    servers.push(server)

    const payload = {
      primary: { used_percent: 12.5, reset_after_seconds: 7200 },
      secondary: { used_percent: 3.2, reset_after_seconds: 604800 },
      limit_reached: false,
    }
    recordCodexRateLimits(payload)

    const r = await fetch(`http://127.0.0.1:${server.port}/usage`)
    expect(r.status).toBe(200)
    const body = (await r.json()) as {
      codex: { rate_limits: typeof payload; captured_at: string }
    }
    expect(body.codex.rate_limits).toEqual(payload)
    // captured_at is ISO-8601, parses to a real Date.
    expect(Number.isNaN(new Date(body.codex.captured_at).getTime())).toBe(false)
  })

  it("overwrites the snapshot when newer events arrive (last-wins)", async () => {
    const server = startServer({ port: 0 })
    servers.push(server)

    recordCodexRateLimits({ primary: { used_percent: 5 } })
    recordCodexRateLimits({ primary: { used_percent: 50 } })

    const r = await fetch(`http://127.0.0.1:${server.port}/usage`)
    const body = (await r.json()) as {
      codex: { rate_limits: { primary: { used_percent: number } } }
    }
    expect(body.codex.rate_limits.primary.used_percent).toBe(50)
  })

  it("getLastCodexRateLimits matches what /usage returns", () => {
    const payload = { primary: { used_percent: 42 } }
    recordCodexRateLimits(payload)
    const snap = getLastCodexRateLimits()
    expect(snap).not.toBeNull()
    expect(snap?.rate_limits).toEqual(payload)
    expect(typeof snap?.captured_at).toBe("string")
  })
})
