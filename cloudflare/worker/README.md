# VNplayer Cloudflare Front Door

This Worker gives ChatGPT/WebGPT a stable HTTPS MCP URL while the local
`cloudflared` quick tunnel rotates.

Runtime:

```text
ChatGPT -> https://vnplayer-frontdoor.<subdomain>.workers.dev/mcp
        -> Worker KV origin=https://xxxx.trycloudflare.com
        -> cloudflared -> http://127.0.0.1:4174/mcp
        -> local VNplayer backend
```

Only the MCP/WebGPT connector surface is proxied. The reader app and SQLite
remain local.
