import { useEffect, useRef, useState } from "react";
import {
  deleteFile,
  downloadFileUrl,
  errorMessage,
  listFiles,
  writeFile,
} from "../../api";
import { ago, bytes, copyText } from "../../format";
import { Icon } from "../../icons";
import type { FilesResponse, Machine } from "../../types";

const HOME = "/data/home";

export function FilesTab({
  machine,
  notify,
}: {
  machine: Machine;
  notify: (message: string, tone?: "ok" | "error" | "info") => void;
}) {
  const [path, setPath] = useState(HOME);
  const [files, setFiles] = useState<FilesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ path: string; body: string; binary: boolean } | null>(
    null,
  );
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);

  const running = machine.state === "running";

  async function load(target = path) {
    if (!running) return;
    setLoading(true);
    setError(null);
    try {
      const data = await listFiles(machine.workspaceId, machine.id, target);
      setPath(target);
      setFiles(data);
      if (data.type === "file") {
        setEditor({
          path: target,
          body: data.content ?? "",
          binary: Boolean(data.binary),
        });
        setDirty(false);
      } else {
        setEditor(null);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (running) void load(HOME);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machine.id, running]);

  async function save() {
    if (!editor || editor.binary) return;
    setSaving(true);
    try {
      await writeFile(machine.workspaceId, machine.id, editor.path, editor.body, {
        parents: true,
      });
      setDirty(false);
      notify("File saved", "ok");
      void load(path);
    } catch (err) {
      notify(errorMessage(err), "error");
    } finally {
      setSaving(false);
    }
  }

  async function upload(file: File) {
    const destination =
      files?.type === "dir" ? `${path.replace(/\/$/, "")}/${file.name}` : path;
    try {
      await writeFile(machine.workspaceId, machine.id, destination, file, {
        parents: true,
      });
      notify(`Uploaded ${file.name}`, "ok");
      void load(path);
    } catch (err) {
      notify(errorMessage(err), "error");
    }
  }

  async function remove(entryPath: string, name: string) {
    if (!window.confirm(`Delete ${name}? This runs rm -rf inside the machine.`)) return;
    try {
      await deleteFile(machine.workspaceId, machine.id, entryPath);
      notify(`Deleted ${name}`, "ok");
      void load(path);
    } catch (err) {
      notify(errorMessage(err), "error");
    }
  }

  async function newFile() {
    const name = window.prompt("New file name");
    if (!name) return;
    const destination = `${path.replace(/\/$/, "")}/${name}`;
    try {
      await writeFile(machine.workspaceId, machine.id, destination, "", { parents: true });
      notify("File created", "ok");
      void load(destination);
    } catch (err) {
      notify(errorMessage(err), "error");
    }
  }

  if (!running) {
    return (
      <div className="callout warn">
        <div className="callout-icon"><Icon name="alert" /></div>
        <div>
          <strong>Machine is {machine.state}</strong>
          <p>Files need a running machine. Start or resume it first.</p>
        </div>
      </div>
    );
  }

  const segments = path.split("/").filter(Boolean);

  return (
    <div className="files-panel">
      <div className="file-toolbar">
        <button className="icon-btn" title="Parent directory" onClick={() => load(parentOf(path))}>
          <Icon name="arrow-left" />
        </button>
        <nav className="breadcrumbs">
          <button onClick={() => load("/")}>root</button>
          {segments.map((segment, index) => {
            const target = "/" + segments.slice(0, index + 1).join("/");
            return (
              <span key={target}>
                <span className="crumb-sep">/</span>
                <button onClick={() => load(target)}>{segment}</button>
              </span>
            );
          })}
        </nav>
        <div className="file-actions">
          <button className="icon-btn" title="Refresh" onClick={() => load(path)}>
            <Icon name="refresh" className={loading ? "spin" : undefined} />
          </button>
          <button className="icon-btn" title="New file" onClick={() => void newFile()}>
            <Icon name="file-plus" />
          </button>
          <button
            className="icon-btn"
            title="Upload"
            onClick={() => uploadRef.current?.click()}
          >
            <Icon name="upload" />
          </button>
          <input
            ref={uploadRef}
            type="file"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
              event.target.value = "";
            }}
          />
        </div>
      </div>

      {error ? <div className="term-inline-error">{error}</div> : null}

      {editor ? (
        <div className="file-editor">
          <div className="file-editor-head">
            <div>
              <code>{editor.path}</code>
              {files?.truncated ? <span className="chip subtle">truncated</span> : null}
              {editor.binary ? <span className="chip subtle">binary</span> : null}
            </div>
            <div className="row-actions">
              <a
                className="icon-btn"
                href={downloadFileUrl(machine.workspaceId, machine.id, editor.path)}
                title="Download"
              >
                <Icon name="download" />
              </a>
              <button
                className="icon-btn"
                title="Copy path"
                onClick={async () => {
                  const ok = await copyText(editor.path);
                  notify(ok ? "Path copied" : "Could not copy", ok ? "ok" : "error");
                }}
              >
                <Icon name="copy" />
              </button>
              <button className="btn ghost" onClick={() => load(parentOf(editor.path))}>
                Back to folder
              </button>
              <button
                className="btn primary"
                disabled={editor.binary || !dirty || saving}
                onClick={() => void save()}
              >
                {saving ? <span className="spinner" /> : <Icon name="save" />}
                Save
              </button>
            </div>
          </div>
          {editor.binary ? (
            <div className="row-empty">
              Binary file ({bytes(files?.size)}). Use download to inspect it locally.
            </div>
          ) : (
            <textarea
              className="file-textarea"
              value={editor.body}
              spellCheck={false}
              onChange={(event) => {
                setEditor({ ...editor, body: event.target.value });
                setDirty(true);
              }}
            />
          )}
        </div>
      ) : (
        <div className="file-list">
          {files?.entries?.length === 0 ? (
            <div className="row-empty">Empty directory.</div>
          ) : null}
          {files?.entries?.map((entry) => {
            const entryPath = `${path.replace(/\/$/, "")}/${entry.name}`;
            const isDir = entry.type === "dir";
            return (
              <div className="file-row" key={entryPath}>
                <span className={`file-icon ${isDir ? "dir" : ""}`}>
                  <Icon name={isDir ? "folder" : "file"} />
                </span>
                <button
                  className="file-name"
                  onClick={() => load(entryPath)}
                  title={entry.target ? `→ ${entry.target}` : entryPath}
                >
                  {entry.name}
                  {entry.type === "symlink" ? <span className="symlink-mark">↗</span> : null}
                </button>
                <span className="file-size mono">{isDir ? "—" : bytes(entry.size)}</span>
                <span className="file-mode mono">{entry.mode}</span>
                <span className="file-time mono" title={entry.modTime}>{ago(entry.modTime)}</span>
                <span className="row-actions">
                  {!isDir ? (
                    <a
                      className="icon-btn"
                      href={downloadFileUrl(machine.workspaceId, machine.id, entryPath)}
                      title="Download"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <Icon name="download" />
                    </a>
                  ) : null}
                  <button
                    className="icon-btn danger-hover"
                    title="Delete"
                    onClick={() => void remove(entryPath, entry.name)}
                  >
                    <Icon name="trash" />
                  </button>
                </span>
              </div>
            );
          })}
          {!files && loading ? (
            <div className="row-empty">Loading {path}…</div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function parentOf(path: string): string {
  if (path === "/" || !path) return "/";
  const trimmed = path.replace(/\/$/, "");
  const index = trimmed.lastIndexOf("/");
  return index <= 0 ? "/" : trimmed.slice(0, index);
}
