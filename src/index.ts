#!/usr/bin/env node
/**
 * auravms-mcp — MCP server for the AuraVMS RFQ/procurement API.
 *
 * Wraps the live public API at https://api.auravms.com (docs: https://www.auravms.com/docs).
 * Stateless: reads AVMS_API_KEY from the environment. Stdio transport.
 *
 * Safety defaults (non-negotiable):
 *   - create_rfq creates a DRAFT unless send:true is passed explicitly.
 *   - place_order refuses without confirm:true (it emails a purchase order to the supplier).
 *   - send_reminders is throttled to once per RFQ per 24h (in-process guard).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE_URL = process.env.AVMS_BASE_URL ?? "https://api.auravms.com";
const API_KEY = process.env.AVMS_API_KEY;

if (!API_KEY) {
  console.error(
    "auravms-mcp: AVMS_API_KEY environment variable is not set.\n" +
      "Create an API key in the AuraVMS app under Settings > API Keys " +
      "(https://app.auravms.com), then run with AVMS_API_KEY=avms_... " +
      "(e.g. claude mcp add auravms -e AVMS_API_KEY=avms_... -- npx auravms-mcp)"
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Tiny API client: Bearer auth, {success,error} envelope, 429 backoff.
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api(
  method: "GET" | "POST",
  path: string,
  body?: unknown
): Promise<any> {
  const maxAttempts = 4;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    if (res.status === 429 && attempt < maxAttempts) {
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 1000 * 2 ** attempt
      );
      continue;
    }

    if (res.status === 403) {
      throw new Error(
        `403 Forbidden on ${path}. This endpoint is restricted to the web app ` +
          `(org settings, billing, supplier-side submission, etc.) — do not retry via API key.`
      );
    }

    let data: any;
    const text = await res.text();
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`AuraVMS API returned non-JSON (HTTP ${res.status}): ${text.slice(0, 300)}`);
    }

    if (!res.ok || data?.success === false) {
      throw new Error(
        `AuraVMS API error (HTTP ${res.status}) on ${path}: ${data?.error ?? text.slice(0, 300)}`
      );
    }
    return data;
  }
}

function ok(payload: unknown, note?: string) {
  const text =
    (note ? note + "\n\n" : "") +
    (typeof payload === "string" ? payload : JSON.stringify(payload, null, 2));
  return { content: [{ type: "text" as const, text }] };
}

function fail(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

const APP_URL = "https://app.auravms.com";

// ---------------------------------------------------------------------------
// Server + tools
// ---------------------------------------------------------------------------

const server = new McpServer({ name: "auravms", version: "0.1.0" });

// --- list_suppliers ---------------------------------------------------------

server.registerTool(
  "list_suppliers",
  {
    title: "List suppliers",
    description:
      "Search or list suppliers in the AuraVMS account. Use before add_supplier " +
      "(supplier emails are unique) and to collect supplier UUIDs for create_rfq.",
    inputSchema: {
      search: z.string().optional().describe("Search term (name, email, category)"),
      page: z.number().int().positive().optional().describe("Page number"),
      page_size: z.number().int().positive().max(100).optional().describe("Results per page (default 20)"),
    },
  },
  async ({ search, page, page_size }) => {
    const qs = new URLSearchParams();
    if (search) qs.set("search", search);
    if (page) qs.set("page", String(page));
    qs.set("page_size", String(page_size ?? 20));
    const data = await api("GET", `/api/get-suppliers/?${qs}`);
    return ok(data, `Suppliers (manage at ${APP_URL}):`);
  }
);

// --- add_supplier -----------------------------------------------------------

server.registerTool(
  "add_supplier",
  {
    title: "Add supplier",
    description:
      "Add a new supplier to the AuraVMS account. Searches for the email first " +
      "(supplier emails are unique — re-adding an existing vendor fails). " +
      "Returns the supplier UUID to use in create_rfq.",
    inputSchema: {
      company_name: z.string().min(1),
      person_of_contact: z.string().min(1),
      phone_no: z.string().min(1),
      email: z.string().email(),
      categories: z.array(z.string()).optional().describe('e.g. ["Raw Materials"]'),
    },
  },
  async (input) => {
    // Dedupe: supplier email is unique.
    const existing = await api(
      "GET",
      `/api/get-suppliers/?search=${encodeURIComponent(input.email)}&page_size=5`
    );
    const rows: any[] =
      existing?.data?.results ?? existing?.data?.suppliers ?? existing?.results ??
      (Array.isArray(existing?.data) ? existing.data : []);
    const dup = rows.find(
      (s) => String(s?.email ?? "").toLowerCase() === input.email.toLowerCase()
    );
    if (dup) {
      return ok(dup, `Supplier with email ${input.email} already exists — reusing it (no duplicate created):`);
    }
    const data = await api("POST", "/api/create-supplier/", input);
    return ok(data, `Supplier created. Collect data.supplier_id for create_rfq. Manage at ${APP_URL}.`);
  }
);

// --- create_rfq -------------------------------------------------------------

server.registerTool(
  "create_rfq",
  {
    title: "Create RFQ (draft by default)",
    description:
      "Create an RFQ in AuraVMS. SAFETY: by default this saves a DRAFT and emails nobody. " +
      "Pass send:true ONLY after the user has explicitly confirmed — sending emails a " +
      "zero-signup quote link to every invited supplier. Supplier IDs come from " +
      "list_suppliers / add_supplier.",
    inputSchema: {
      title: z.string().min(1).describe("RFQ title, e.g. 'Q3 Raw Materials'"),
      items: z
        .array(
          z.object({
            product_name: z.string().min(1),
            quantity: z.number().positive(),
            uom: z.string().min(1).describe("Unit of measure, e.g. kg, pcs, meters"),
            specifications: z.string().optional().describe("Pinned spec: grade/standard, dimensions+tolerances, certifications, substitutions policy"),
            expected_delivery_date: z.string().optional().describe("YYYY-MM-DD"),
          })
        )
        .min(1),
      suppliers: z.array(z.string()).min(1).describe("Supplier UUIDs to invite"),
      payment_terms: z.string().optional().describe("e.g. 'Net 30 from invoice'"),
      shipping_terms: z.string().optional().describe("e.g. 'FOB destination'"),
      terms_and_condition: z.string().optional(),
      send: z
        .boolean()
        .default(false)
        .describe("false (default) = save draft only. true = send to suppliers NOW (requires explicit user confirmation)."),
    },
  },
  async ({ send, ...body }) => {
    const draft = await api("POST", "/api/save-rfq-draft/", body);
    const rfqId = draft?.rfq_id ?? draft?.data?.rfq_id;
    if (!send) {
      return ok(
        draft,
        `Draft RFQ saved (rfq_id=${rfqId}). NO emails sent. Review at ${APP_URL}, ` +
          `then call create_rfq again with send:true — or ask me to send this draft — ` +
          `once the user confirms.`
      );
    }
    if (rfqId === undefined || rfqId === null) {
      return fail(
        `Draft was saved but no rfq_id came back, so it was NOT sent. Response: ${JSON.stringify(draft)}`
      );
    }
    const sent = await api("POST", `/api/send-rfq-draft/${rfqId}/`);
    return ok(
      { draft, sent },
      `RFQ ${rfqId} SENT — each invited supplier received a quote link by email. Track at ${APP_URL}.`
    );
  }
);

// --- list_rfqs --------------------------------------------------------------

server.registerTool(
  "list_rfqs",
  {
    title: "List RFQs",
    description:
      "List RFQs (filter by status open/closed, search, paginate). Pass rfq_id to get one " +
      "RFQ's items and per-supplier response status (has_responded / is_declined — answers " +
      "'who hasn't responded?'). Item ids feed get_quotes.",
    inputSchema: {
      rfq_id: z.number().int().positive().optional().describe("Fetch items + supplier response status for this RFQ"),
      status: z.enum(["open", "closed"]).optional(),
      search: z.string().optional(),
      page: z.number().int().positive().optional(),
      page_size: z.number().int().positive().max(100).optional(),
    },
  },
  async ({ rfq_id, status, search, page, page_size }) => {
    if (rfq_id) {
      const data = await api("GET", `/api/get-rfq-items/${rfq_id}/`);
      return ok(data, `RFQ ${rfq_id} items + supplier response status (view at ${APP_URL}):`);
    }
    const qs = new URLSearchParams();
    if (status) qs.set("status", status);
    if (search) qs.set("search", search);
    if (page) qs.set("page", String(page));
    if (page_size) qs.set("page_size", String(page_size));
    const suffix = qs.size ? `?${qs}` : "";
    const data = await api("GET", `/api/get-rfq-list/${suffix}`);
    return ok(data, `RFQs (view at ${APP_URL}):`);
  }
);

// --- get_quotes -------------------------------------------------------------

server.registerTool(
  "get_quotes",
  {
    title: "Get quotes for an RFQ item (L1/L2/L3)",
    description:
      "Pull all supplier quotes for one RFQ line item, with AuraVMS's native L1/L2/L3 " +
      "price ranking (L1 = lowest quoted price). Returns per-supplier price, lead time, " +
      "remarks, response_id (needed by place_order) and rank_label. L1 is price-only — " +
      "still weigh lead time, payment terms and deviations before recommending an award.",
    inputSchema: {
      rfq_item_id: z.number().int().positive().describe("Line-item id from list_rfqs (rfq_id=...) / create_rfq created_items"),
    },
  },
  async ({ rfq_item_id }) => {
    const data = await api("GET", `/api/rfq-item-data/${rfq_item_id}`);
    return ok(
      data,
      `Quotes for item ${rfq_item_id} with L1/L2/L3 rank_label (view at ${APP_URL}). ` +
        `Red flag: an L1 more than ~15% below the median needs written reconfirmation before any PO.`
    );
  }
);

// --- place_order ------------------------------------------------------------

server.registerTool(
  "place_order",
  {
    title: "Place purchase order (requires confirm:true)",
    description:
      "Place the purchase order on a winning quote. SAFETY: this is a purchase commitment " +
      "and emails a PO to the supplier — it refuses unless confirm:true is passed after " +
      "the user has explicitly approved this exact order. bought_quantity/bought_price " +
      "default to the quoted values; only override deliberately (negotiated price, split award).",
    inputSchema: {
      rfq_item_id: z.number().int().positive(),
      response_id: z.number().int().positive().describe("Winning quote's response_id from get_quotes"),
      bought_quantity: z.number().positive().optional(),
      bought_price: z.number().positive().optional(),
      confirm: z
        .boolean()
        .default(false)
        .describe("Must be true, and only after explicit user approval of this specific order."),
    },
  },
  async ({ rfq_item_id, confirm, ...body }) => {
    if (!confirm) {
      return fail(
        "Refusing to place the order: confirm is not true. Placing an order commits a purchase " +
          "and emails a PO to the supplier. Show the user the winning quote (supplier, price, " +
          "quantity, lead time), get their explicit approval, then call again with confirm:true."
      );
    }
    const data = await api("POST", `/api/rfq-item-data/${rfq_item_id}`, body);
    return ok(data, `Order placed for item ${rfq_item_id} — the supplier has been emailed a PO. View at ${APP_URL}.`);
  }
);

// --- send_reminders ---------------------------------------------------------

const lastReminderAt = new Map<number, number>(); // rfq_id -> epoch ms (in-process guard)
const DAY_MS = 24 * 60 * 60 * 1000;

server.registerTool(
  "send_reminders",
  {
    title: "Send reminders to non-responders",
    description:
      "Email a reminder to suppliers who haven't responded to an RFQ. Omit supplier_ids " +
      "to remind all non-responders. SAFETY: throttled to once per RFQ per 24 hours — " +
      "chasing more often weakens the buyer's position.",
    inputSchema: {
      rfq_id: z.number().int().positive(),
      supplier_ids: z.array(z.string()).optional().describe("Specific supplier UUIDs; omit to remind all non-responders"),
    },
  },
  async ({ rfq_id, supplier_ids }) => {
    const last = lastReminderAt.get(rfq_id);
    if (last && Date.now() - last < DAY_MS) {
      const hrs = Math.ceil((DAY_MS - (Date.now() - last)) / 3_600_000);
      return fail(
        `Refusing: reminders for RFQ ${rfq_id} were already sent in the last 24h ` +
          `(~${hrs}h until the throttle clears). One reminder per day per RFQ, max.`
      );
    }
    const body: Record<string, unknown> = { rfq_id };
    if (supplier_ids?.length) body.supplier_ids = supplier_ids;
    const data = await api("POST", "/api/send-reminders/", body);
    lastReminderAt.set(rfq_id, Date.now());
    return ok(data, `Reminders sent for RFQ ${rfq_id}. Next allowed in 24h.`);
  }
);

// --- close_rfq --------------------------------------------------------------

server.registerTool(
  "close_rfq",
  {
    title: "Close RFQ",
    description:
      "Close an RFQ once awards are placed (or the sourcing round is abandoned). " +
      "Suppliers can no longer submit quotes after closing.",
    inputSchema: {
      rfq_id: z.number().int().positive(),
    },
  },
  async ({ rfq_id }) => {
    const data = await api("POST", `/api/close-rfq/${rfq_id}/`);
    return ok(data, `RFQ ${rfq_id} closed. Paper trail exports available at ${APP_URL}.`);
  }
);

// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`auravms-mcp: connected on stdio (base ${BASE_URL})`);
