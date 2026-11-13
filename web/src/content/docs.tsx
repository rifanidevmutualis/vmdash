export type DocBlock =
  | { kind: "p"; text: string }
  | { kind: "h3"; text: string }
  | { kind: "list"; items: string[]; ordered?: boolean }
  | { kind: "code"; label: string; code: string }
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "callout"; tone: "info" | "warn" | "bad"; title: string; text: string }
  | { kind: "kv"; items: [string, string][] };

export type DocSection = {
  id: string;
  title: string;
  summary: string;
  blocks: DocBlock[];
};

export const DOCS: DocSection[] = [
  {
    id: "start",
    title: "Start here",
    summary: "What vmdash is, and the one concept that explains the data model.",
    blocks: [
      {
        kind: "p",
        text: "**vmdash** is a local control plane for InstaBox machines. It keeps your API keys on your machine, fans them out to every workspace you connect, and gives both you and your agents one place to control the fleet.",
      },
      {
        kind: "list",
        items: [
          "Rust backend (axum) with a SQLite cache, an operation watcher, and an audit log.",
          "React UI served by the same binary. Dark and light mode, no telemetry.",
          "An MCP server over Streamable HTTP (`/mcp`) and stdio (`vmdash mcp-stdio`).",
          "A WebSocket proxy for interactive terminals and VNC desktops.",
        ],
      },
      {
        kind: "callout",
        tone: "info",
        title: "One key = one workspace, not one VM",
        text: "An InstaBox API key belongs to a workspace and can see every machine in it. That is why this dashboard stores keys per workspace. Do not try to make one key per machine: InstaBox caps a workspace at 20 active keys.",
      },
      {
        kind: "p",
        text: "Read **Connect a workspace** next, then **Security model** to see exactly where the key goes.",
      },
    ],
  },
  {
    id: "install",
    title: "Install & run",
    summary: "Requirements, build from source, install to PATH, update and uninstall.",
    blocks: [
      {
        kind: "h3",
        text: "Requirements",
      },
      {
        kind: "table",
        head: ["Dependency", "Why", "Notes"],
        rows: [
          ["Rust stable 1.80+", "Compiles the server", "Tested with 1.100"],
          ["Node.js 20+ / npm", "Builds the React UI", "Not needed at runtime; the UI is embedded"],
          ["make", "One-command build", "Optional"],
          ["macOS 13+ / Linux", "Runs the binary", "Windows: use WSL2 (untested natively)"],
        ],
      },
      {
        kind: "h3",
        text: "Build from source",
      },
      {
        kind: "code",
        label: "shell",
        code: "git clone https://github.com/rifanidevmutualis/vmdash.git\ncd vmdash\nmake build\n./target/release/vmdash",
      },
      {
        kind: "p",
        text: "Without `make`:",
      },
      {
        kind: "code",
        label: "shell",
        code: "cd web && npm install && npm run build && cd ..\ncargo build --release\n./target/release/vmdash",
      },
      {
        kind: "p",
        text: "Open `http://127.0.0.1:8787`. The release binary embeds the UI, so it can be moved anywhere. On first run it creates a data directory:",
      },
      {
        kind: "kv",
        items: [
          ["macOS", "`~/Library/Application Support/vmdash/`"],
          ["Linux", "`~/.local/share/vmdash/`"],
          ["Windows", "`%APPDATA%\\vmdash\\` (untested)"],
        ],
      },
      {
        kind: "list",
        items: [
          "`vmdash.db` — SQLite cache, operations, audit, webhook secrets.",
          "`master.key` — 32 random bytes, permission `0600`. Used to encrypt API keys.",
        ],
      },
      {
        kind: "h3",
        text: "Install to PATH",
      },
      {
        kind: "code",
        label: "shell",
        code: "make install          # copies the binary to ~/.local/bin/vmdash\nvmdash",
      },
      {
        kind: "p",
        text: "`vmdash` has no runtime dependencies. Node is only used to build the UI once. Use `VMDASH_DATA_DIR` to put the database and master key on an encrypted volume.",
      },
      {
        kind: "h3",
        text: "Update & uninstall",
      },
      {
        kind: "code",
        label: "shell",
        code: "# update\ngit pull\nmake build\n# restart the vmdash process\n\n# uninstall\nrm -f ~/.local/bin/vmdash\nrm -rf \"$HOME/Library/Application Support/vmdash\"   # macOS\n# Linux: rm -rf \"$HOME/.local/share/vmdash\"",
      },
      {
        kind: "p",
        text: "Deleting the data directory deletes the master key. Stored API keys cannot be decrypted again; revoke them at InstaBox if you are done.",
      },
      {
        kind: "callout",
        tone: "warn",
        title: "Do not run the server on 0.0.0.0 without protection",
        text: "The dashboard can execute commands in your VMs. Keep the default 127.0.0.1 bind. If you need remote access, put it behind a private network or a tunnel with authentication, and treat the MCP token as a password.",
      },
    ],
  },
  {
    id: "connect",
    title: "Connect a workspace",
    summary: "Scopes, validation, and what happens after you paste a key.",
    blocks: [
      {
        kind: "list",
        ordered: true,
        items: [
          "Create a key at InstaBox → API keys (https://dashboard.instabox.sh/dashboard/api-keys).",
          "Use scopes: `machines:read`, `machines:write`, `machines:delete`, plus `images:read` and `images:write` for snapshots.",
          "For writing Org Secrets from a workspace key, add `workspace:admin`.",
          "Open Workspaces → Add workspace, paste the key, and give it a label.",
        ],
      },
      {
        kind: "p",
        text: "The server validates the key with `GET /v1/me`, stores it encrypted, then syncs `GET /v1/machines`, `GET /v1/usage`, and starts polling every 15 seconds. A key that reaches one workspace cannot see another workspace's machines.",
      },
      {
        kind: "table",
        head: ["Scope", "Allows"],
        rows: [
          ["`machines:read`", "List/get machines, operations, metrics, usage"],
          ["`machines:write`", "Create, start, stop, pause, resume, exec, files, SSH, ports"],
          ["`machines:delete`", "Delete machines"],
          ["`images:read` / `images:write`", "List, save, restore and delete snapshots"],
          ["`workspace:admin`", "Workspace management and Org Secret values (workspace key only)"],
        ],
      },
      {
        kind: "callout",
        tone: "warn",
        title: "A key with machines:write can run code",
        text: "Any key that can exec or write a file is effectively code execution inside every machine of that workspace. Give agents MCP tokens, not this key.",
      },
    ],
  },
  {
    id: "fleet",
    title: "Fleet & lifecycle",
    summary: "States, asynchronous operations, and what the buttons actually do.",
    blocks: [
      {
        kind: "p",
        text: "Every lifecycle action is an InstaBox **operation**. The API answers `202` with an operation ID; vmdash follows it with a long poll and refreshes the cache when it finishes. A machine runs one operation at a time.",
      },
      {
        kind: "table",
        head: ["Action", "API", "Notes"],
        rows: [
          ["Start", "`POST /start`", "Stopped → running. A paused machine resumes with its programs."],
          ["Pause", "`POST /suspend`", "Memory kept. Resume is near-instant; files always persist."],
          ["Resume", "`POST /resume`", "Paused → running, or boot fresh if restore fails."],
          ["Stop", "`POST /stop`", "Shuts down; running programs end. Cannot stop a paused machine directly."],
          ["Delete", "`DELETE`", "Requires the exact name or ID (`X-Confirm-Delete`). Snapshots survive."],
        ],
      },
      {
        kind: "p",
        text: "The star button creates a machine from a template (`agent-browser` by default), with size, idle pause, environment variables, and metadata. The free plan holds one machine and four templates.",
      },
      {
        kind: "callout",
        tone: "info",
        title: "Idle pause and max run are separate",
        text: "Idle pause activates after a period without work. Max run is a continuous runtime cap. Whichever is reached first pauses the machine; a max-run pause can start a cooldown.",
      },
    ],
  },
  {
    id: "terminal-files",
    title: "Terminal & files",
    summary: "PTY over WebSocket, and moving bytes in and out of a machine.",
    blocks: [
      {
        kind: "h3",
        text: "Terminal",
      },
      {
        kind: "p",
        text: "The Terminal tab opens a WebSocket to this server, which proxies to InstaBox. You get a persistent `xterm-256color` PTY as the machine's login user. Binary frames carry terminal bytes, text frames carry JSON controls such as `{\"type\":\"resize\",\"cols\":120,\"rows\":32}`. The session survives a disconnect; reconnect and recent output is replayed.",
      },
      {
        kind: "callout",
        tone: "info",
        title: "One viewer per session",
        text: "InstaBox allows one viewer per terminal session. Opening the same session elsewhere shows a `taken` control message. Use a different session name if you need parallel shells.",
      },
      {
        kind: "h3",
        text: "Files",
      },
      {
        kind: "list",
        items: [
          "Browse starts at `/data/home`, the machine user's home. Directories list at most 5,000 entries.",
          "Reading a text file returns at most 256 KiB; larger or binary files should be downloaded.",
          "Downloads stream the raw bytes with `Accept-Ranges`, so a cut transfer can resume.",
          "Uploads stream the request body to a temporary file and rename it on success. InstaBox allows up to 5 GiB.",
          "Delete runs `rm -rf -- <path>` through exec, so it works for files and directories.",
        ],
      },
      {
        kind: "p",
        text: "The files API needs a running machine. A machine paused for idleness is resumed automatically by InstaBox before the request.",
      },
    ],
  },
  {
    id: "desktop",
    title: "Desktop & VNC",
    summary: "Two ways to see a screen: an InstaBox link, or a VNC proxy that always works.",
    blocks: [
      {
        kind: "table",
        head: ["Mode", "How", "Use when"],
        rows: [
          ["Share link", "`POST /desktop/stream` → iframe URL", "The key is the machine creator's personal key"],
          ["VNC", "WebSocket proxy + noVNC in the drawer", "You use a workspace key, or want control inside the dashboard"],
        ],
      },
      {
        kind: "p",
        text: "Share links are short-lived (default 1 hour), can be view-only, and belong to the machine's creator. A workspace key gets `403 permission_denied` from that endpoint, which is expected. Use **Connect VNC** instead: the server opens `GET /v1/machines/{id}/vnc` with the API key and pipes the RFB stream to noVNC.",
      },
      {
        kind: "callout",
        tone: "warn",
        title: "View-only is enforced by InstaBox",
        text: "A view-only link cannot send keyboard, mouse, or clipboard input. VNC through this server is fully interactive. Treat a VNC viewer like physical access to the machine.",
      },
      {
        kind: "p",
        text: "If the desktop is not installed (for example on the `universal` or `t3` template), use **Install**, wait for the status to become installed, then **Start desktop**.",
      },
    ],
  },
  {
    id: "ports",
    title: "Public ports",
    summary: "Give an HTTP server inside a machine an HTTPS URL.",
    blocks: [
      {
        kind: "code",
        label: "inside the machine (via Terminal or exec)",
        code: "mkdir -p /data/home/site && cd /data/home/site\necho '<h1>hello from vmdash</h1>' > index.html\nnohup python3 -m http.server 8000 >server.log 2>&1 &",
      },
      {
        kind: "p",
        text: "Then Fleet → machine → Ports → publish port `8000`. InstaBox returns an HTTPS URL like `https://8000-<machine>.instabox.tech`. A public port is reachable by anyone with the URL; a private port requires the returned token URL or an `Authorization: Bearer` header.",
      },
      {
        kind: "list",
        items: [
          "Each machine supports up to 16 public ports.",
          "Private ports work by setting a cookie from the `?_token=...` URL. Share the token URL, not the bare URL.",
          "`protocol: tcp` exposes a TLS-wrapped TCP service (for example PostgreSQL) at `host:port` with SNI.",
          "Unpublishing closes active connections and rotates the publication ID.",
        ],
      },
    ],
  },
  {
    id: "snapshots",
    title: "Snapshots, fork, restore",
    summary: "Save disks, copy a machine fast, and roll back safely.",
    blocks: [
      {
        kind: "p",
        text: "A snapshot saves the system disk and `/data` (HOME included). Snapshots are owned by the org, survive machine deletion, and can be used to create new machines. `rootOnly` saves system files only, with empty storage.",
      },
      {
        kind: "table",
        head: ["Operation", "What it does", "Watch out"],
        rows: [
          ["Create snapshot", "Stopped: instant. Running: live copy, status starts `pending`", "Live copy is crash-consistent; unflushed data is not included"],
          ["Restore", "Puts root disk and `/data` back in place", "Everything since the snapshot is lost. SSH host key and running programs are replaced"],
          ["Fork", "Copies disks on the same host, cold boots a new machine", "Needs host capacity; no snapshot involved"],
        ],
      },
      {
        kind: "callout",
        tone: "bad",
        title: "Restore is destructive",
        text: "The machine keeps its ID, name, and public port URLs, but its disks are replaced. Take a fresh snapshot first if the current state matters.",
      },
      {
        kind: "p",
        text: "Snapshot endpoints need `images:read` / `images:write`. Fork is a normal create operation and needs `machines:write`.",
      },
    ],
  },
  {
    id: "resize",
    title: "Resize & metadata",
    summary: "vCPU, memory, disk, idle pause, max run, labels, and env vars.",
    blocks: [
      {
        kind: "list",
        items: [
          "vCPU, memory, and disk changes generally apply while the machine is stopped. If InstaBox refuses with `grow_needs_stop`, stop the machine and save again.",
          "A running machine's `/data` disk can grow live. Shrinking requires a stopped machine.",
          "The free plan is fixed at 4 vCPU / 8 GiB and a 20 GiB disk.",
          "Metadata is string key/value, at most 32 keys. It is replaced as a whole when you save.",
          "Environment variables are fixed at create time. The Settings tab shows their names; values are never returned.",
        ],
      },
      {
        kind: "p",
        text: "Saving settings only sends changed fields. Rename works in any state; resize and metadata changes are queued as operations.",
      },
    ],
  },
  {
    id: "secrets",
    title: "Org Secrets",
    summary: "Deliver credentials without putting the real value in the machine.",
    blocks: [
      {
        kind: "table",
        head: ["Delivery", "What lands in the machine", "Best for"],
        rows: [
          ["`proxy`", "An opaque placeholder for HTTPS headers", "API keys used by normal HTTPS clients"],
          ["`env`", "The real value as an environment variable/file", "Native clients such as databases"],
        ],
      },
      {
        kind: "p",
        text: "Values are write-only. InstaBox stores them and never returns them; vmdash only displays metadata. Creating, replacing, or deleting a value requires a workspace key with `workspace:admin`.",
      },
      {
        kind: "list",
        ordered: true,
        items: [
          "Open Workspaces → key icon → Secrets.",
          "Save a name, value, delivery mode, and optionally allowed hosts.",
          "Open a machine → Settings → Org Secrets and tick the Secrets it may use.",
          "Save selection. Use **Refresh delivery** after changing values in a running machine.",
        ],
      },
      {
        kind: "callout",
        tone: "warn",
        title: "Proxy is not a firewall",
        text: "Proxy delivery scopes where the credential can be injected, not all machine traffic. A process with `machines:write` can still select Secrets and run code. Keep scopes tight.",
      },
    ],
  },
  {
    id: "webhooks",
    title: "Webhooks",
    summary: "Register an HTTPS receiver, or let this dashboard receive events.",
    blocks: [
      {
        kind: "p",
        text: "InstaBox sends signed POSTs for `sandbox.created`, `started`, `stopped`, `suspended`, `error`, `deleted`, and snapshot events. The URL must be public HTTPS; deliveries never reach loopback.",
      },
      {
        kind: "h3",
        text: "Use the local receiver",
      },
      {
        kind: "code",
        label: "shell",
        code: "cloudflared tunnel --url http://127.0.0.1:8787\nexport VMDASH_PUBLIC_URL=https://<name>.trycloudflare.com\n./target/release/vmdash",
      },
      {
        kind: "p",
        text: "Then create the endpoint with `https://<name>.trycloudflare.com/webhooks/instabox/<workspaceId>`. The server verifies Standard Webhooks signatures with the endpoint secret it stored encrypted, writes the event to `webhook_events`, and adds an audit entry.",
      },
      {
        kind: "p",
        text: "The signing secret is shown once when you create or rotate an endpoint. Deliveries retry with backoff; an endpoint that keeps failing is disabled by InstaBox.",
      },
    ],
  },
  {
    id: "mcp",
    title: "MCP for agents",
    summary: "Connect Claude Code, Cursor, Codex, OpenCode, or stdio.",
    blocks: [
      {
        kind: "code",
        label: "Claude Code",
        code: 'claude mcp add --transport http vmdash http://127.0.0.1:8787/mcp \\\n  --header "Authorization: Bearer <MCP_TOKEN>"',
      },
      {
        kind: "code",
        label: "Cursor · ~/.cursor/mcp.json",
        code: '{\n  "mcpServers": {\n    "vmdash": {\n      "url": "http://127.0.0.1:8787/mcp",\n      "headers": { "Authorization": "Bearer <MCP_TOKEN>" }\n    }\n  }\n}',
      },
      {
        kind: "p",
        text: "The token is in the MCP tab. It is separate from InstaBox keys and authorizes only this local server. The server is sessionless: every JSON-RPC message is one POST, with no `Mcp-Session-Id` and no event stream.",
      },
      {
        kind: "table",
        head: ["Tool", "Purpose"],
        rows: [
          ["`list_workspaces`", "Connected keys, org, plan, machine count, spend"],
          ["`list_machines` / `get_machine`", "Fleet view and live machine detail"],
          ["`create_machine` / `machine_action` / `delete_machine`", "Lifecycle with confirmation for delete"],
          ["`exec`", "Run bash and return stdout, stderr, exit code"],
          ["`files`", "List, read (≤256 KiB text), write"],
          ["`ssh_token`", "Issue an SSH token and command"],
          ["`desktop`", "Status, install, start, or mint a share link"],
          ["`ports`", "List, publish, unpublish"],
          ["`snapshots` / `fork_machine`", "Save, delete, restore, copy"],
          ["`resize_machine`", "Rename, resize, idle pause, metadata"],
          ["`metrics` / `logs` / `history`", "Telemetry and command history"],
          ["`secrets` / `webhooks`", "Org Secrets and webhook endpoints"],
        ],
      },
      {
        kind: "callout",
        tone: "warn",
        title: "Agents in cloud VMs cannot reach 127.0.0.1",
        text: "Use stdio when the agent runs on your laptop. For agents inside InstaBox, expose /mcp with a tunnel and keep the token secret. Terminal and VNC are WebSockets and need the dashboard itself, not just MCP.",
      },
    ],
  },
  {
    id: "security",
    title: "Security model & key storage",
    summary: "Exactly where the InstaBox API key lives, and what that protects.",
    blocks: [
      {
        kind: "p",
        text: "API keys are encrypted **at rest** with a local master key. They are never stored in plaintext on disk, never sent to the browser, and never sent to MCP clients.",
      },
      {
        kind: "table",
        head: ["Item", "Location", "Protection"],
        rows: [
          ["InstaBox API key", "`workspaces.key_cipher` in `vmdash.db`", "ChaCha20-Poly1305, random 12-byte nonce prepended, base64; DB/WAL files `0600`"],
          ["Master key", "`master.key` next to the DB", "32 random bytes, file mode `0600`; data directory `0700`"],
          ["Key hint", "`workspaces.key_hint`", "Only the last 4 characters, for display"],
          ["Fingerprint", "`workspaces.key_fingerprint`", "SHA-256 prefix, used to detect duplicate pastes"],
          ["MCP token", "`settings` table (plaintext)", "Authorizes local MCP + terminal/VNC WebSockets only"],
          ["Audit log", "`audit` table", "Actions and details; never key material"],
        ],
      },
      {
        kind: "p",
        text: "The ciphertext layout is `base64(nonce || ciphertext)`, where the nonce is 12 bytes from the OS CSPRNG. The master key is created on first run with `0600` permissions. The data directory is `0700` and the server sets `umask 077`, so SQLite files (including WAL/SHM) are private too. Plaintext exists only in process memory while a request to InstaBox is being made.",
      },
      {
        kind: "callout",
        tone: "bad",
        title: "Disk access is the trust boundary",
        text: "The master key and the database live in the same directory by default, so anyone who can read both can decrypt the API keys. Use FileVault/BitLocker, a locked OS account, and keep the data directory out of backups you do not control. This is encryption at rest, not a hardware vault.",
      },
      {
        kind: "h3",
        text: "What an attacker still cannot do",
      },
      {
        kind: "list",
        items: [
          "A browser page cannot read the keys: they are never serialized to the UI, and cross-origin reads are blocked.",
          "An MCP client cannot read the keys: tools act on the agent's behalf and return results, not credentials.",
          "A DNS-rebinding page cannot reach the API: the server rejects non-localhost `Host` headers.",
          "A leaked MCP token does not create InstaBox keys; it only drives the workspaces already connected.",
        ],
      },
      {
        kind: "h3",
        text: "If a key leaks",
      },
      {
        kind: "list",
        ordered: true,
        items: [
          "Revoke the key in InstaBox → API keys. Revocation also ends SSH certificates issued by it.",
          "Remove the workspace in vmdash (Workspaces → trash). This deletes the ciphertext locally.",
          "Add a new key with the smallest scopes that work.",
          "Rotate the MCP token in the MCP tab if you suspect local access.",
        ],
      },
    ],
  },
  {
    id: "env",
    title: "Environment variables",
    summary: "Configuration for the server and the embedded UI.",
    blocks: [
      {
        kind: "table",
        head: ["Variable", "Default", "Purpose"],
        rows: [
          ["`VMDASH_BIND`", "`127.0.0.1`", "Bind address. Do not expose publicly without protection."],
          ["`VMDASH_PORT`", "`8787`", "Dashboard and MCP port."],
          ["`VMDASH_DATA_DIR`", "OS data dir", "SQLite + master key location."],
          ["`VMDASH_WEB_DIR`", "embedded", "Serve UI from a folder instead of the binary."],
          ["`VMDASH_SYNC_SECS`", "`15`", "Fleet polling interval."],
          ["`VMDASH_MCP_TOKEN`", "generated", "Override the MCP token."],
          ["`VMDASH_PUBLIC_URL`", "empty", "Public base URL for the webhook receiver and UI hints."],
          ["`VMDASH_ALLOW_ANY_HOST`", "`0`", "Allow non-localhost Host headers (tunnel dashboards)."],
          ["`INSTABOX_API_URL`", "`https://api.instabox.sh`", "Upstream API base, for testing."],
        ],
      },
      {
        kind: "code",
        label: "example",
        code: "VMDASH_DATA_DIR=\"$HOME/.vmdash\" VMDASH_PUBLIC_URL=\"https://box.example.com\" ./vmdash",
      },
    ],
  },
  {
    id: "limits",
    title: "Limits & scaling",
    summary: "The bottleneck is InstaBox, not the dashboard.",
    blocks: [
      {
        kind: "table",
        head: ["Limit", "Free", "Pro", "Builder"],
        rows: [
          ["Machines", "1", "500", "1,000"],
          ["Running at once", "1", "100", "200"],
          ["Starts / minute", "3", "30", "50"],
          ["Concurrent exec", "32", "64", "256"],
          ["Active API keys / workspace", "20", "20", "20"],
        ],
      },
      {
        kind: "p",
        text: "vmdash serializes syncs, queues one operation per machine, forwards idempotency keys, and passes through `retryAfterSeconds` on `no_capacity`, `rate_limited`, and cooldowns. Do not add parallel workers without respecting those limits.",
      },
      {
        kind: "p",
        text: "The UI stays cheap at scale: one `/api/fleet` request, live updates over SSE, and a cache in SQLite. Snapshots and telemetry are fetched only when their tab is open.",
      },
    ],
  },
  {
    id: "troubleshooting",
    title: "Troubleshooting",
    summary: "The errors you will actually see, and what to do.",
    blocks: [
      {
        kind: "table",
        head: ["Symptom", "Likely cause", "Fix"],
        rows: [
          ["`missing_scope`", "Key lacks a scope for that action", "Create a key with the needed scope; re-add the workspace"],
          ["`machine_not_running`", "Terminal, files, or desktop on a paused/stopped machine", "Start or resume it first"],
          ["`operation_conflict`", "Another operation is running on the machine", "Wait for it, then retry"],
          ["`no_capacity`", "No host has room right now", "Retry with backoff, or choose another size/template"],
          ["Desktop share link 403", "Workspace key cannot mint creator links", "Use Connect VNC"],
          ["Webhook never arrives", "URL is not public HTTPS, or receiver secret missing", "Use a tunnel and VMDASH_PUBLIC_URL; recreate the endpoint"],
          ["VNC connects then closes", "Desktop stopped or another viewer took control", "Start the desktop, or reconnect"],
          ["`invalid_key` / `revoked_key`", "Key was deleted or expired at InstaBox", "Revoke locally, add a new key"],
          ["Dashboard returns 403", "Host header is not localhost", "Open via 127.0.0.1/localhost, or set VMDASH_ALLOW_ANY_HOST=1"],
        ],
      },
      {
        kind: "p",
        text: "Every action is recorded in Activity with the InstaBox error message. The console log and recent operations in the Logs tab are the fastest way to debug a machine that will not boot.",
      },
    ],
  },
  {
    id: "opensource",
    title: "Open source",
    summary: "Layout, build, and how to contribute.",
    blocks: [
      {
        kind: "p",
        text: "vmdash is MIT licensed. The UI is embedded into the release binary; the server has no telemetry and stores everything locally.",
      },
      {
        kind: "list",
        items: [
          "`src/main.rs` — bootstrap, router, host guard, poller.",
          "`src/api.rs` — REST for the UI, SSE, operation tracking.",
          "`src/extras.rs` — files, SSH, desktop, ports, snapshots, metrics, secrets, webhooks, WebSocket proxy.",
          "`src/instabox.rs` — typed-ish InstaBox client and error mapping.",
          "`src/mcp.rs` — JSON-RPC MCP over HTTP and stdio.",
          "`web/src/views` — Fleet, Snapshots, Workspaces, Activity, MCP.",
          "`web/src/components/machine` — the drawer tabs.",
        ],
      },
      {
        kind: "code",
        label: "before opening a PR",
        code: "cd web && npm run build\ncargo test\ncargo build --release",
      },
      {
        kind: "p",
        text: "Good first issues: webhook delivery retry from the UI, snapshot pending auto-refresh, additional MCP tools for ports/files, and policy per agent (tool allowlists, budgets, approvals).",
      },
    ],
  },
];
