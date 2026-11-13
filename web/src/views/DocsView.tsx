import { useMemo, useState } from "react";
import { DOCS, type DocBlock, type DocSection } from "../content/docs";
import { copyText } from "../format";
import { Icon } from "../icons";
import type { Settings } from "../types";

function Rich({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).filter(Boolean);
  return (
    <>
      {parts.map((part, index) => {
        if (part.startsWith("`") && part.endsWith("`")) {
          return <code key={index}>{part.slice(1, -1)}</code>;
        }
        if (part.startsWith("**") && part.endsWith("**")) {
          return <strong key={index}>{part.slice(2, -2)}</strong>;
        }
        return <span key={index}>{part}</span>;
      })}
    </>
  );
}

function DocCode({ block }: { block: Extract<DocBlock, { kind: "code" }> }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="docs-code">
      <div className="docs-code-head">
        <span>{block.label}</span>
        <button
          className="icon-btn tiny"
          onClick={async () => {
            const ok = await copyText(block.code);
            if (ok) {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            }
          }}
          aria-label="Copy code"
        >
          <Icon name={copied ? "check" : "copy"} size={12} />
        </button>
      </div>
      <pre>
        <code>{block.code}</code>
      </pre>
    </div>
  );
}

function BlockView({ block }: { block: DocBlock }) {
  switch (block.kind) {
    case "h3":
      return <h3 className="docs-h3">{block.text}</h3>;
    case "p":
      return (
        <p className="docs-p">
          <Rich text={block.text} />
        </p>
      );
    case "list":
      return block.ordered ? (
        <ol className="docs-list ordered">
          {block.items.map((item, index) => (
            <li key={index}>
              <Rich text={item} />
            </li>
          ))}
        </ol>
      ) : (
        <ul className="docs-list">
          {block.items.map((item, index) => (
            <li key={index}>
              <Rich text={item} />
            </li>
          ))}
        </ul>
      );
    case "code":
      return <DocCode block={block} />;
    case "table":
      return (
        <div className="docs-table-wrap">
          <table className="docs-table">
            <thead>
              <tr>
                {block.head.map((cell) => (
                  <th key={cell}>
                    <Rich text={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, index) => (
                <tr key={index}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex}>
                      <Rich text={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "callout":
      return (
        <div className={`callout ${block.tone}`}>
          <div className="callout-icon">
            <Icon name={block.tone === "info" ? "info" : "alert"} />
          </div>
          <div>
            <strong>{block.title}</strong>
            <p>
              <Rich text={block.text} />
            </p>
          </div>
        </div>
      );
    case "kv":
      return (
        <dl className="docs-kv">
          {block.items.map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>
                <Rich text={value} />
              </dd>
            </div>
          ))}
        </dl>
      );
  }
}

function sectionText(section: DocSection): string {
  const parts: string[] = [section.title, section.summary];
  for (const block of section.blocks) {
    switch (block.kind) {
      case "p":
      case "h3":
        parts.push(block.text);
        break;
      case "list":
        parts.push(block.items.join(" "));
        break;
      case "code":
        parts.push(block.code, block.label);
        break;
      case "table":
        parts.push(block.head.join(" "), block.rows.flat().join(" "));
        break;
      case "callout":
        parts.push(block.title, block.text);
        break;
      case "kv":
        parts.push(block.items.flat().join(" "));
        break;
    }
  }
  return parts.join(" ").toLowerCase();
}

export function DocsView({ settings }: { settings: Settings | null }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<string>("start");

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return DOCS;
    return DOCS.filter((section) => sectionText(section).includes(needle));
  }, [query]);

  function jump(id: string) {
    setActive(id);
    const element = document.getElementById(`doc-${id}`);
    element?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <div className="page docs-page">
      <header className="page-head">
        <div>
          <div className="eyebrow">Resources</div>
          <h1>Docs</h1>
          <p>Setup, daily use, MCP, security, and the API key model — all offline.</p>
        </div>
        <div className="head-actions">
          <div className="docs-search">
            <Icon name="search" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search docs"
              spellCheck={false}
            />
            {query ? (
              <button className="icon-btn tiny" onClick={() => setQuery("")} aria-label="Clear">
                <Icon name="x" size={12} />
              </button>
            ) : null}
          </div>
        </div>
      </header>

      <div className="docs-layout">
        <aside className="docs-toc">
          <div className="docs-toc-label">Contents</div>
          <nav>
            {filtered.map((section) => (
              <button
                key={section.id}
                className={active === section.id ? "docs-toc-item active" : "docs-toc-item"}
                onClick={() => jump(section.id)}
              >
                {section.title}
              </button>
            ))}
            {filtered.length === 0 ? (
              <div className="docs-toc-empty">No section matches “{query}”.</div>
            ) : null}
          </nav>

          <div className="docs-instance">
            <div className="docs-instance-title">This instance</div>
            <div className="docs-instance-row">
              <span>Data</span>
              <code title={settings?.dataDir}>{settings?.dataDir ?? "—"}</code>
            </div>
            <div className="docs-instance-row">
              <span>MCP</span>
              <code>{settings?.mcp.url ?? "—"}</code>
            </div>
            <div className="docs-instance-row">
              <span>Version</span>
              <code>v{settings?.version ?? "0.1.0"}</code>
            </div>
          </div>
        </aside>

        <article className="docs-article">
          {filtered.map((section) => (
            <section className="docs-section" id={`doc-${section.id}`} key={section.id}>
              <h2>{section.title}</h2>
              <p className="docs-summary">{section.summary}</p>
              <div className="docs-body">
                {section.blocks.map((block, index) => (
                  <BlockView block={block} key={index} />
                ))}
              </div>
            </section>
          ))}

          {filtered.length === 0 ? (
            <div className="table-empty card">
              <div className="empty-icon"><Icon name="book" size={22} /></div>
              <h3>Nothing found</h3>
              <p>Try “key”, “mcp”, “vnc”, “secret”, or “webhook”.</p>
              <button className="btn" onClick={() => setQuery("")}>
                Clear search
              </button>
            </div>
          ) : null}

          <footer className="docs-foot">
            <span>
              vmdash · MIT licensed · no telemetry
            </span>
            <span className="muted">Everything runs on this machine.</span>
          </footer>
        </article>
      </div>
    </div>
  );
}
