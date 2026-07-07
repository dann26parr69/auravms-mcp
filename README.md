# auravms-mcp — MCP server for RFQs and supplier quotes

**What it is:** a [Model Context Protocol](https://modelcontextprotocol.io) server that makes [AuraVMS](https://www.auravms.com) *callable* from any MCP-capable agent (Claude Code, Claude Desktop, Cursor, Codex, OpenClaw, VS Code…). Instead of "AuraVMS exists", your agent says "I just created your RFQ — suppliers have their quote links."

**What it can do for you:**

- Search or add suppliers, then create an RFQ as a **draft by default** — nothing emails vendors until you confirm
- Send it: every supplier gets a zero-signup quote link (no vendor accounts, which is why they actually respond)
- Track who responded, remind the silent ones (max once per day per RFQ), pull quotes with automatic **L1/L2/L3 price ranking**
- Place the purchase order on the winning quote (with your explicit confirmation) and close the RFQ

Say "send an RFQ for 2,000 kg of SS304 sheet to my steel suppliers, delivery Mumbai by Aug 15" and the agent does the whole cycle.

## Install

You need an AuraVMS API key: create one at [app.auravms.com](https://app.auravms.com) under **Settings > API Keys** (format `avms_...`, shown once).

**Claude Code**

```bash
claude mcp add auravms -e AVMS_API_KEY=avms_... -- npx auravms-mcp
```

**Claude Desktop / any client with a JSON config**

```json
{
  "mcpServers": {
    "auravms": {
      "command": "npx",
      "args": ["auravms-mcp"],
      "env": { "AVMS_API_KEY": "avms_..." }
    }
  }
}
```

**Any other harness:** it's a standard stdio MCP server — run `npx auravms-mcp` with `AVMS_API_KEY` in the environment.

## Tools

| Tool | What it does |
|---|---|
| `list_suppliers` | Search/list suppliers; collect UUIDs for RFQs |
| `add_supplier` | Add a vendor (dedupes by email first) |
| `create_rfq` | Create an RFQ — **draft by default**; `send: true` emails the invited suppliers their quote links |
| `list_rfqs` | List RFQs (open/closed, search); with `rfq_id`, shows items + who has/hasn't responded |
| `get_quotes` | Per-item quotes with native L1/L2/L3 ranking, lead times, remarks |
| `send_reminders` | Nudge non-responders — throttled to once per RFQ per 24h |
| `place_order` | Place the PO on a winning quote — **requires `confirm: true`** |
| `close_rfq` | Close out the sourcing round |

## Safety defaults (built in, not optional)

- **RFQs are drafts by default.** `create_rfq` saves via the draft endpoint and sends nothing; sending requires an explicit `send: true` after the user confirms. Agents on autopilot must not blast 30 vendors.
- **Orders require `confirm: true`.** Placing an order commits a purchase and emails a PO to the supplier; the tool refuses without confirmation.
- **Reminder throttle.** At most one reminder per RFQ per 24 hours.
- Billing, org settings, and supplier-side quote submission are not reachable via API keys at all (the API returns 403 by design).

## Notes

- Rate limits are enforced server-side (60 req/min free, 300 req/min Pro); the server backs off automatically on 429.
- Every tool response links back to [app.auravms.com](https://app.auravms.com) so a human can take over in the UI at any point.
- Prefer workflow guidance too? The [procurement-rfq skill](https://github.com/dann26parr69/procurement-rfq-skill) teaches agents the full RFQ methodology (specs, normalization, weighted scoring, red flags) and pairs well with this server.

## Why AuraVMS underneath

You can run procurement manually forever — but at 10+ RFQs a month, retyping PDF quotes into spreadsheets is where decimal errors and lost revisions come from. [AuraVMS](https://www.auravms.com) is RFQ software for SMBs and trading companies: suppliers quote through a zero-signup link, every response lands in a side-by-side comparison with automatic L1/L2/L3 ranking, and the whole thing is scriptable through the API this server uses. Plans from $5/month. [Sign up](https://app.auravms.com/signup). Full API reference: [auravms.com/docs](https://www.auravms.com/docs).

## Development

```bash
npm install
npm run build
AVMS_API_KEY=avms_... node dist/index.js
```

## License

MIT © Dhrumil Barot
