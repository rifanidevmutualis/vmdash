import { useEffect, useState } from "react";
import {
  createWebhook,
  deleteSecret,
  deleteWebhook,
  errorMessage,
  listWebhooks,
  orgSecrets,
  putSecret,
  rotateWebhook,
  testWebhook,
  updateWebhook,
  webhookDeliveries,
} from "../api";
import { copyText, dateTime } from "../format";
import { Icon } from "../icons";
import type {
  SecretMeta,
  Settings,
  Webhook,
  WebhookDelivery,
  WebhookList,
  Workspace,
} from "../types";
import { Modal } from "./Modal";

export function WorkspaceToolsModal({
  workspace,
  settings,
  onClose,
  notify,
}: {
  workspace: Workspace;
  settings: Settings | null;
  onClose: () => void;
  notify: (message: string, tone?: "ok" | "error" | "info") => void;
}) {
  const [tab, setTab] = useState<"secrets" | "webhooks">("secrets");

  return (
    <Modal
      title={`${workspace.label} · workspace tools`}
      subtitle={`${workspace.orgName ?? workspace.orgId ?? "workspace"} · ${workspace.tier ?? "plan"}`}
      width={780}
      onClose={onClose}
    >
      <div className="tabs modal-tabs">
        <button className={tab === "secrets" ? "tab active" : "tab"} onClick={() => setTab("secrets")}>
          Secrets
        </button>
        <button className={tab === "webhooks" ? "tab active" : "tab"} onClick={() => setTab("webhooks")}>
          Webhooks
        </button>
      </div>
      {tab === "secrets" ? (
        <SecretsPanel workspace={workspace} notify={notify} />
      ) : (
        <WebhooksPanel workspace={workspace} settings={settings} notify={notify} />
      )}
    </Modal>
  );
}

