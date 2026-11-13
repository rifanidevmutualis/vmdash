import { useEffect, useMemo, useState } from "react";
import { errorMessage, machineHistory, machineLogs, machineMetrics } from "../../api";
import { ago, bytes, dateTime } from "../../format";
import { Icon } from "../../icons";
import type {
  ExecHistoryEntry,
  Machine,
  MachineLogs,
  MachineMetrics,
} from "../../types";

function Spark({
  values,
  max = 100,
  tone = "var(--accent)",
}: {
  values: number[];
  max?: number;
  tone?: string;
}) {
  const points = useMemo(() => {
    if (values.length === 0) return "";
    const width = 240;
    const height = 46;
    return values
      .map((value, index) => {
        const x = (index / Math.max(1, values.length - 1)) * width;
        const y = height - Math.min(1, Math.max(0, value / max)) * height;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  }, [values, max]);

  return (
    <svg className="spark" viewBox="0 0 240 46" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={points} fill="none" stroke={tone} strokeWidth="1.6" />
      <polyline
        points={`0,46 ${points} 240,46`}
        fill={tone}
        opacity="0.07"
        stroke="none"
      />
    </svg>
  );
}

export function TelemetryTab({ machine }: { machine: Machine }) {
  const [metrics, setMetrics] = useState<MachineMetrics | null>(null);
  const [logs, setLogs] = useState<MachineLogs | null>(null);
  const [history, setHistory] = useState<ExecHistoryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);

  async function load() {
    try {
      const [nextMetrics, nextLogs, nextHistory] = await Promise.all([
        machineMetrics(machine.workspaceId, machine.id).catch(() => null),
        machineLogs(machine.workspaceId, machine.id).catch(() => null),
        machineHistory(machine.workspaceId, machine.id, 12).catch(() => null),
      ]);
      if (nextMetrics) setMetrics(nextMetrics);
      if (nextLogs) setLogs(nextLogs);
      if (nextHistory) setHistory(nextHistory.commands);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machine.id]);

  useEffect(() => {
    if (!auto) return;
    const timer = window.setInterval(() => void load(), 12000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, machine.id]);

  const samples = metrics?.metrics ?? [];
  const latest = samples[samples.length - 1];
  const cpu = samples.map((sample) => sample.cpuUsedPct ?? 0);
  const memPct = samples.map((sample) =>
    sample.memTotal ? ((sample.memUsed ?? 0) / sample.memTotal) * 100 : 0,
  );
  const netIn = samples.map((sample) => sample.netInBytesPerSec ?? 0);
  const netOut = samples.map((sample) => sample.netOutBytesPerSec ?? 0);
  const netMax = Math.max(1024, ...netIn, ...netOut);

  return (
    <div className="telemetry">
      <div className="telemetry-head">
        <span className="hint">one sample per 30s · host view</span>
        <label className="check-row compact">
          <input type="checkbox" checked={auto} onChange={(event) => setAuto(event.target.checked)} />
          <span>Auto-refresh</span>
        </label>
        <button className="icon-btn" onClick={() => void load()} title="Refresh">
          <Icon name="refresh" />
        </button>
      </div>

      {error ? <div className="term-inline-error">{error}</div> : null}

      <div className="metric-grid">
        <div className="metric-card">
          <div className="metric-top">
            <span>CPU</span>
            <strong>{(latest?.cpuUsedPct ?? 0).toFixed(1)}%</strong>
          </div>
          <Spark values={cpu} />
          <div className="metric-foot">
            {latest?.cpuCount ?? machine.spec?.vcpus ?? "—"} vCPU · {samples.length} samples
          </div>
        </div>
        <div className="metric-card">
          <div className="metric-top">
            <span>Memory</span>
            <strong>
              {latest?.memTotal
                ? `${bytes(latest.memUsed)} / ${bytes(latest.memTotal)}`
                : "—"}
            </strong>
          </div>
          <Spark values={memPct} tone="var(--cyan)" />
          <div className="metric-foot">guest memory touched</div>
        </div>
        <div className="metric-card">
          <div className="metric-top">
            <span>Network</span>
            <strong>{bytes(latest?.netInBytesPerSec ?? 0)}/s in</strong>
          </div>
          <Spark values={netIn} max={netMax} tone="var(--violet)" />
          <div className="metric-foot">
            {bytes(latest?.netOutBytesPerSec ?? 0)}/s out · excludes SSH and public ports
          </div>
        </div>
      </div>

      {metrics?.disk?.filesystems?.length ? (
        <div className="disk-list">
          {metrics.disk.filesystems.map((filesystem) => (
            <div className={`disk-row level-${filesystem.level}`} key={filesystem.mount}>
              <span className="mono disk-mount">{filesystem.mount}</span>
              <div className="disk-bar">
                <span style={{ width: `${Math.min(100, filesystem.usedPct)}%` }} />
              </div>
              <span className="mono small">
                {bytes(filesystem.usedBytes)} / {bytes(filesystem.sizeBytes)} ({filesystem.usedPct.toFixed(0)}%)
              </span>
            </div>
          ))}
          {metrics.disk.warning ? (
            <div className="callout warn">
              <div className="callout-icon"><Icon name="alert" /></div>
              <div>
                <strong>{metrics.disk.warning.mount} is {metrics.disk.warning.level}</strong>
                <p>{metrics.disk.warning.message}</p>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <section className="telemetry-section">
        <div className="section-head">
          <h3>Console log</h3>
          {logs?.consoleTruncated ? <span className="chip subtle">truncated</span> : null}
          <span className="muted small" title={dateTime(logs?.operations?.[0]?.updatedAt)}>
            {logs?.state ?? machine.state}
          </span>
        </div>
        {logs?.consoleUnavailable ? (
          <div className="row-empty">{logs.consoleUnavailable}</div>
        ) : (
          <pre className="console-log">{logs?.console || "(no console output)"}</pre>
        )}
      </section>

      <section className="telemetry-section">
        <div className="section-head">
          <h3>Recent operations</h3>
        </div>
        {logs?.operations?.length ? (
          <div className="mini-op-list">
            {[...logs.operations].reverse().map((operation) => (
              <div className="mini-op" key={operation.id}>
                <span className={`op-state ${operation.state === "succeeded" ? "tone-ok" : operation.state === "failed" ? "tone-bad" : "tone-busy"}`}>
                  {operation.state}
                </span>
                <code>{operation.type ?? operation.kind}</code>
                <span className="muted small">{ago(operation.updatedAt)}</span>
                {operation.error ? <span className="op-error">{operation.error}</span> : null}
              </div>
            ))}
          </div>
        ) : (
          <div className="row-empty">No operations recorded.</div>
        )}
      </section>

      <section className="telemetry-section">
        <div className="section-head">
          <h3>Command history</h3>
          <span className="muted small">last {history.length}</span>
        </div>
        {history.length === 0 ? (
          <div className="row-empty">No exec commands yet.</div>
        ) : (
          <div className="history-list">
            {history.map((entry) => (
              <details className="history-row" key={entry.id}>
                <summary>
                  <span className={`exit ${entry.exitCode === 0 ? "ok" : "bad"}`}>
                    {entry.status === "exited" ? entry.exitCode : entry.status}
                  </span>
                  <code>{entry.command}</code>
                  <span className="muted small">{ago(entry.startedAt)}</span>
                </summary>
                {entry.stdout ? <pre className="console-log small">{entry.stdout}</pre> : null}
                {entry.stderr ? <pre className="console-log small stderr">{entry.stderr}</pre> : null}
              </details>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
