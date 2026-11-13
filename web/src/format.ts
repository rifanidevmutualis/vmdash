export function ago(iso?: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const diff = Math.max(0, Date.now() - then);
  const sec = Math.floor(diff / 1000);
  if (sec < 10) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return dateOnly(iso);
}

export function dateOnly(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function dateTime(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function money(n?: number | null): string {
  const value = typeof n === "number" && Number.isFinite(n) ? n : 0;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value > 0 && value < 10 ? 4 : 2,
  }).format(value);
}

export function stateLabel(state: string): string {
  switch (state) {
    case "running":
      return "running";
    case "suspended":
      return "paused";
    case "stopped":
      return "stopped";
    case "creating":
      return "creating";
    case "starting":
      return "starting";
    case "stopping":
      return "stopping";
    case "suspending":
      return "pausing";
    case "resuming":
      return "resuming";
    case "deleting":
      return "deleting";
    case "error":
      return "error";
    default:
      return state || "unknown";
  }
}

export function isBusy(state: string): boolean {
  return ["creating", "starting", "stopping", "suspending", "resuming", "deleting"].includes(state);
}

export function sizeLabel(machine: {
  spec?: { vcpus: number; memMiB: number; persistentDiskGiB: number };
}): string {
  const spec = machine.spec;
  if (!spec) return "—";
  const mem = spec.memMiB >= 1024 ? `${Math.round(spec.memMiB / 1024)} GiB` : `${spec.memMiB} MiB`;
  return `${spec.vcpus} vCPU · ${mem}`;
}

export function diskLabel(machine: {
  spec?: { persistentDiskGiB: number };
}): string {
  return machine.spec ? `${machine.spec.persistentDiskGiB} GiB` : "—";
}

export function idleLabel(seconds?: number | null): string {
  if (seconds === null || seconds === undefined) return "never";
  if (seconds === 0) return "never";
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${Math.round(seconds / 60)}m`;
}

export function templateLabel(machine: { template?: { id: string; version?: string } }): string {
  return machine.template?.id ?? "—";
}

export function shortId(id?: string | null): string {
  if (!id) return "—";
  if (id.length <= 16) return id;
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

export function bytes(n?: number | null): string {
  if (!n || n <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const el = document.createElement("textarea");
      el.value = text;
      el.style.position = "fixed";
      el.style.opacity = "0";
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      document.body.removeChild(el);
      return true;
    } catch {
      return false;
    }
  }
}