function SecretsPanel({
  workspace,
  notify,
}: {
  workspace: Workspace;
  notify: (message: string, tone?: "ok" | "error" | "info") => void;
}) {
  const [items, setItems] = useState<SecretMeta[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [delivery, setDelivery] = useState<"proxy" | "env">("proxy");
  const [hosts, setHosts] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const result = await orgSecrets(workspace.id);
      setItems(result.items ?? []);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || !value) return;
    setBusy(true);
    try {
      await putSecret(workspace.id, name.trim(), {
        value,
        delivery,
        hosts: hosts
          .split(",")
          .map((host) => host.trim())
          .filter(Boolean),
      });
      notify(`Secret ${name.trim()} saved`, "ok");
      setName("");
      setValue("");
      setHosts("");
      void load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(secret: SecretMeta) {
    if (!window.confirm(`Delete Secret ${secret.name}? Machines using it lose delivery.`)) return;
    try {
      await deleteSecret(workspace.id, secret.name);
      notify("Secret deleted", "ok");
      void load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="workspace-tools">
      <div className="callout info">
        <div className="callout-icon"><Icon name="lock" /></div>
        <div>
          <strong>Values are write-only.</strong>
          <p>
            InstaBox never returns a Secret value. <code>proxy</code> injects a placeholder at the
            HTTPS proxy; <code>env</code> puts the real value in the machine. Writing values needs a
            key with <code>workspace:admin</code>.
          </p>
        </div>
      </div>

      <form className="secret-form" onSubmit={submit}>
        <div className="form-row">
          <label className="field">
            <span className="field-label">Name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="OPENAI_API_KEY"
              spellCheck={false}
            />
          </label>
          <label className="field">
            <span className="field-label">Delivery</span>
            <select value={delivery} onChange={(event) => setDelivery(event.target.value as "proxy" | "env")}>
              <option value="proxy">proxy (placeholder)</option>
              <option value="env">env (real value)</option>
            </select>
          </label>
        </div>
        <label className="field">
          <span className="field-label">Value</span>
          <input
            type="password"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="sk-… (never stored by the dashboard)"
            autoComplete="off"
          />
        </label>
        {delivery === "proxy" ? (
          <label className="field">
            <span className="field-label">Allowed hosts <span className="muted">(comma separated, blank = all)</span></span>
            <input
              value={hosts}
              onChange={(event) => setHosts(event.target.value)}
              placeholder="api.openai.com, api.anthropic.com"
              spellCheck={false}
            />
          </label>
        ) : null}
        <div className="settings-actions">
          <button className="btn primary" type="submit" disabled={busy || !name.trim() || !value}>
            {busy ? <span className="spinner" /> : <Icon name="upload" />} Save / replace
          </button>
        </div>
      </form>

      {error ? <div className="term-inline-error">{error}</div> : null}

      {loading && items.length === 0 ? <div className="row-empty">Loading secrets…</div> : null}
      {!loading && items.length === 0 ? (
        <div className="row-empty">No org Secrets yet.</div>
      ) : (
        <div className="secret-table">
          {items.map((secret) => (
            <div className="secret-row" key={secret.id}>
              <code>{secret.name}</code>
              <span className="chip subtle">{secret.delivery}</span>
              <span className="muted small secret-hosts">
                {secret.hosts?.length ? secret.hosts.join(", ") : "all hosts"}
              </span>
              <span className="mono muted small">v{secret.version}</span>
              <span className="muted small">{dateTime(secret.updatedAt)}</span>
              <button
                className="icon-btn danger-hover"
                onClick={() => void remove(secret)}
                title="Delete"
              >
                <Icon name="trash" size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const COMMON_EVENTS = [
  "sandbox.created",
  "sandbox.started",
  "sandbox.stopped",
  "sandbox.suspended",
  "sandbox.error",
  "sandbox.deleted",
  "snapshot.created",
  "snapshot.failed",
  "snapshot.deleted",
];

function WebhooksPanel({
  workspace,
  settings,
  notify,
}: {
  workspace: Workspace;
  settings: Settings | null;
  notify: (message: string, tone?: "ok" | "error" | "info") => void;
}) {
  const [list, setList] = useState<WebhookList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState(
    settings?.publicUrl ? `${settings.publicUrl}/webhooks/instabox/${workspace.id}` : "",
  );
  const [description, setDescription] = useState("");
  const [events, setEvents] = useState<string[]>([]);
  const [createdSecret, setCreatedSecret] = useState<{ id: string; secret: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [deliveriesFor, setDeliveriesFor] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);

  async function load() {
    try {
      const result = await listWebhooks(workspace.id);
      setList(result);
      setEvents((current) => (current.length ? current : result.eventTypes ?? COMMON_EVENTS));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!url.trim() || events.length === 0) return;
    setBusy(true);
    try {
      const result = await createWebhook(workspace.id, {
        url: url.trim(),
        events,
        description: description.trim() || undefined,
      });
      if (result.secret) setCreatedSecret({ id: result.id, secret: result.secret });
      notify("Webhook endpoint created", "ok");
      setDescription("");
      void load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function rotate(webhook: Webhook) {
    try {
      const result = await rotateWebhook(workspace.id, webhook.id);
      if (result.secret) setCreatedSecret({ id: result.id, secret: result.secret });
      notify("Signing secret rotated. Copy it now.", "ok");
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function toggle(webhook: Webhook) {
    try {
      await updateWebhook(workspace.id, webhook.id, { enabled: !webhook.enabled });
      void load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function test(webhook: Webhook) {
    try {
      await testWebhook(workspace.id, webhook.id);
      notify("Test event queued", "ok");
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function remove(webhook: Webhook) {
    if (!window.confirm(`Delete webhook ${webhook.url}?`)) return;
    try {
      await deleteWebhook(workspace.id, webhook.id);
      notify("Webhook deleted", "ok");
      void load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function showDeliveries(webhook: Webhook) {
    if (deliveriesFor === webhook.id) {
      setDeliveriesFor(null);
      return;
    }
    try {
      const result = await webhookDeliveries(workspace.id, webhook.id);
      setDeliveries(result.items ?? []);
      setDeliveriesFor(webhook.id);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="workspace-tools">
      <div className="callout info">
        <div className="callout-icon"><Icon name="webhook" /></div>
        <div>
          <strong>Events need a public HTTPS receiver.</strong>
          <p>
            {settings?.publicUrl
              ? `This dashboard can receive at ${settings.publicUrl}/webhooks/instabox/${workspace.id}. The URL above is prefilled.`
              : "Set VMDASH_PUBLIC_URL (or run a tunnel) if you want this dashboard to receive events. Otherwise point the webhook at your own HTTPS endpoint."}
          </p>
        </div>
      </div>

      {createdSecret ? (
        <div className="callout warn">
          <div className="callout-icon"><Icon name="key" /></div>
          <div>
            <strong>Signing secret (shown once)</strong>
            <p className="secret-secret">{createdSecret.secret}</p>
            <button
              className="btn ghost"
              onClick={async () => {
                const ok = await copyText(createdSecret.secret);
                notify(ok ? "Secret copied" : "Could not copy", ok ? "ok" : "error");
              }}
            >
              <Icon name="copy" /> Copy secret
            </button>
          </div>
        </div>
      ) : null}

      <form className="webhook-form" onSubmit={create}>
        <label className="field">
          <span className="field-label">Endpoint URL (https)</span>
          <input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://example.com/hook"
            spellCheck={false}
          />
        </label>
        <label className="field">
          <span className="field-label">Description <span className="muted">(optional)</span></span>
          <input value={description} onChange={(event) => setDescription(event.target.value)} />
        </label>
        <div className="event-grid">
          {(list?.eventTypes ?? COMMON_EVENTS).map((event) => (
            <label className="check-row compact" key={event}>
              <input
                type="checkbox"
                checked={events.includes(event)}
                onChange={(event_) => {
                  setEvents((current) =>
                    event_.target.checked
                      ? [...new Set([...current, event])]
                      : current.filter((item) => item !== event),
                  );
                }}
              />
              <code className="small">{event}</code>
            </label>
          ))}
        </div>
        <div className="settings-actions">
          <button className="btn primary" type="submit" disabled={busy || !url.trim()}>
            {busy ? <span className="spinner" /> : <Icon name="plus" />} Create webhook
          </button>
        </div>
      </form>

      {error ? <div className="term-inline-error">{error}</div> : null}

      {list?.items?.length ? (
        <div className="webhook-list">
          {list.items.map((webhook) => (
            <div className="webhook-row" key={webhook.id}>
              <div className="webhook-main">
                <span className={`status-dot tone-${webhook.enabled ? "ok" : "idle"}`} />
                <div>
                  <code className="webhook-url">{webhook.url}</code>
                  <div className="webhook-events">
                    {webhook.events.map((event) => (
                      <span className="chip subtle" key={event}>{event.replace("sandbox.", "")}</span>
                    ))}
                  </div>
                </div>
              </div>
              <div className="row-actions">
                <button className="icon-btn" title="Send test" onClick={() => void test(webhook)}>
                  <Icon name="activity" />
                </button>
                <button className="icon-btn" title="Toggle" onClick={() => void toggle(webhook)}>
                  <Icon name={webhook.enabled ? "pause" : "play"} />
                </button>
                <button className="icon-btn" title="Rotate secret" onClick={() => void rotate(webhook)}>
                  <Icon name="key" />
                </button>
                <button
                  className="icon-btn"
                  title="Deliveries"
                  onClick={() => void showDeliveries(webhook)}
                >
                  <Icon name="list" />
                </button>
                <button
                  className="icon-btn danger-hover"
                  title="Delete"
                  onClick={() => void remove(webhook)}
                >
                  <Icon name="trash" />
                </button>
              </div>
              {deliveriesFor === webhook.id ? (
                <div className="delivery-list">
                  {deliveries.length === 0 ? (
                    <span className="muted small">No deliveries yet.</span>
                  ) : (
                    deliveries.map((delivery) => (
                      <div className="delivery-row" key={delivery.id}>
                        <span className={`exit ${delivery.state === "succeeded" ? "ok" : "bad"}`}>
                          {delivery.state}
                        </span>
                        <code>{delivery.eventType}</code>
                        <span className="muted small">{delivery.attempts} attempts</span>
                        <span className="muted small">{dateTime(delivery.createdAt)}</span>
                        {delivery.lastError ? <span className="op-error">{delivery.lastError}</span> : null}
                      </div>
                    ))
                  )}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <div className="row-empty">No webhook endpoints.</div>
      )}
    </div>
  );
}
