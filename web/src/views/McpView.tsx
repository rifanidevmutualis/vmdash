import { useState } from "react";
import { copyText } from "../format";
import { Icon } from "../icons";
import type { Settings } from "../types";

const TOOLS = [
  { name: "list_workspaces", desc: "Connected keys, org, plan, machine count, spend" },
  { name: "list_machines", desc: "Fleet view, filtered by workspace, state or name" },
  { name: "get_machine", desc: "Live machine detail, size, template, metadata" },
  { name: "create_machine", desc: "Create from a template and follow the operation" },
  { name: "machine_action", desc: "start · stop · suspend · resume" },
  { name: "delete_machine", desc: "Delete with an explicit name/ID confirmation" },
  { name: "bulk_action", desc: "Start/pause/resume/stop/delete up to 50 machines at once" },
  { name: "exec", desc: "Run bash in a machine, return stdout + exit code" },
  { name: "get_usage", desc: "Monthly cost and plan limits per workspace" },
  { name: "files", desc: "List, read (≤256 KiB text), write files" },
  { name: "ssh_token", desc: "Issue a short-lived SSH token and command" },
  { name: "desktop", desc: "Desktop status, install, start, share link" },
  { name: "ports", desc: "List, publish, unpublish public ports" },
  { name: "snapshots", desc: "Create, list, delete, restore snapshots" },
  { name: "fork_machine", desc: "Copy a machine's disks on the same host" },
  { name: "resize_machine", desc: "Rename, resize, idle pause, metadata" },
  { name: "metrics", desc: "CPU, memory, disk, network samples" },
  { name: "logs", desc: "Console log and recent operations" },
  { name: "history", desc: "Recent exec commands and stored output" },
  { name: "secrets", desc: "Org Secrets and per-machine selection" },
  { name: "webhooks", desc: "Webhook endpoints, test, rotate, deliveries" },
];

type Client = "claude" | "cursor" | "opencode" | "stdio";

function CodeBlock({
  code,
  language,
  onCopy,
}: {
  code: string;
  language?: string;
  onCopy: () => void;
}) {
  return (
    <div className="code-block">
      <div className="code-head">
        <span>{language ?? "shell"}</span>
        <button className="icon-btn tiny" onClick={onCopy} aria-label="Copy">
          <Icon name="copy" size={12} />
        </button>
      </div>
      <pre><code>{code}</code></pre>
    </div>
  );
}

export function McpView({
  settings,
  onRotate,
  notify,
}: {
  settings: Settings | null;
  onRotate: () => void;
  notify: (message: string, tone?: "ok" | "error" | "info") => void;
}) {
  const [client, setClient] = useState<Client>("claude");
  const [reveal, setReveal] = useState(false);

  if (!settings) {
    return (
      <div className="page">
        <div className="skeleton table" />
      </div>
    );
  }

  const { url, token, stdioCommand } = settings.mcp;
  const auth = `Bearer ${token}`;

  const snippets: Record<Client, { language: string; code: string }> = {
    claude: {
      language: "shell",
      code: `claude mcp add --transport http vmdash ${url} \\\n  --header "Authorization: ${auth}"`,
    },
    cursor: {
      language: "json · ~/.cursor/mcp.json",
      code: JSON.stringify(
        {
          mcpServers: {
            vmdash: {
              url,
              headers: { Authorization: auth },
            },
          },
        },
        null,
        2,
      ),
    },
    opencode: {
      language: "json · opencode.json",
      code: JSON.stringify(
        {
          mcp: {
            vmdash: {
              type: "remote",
              url,
              headers: { Authorization: auth },
            },
          },
        },
        null,
        2,
      ),
    },
    stdio: {
      language: "json · local process, no network",
      code: JSON.stringify(
        {
          mcp: {
            vmdash: {
              type: "local",
              command: ["/absolute/path/to/vmdash", "mcp-stdio"],
            },
          },
        },
        null,
        2,
      ),
    },
  };

  const snippet = snippets[client];

  async function copy(text: string, label: string) {
    const ok = await copyText(text);
    notify(ok ? `${label} copied` : "Could not copy", ok ? "ok" : "error");
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <div className="eyebrow">Agents</div>
          <h1>MCP</h1>
          <p>Let Claude Code, Cursor, Codex or OpenCode drive the whole fleet.</p>
        </div>
        <div className="head-actions">
          <button className="btn ghost" onClick={onRotate}>
            <Icon name="refresh" /> Rotate token
          </button>
        </div>
      </header>

      <div className="mcp-grid">
        <section className="panel endpoint-card">
          <div className="panel-head">
            <h2>Endpoint</h2>
            <span className="badge-live"><span className="status-dot tone-ok" /> listening</span>
          </div>
          <div className="copy-row">
            <span className="copy-label">URL</span>
            <code>{url}</code>
            <button className="icon-btn tiny" onClick={() => copy(url, "URL")} aria-label="Copy URL">
              <Icon name="copy" size={12} />
            </button>
          </div>
          <div className="copy-row">
            <span className="copy-label">Token</span>
            <code className={reveal ? "" : "masked"}>{reveal ? token : "•".repeat(32)}</code>
            <button className="link-btn" onClick={() => setReveal((value) => !value)}>
              {reveal ? "hide" : "reveal"}
            </button>
            <button className="icon-btn tiny" onClick={() => copy(token, "Token")} aria-label="Copy token">
              <Icon name="copy" size={12} />
            </button>
          </div>
          <p className="hint">
            Streamable HTTP, sessionless. Send <code>Authorization: Bearer …</code>,{" "}
            <code>X-MCP-Token</code>, or <code>?token=</code>. The server binds to{" "}
            <code>{url.replace("/mcp", "")}</code> only.
          </p>
        </section>

        <section className="panel safety-card">
          <div className="panel-head"><h2>Trust boundary</h2></div>
          <ul className="plain-list">
            <li><Icon name="check" size={13} /> MCP clients never see an InstaBox API key.</li>
            <li><Icon name="check" size={13} /> Every tool call is attributed in the audit log.</li>
            <li><Icon name="check" size={13} /> Deletes require the exact name or ID.</li>
            <li><Icon name="check" size={13} /> stdio mode keeps everything on this machine.</li>
          </ul>
          <div className="callout warn">
            <div className="callout-icon"><Icon name="alert" /></div>
            <div>
              <strong>Agents inside cloud VMs cannot reach localhost.</strong>
              <p>
                Use stdio when the agent runs on your laptop. For agents inside InstaBox, expose this
                server with a tunnel and keep the token secret.
              </p>
            </div>
          </div>
          <CodeBlock
            language="shell · tunnel"
            code={`cloudflared tunnel --url http://127.0.0.1:8787\n# MCP URL: https://<name>.trycloudflare.com/mcp?token=<token>`}
            onCopy={() => copy(`cloudflared tunnel --url http://127.0.0.1:8787`, "Tunnel command")}
          />
        </section>
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2>Connect a client</h2>
          <div className="segmented small">
            {(["claude", "cursor", "opencode", "stdio"] as Client[]).map((item) => (
              <button
                key={item}
                className={client === item ? "segment active" : "segment"}
                onClick={() => setClient(item)}
              >
                {item}
              </button>
            ))}
          </div>
        </div>
        <CodeBlock
          code={snippet.code}
          language={snippet.language}
          onCopy={() => copy(snippet.code, "Snippet")}
        />
        <p className="hint">
          stdio command: <code>{stdioCommand}</code>. Use an absolute path in client configs, and
          keep the process alive while the client runs.
        </p>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Tools</h2>
          <span className="muted small">{TOOLS.length} tools · one server for every workspace</span>
        </div>
        <div className="tool-grid">
          {TOOLS.map((tool) => (
            <div className="tool-card" key={tool.name}>
              <code>{tool.name}</code>
              <p>{tool.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="panel meta-panel">
        <div><span className="muted">Version</span> <code>v{settings.version}</code></div>
        <div><span className="muted">Sync interval</span> <code>{settings.syncSeconds}s</code></div>
        <div><span className="muted">Upstream</span> <code>{settings.apiBase}</code></div>
        <div><span className="muted">Data dir</span> <code>{settings.dataDir}</code></div>
      </section>
    </div>
  );
}
