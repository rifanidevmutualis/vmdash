# vmdash

Control plane lokal untuk banyak VM **InstaBox** yang dipakai AI agent. Satu dashboard kecil,
satu binary Rust, satu MCP server.

```
Browser (React)  ⇄  axum :8787  ──┬── REST client pool → api.instabox.sh
                                  ├── SQLite (cache, operations, audit)
                                  ├── ChaCha20-Poly1305 (API keys at rest)
                                  └── MCP /mcp (Streamable HTTP) + stdio
```

## Yang bisa dilakukan

- **Fleet view**: semua VM lintas workspace, status live, ukuran, template, idle pause, umur,
  start/pause/resume/stop/delete.
- **Terminal**: PTY interaktif lewat WebSocket, persistent session, xterm-256color.
- **Files**: browse, baca, edit, upload, download, dan hapus file di dalam VM.
- **Desktop**: link viewer InstaBox (iframe) dan VNC langsung lewat server ini (noVNC).
- **Ports**: publish/unpublish HTTPS atau TCP, private token URL, buka di tab baru.
- **Snapshots**: buat, list, hapus, restore, dan fork machine.
- **Resize & config**: rename, vCPU/RAM/disk, idle pause, max run, metadata.
- **SSH**: issue token 1 jam, tampilkan perintah `ssh`, revoke satu atau semua.
- **Telemetry**: CPU, memory, network, disk, console log, operation history, exec history.
- **Org Secrets**: list metadata, tulis/replace value, hapus; pilih Secret per machine.
- **Webhooks**: daftar, buat, update, hapus, rotate secret, test, delivery log; receiver lokal di
  `/webhooks/instabox/<workspaceId>` saat `VMDASH_PUBLIC_URL` diisi.
- **Dark + light mode**, mengikuti preferensi sistem dan bisa di-toggle dari sidebar.

Semua aksi tercatat di **Activity** (audit lokal), dan response API InstaBox yang error
(`missing_scope`, `operation_conflict`, `no_capacity`, …) diteruskan apa adanya ke UI.

## Kenapa model datanya begini

API key InstaBox itu **per workspace, bukan per VM**. Satu key melihat semua machine di workspace
itu, dan satu workspace maksimal punya 20 key aktif. Jadi dashboard ini menyimpan key per
workspace, lalu mem-fan-out ke seluruh fleet dari situ.

Yang perlu diingat saat mau scale:

| Batas InstaBox | Free | Pro |
|---|---|---|
| Machine | 1 | 500 |
| Running bersamaan | 1 | 100 |
| Start / menit | 3 | 30 |
| `exec` bersamaan | 32 | 64 |
| API key aktif | 20 | 20 |

Karena itu backend punya sync lock, satu operasi per machine, dan meneruskan `retryAfterSeconds`
dari `no_capacity` / `rate_limited` apa adanya. Jangan menambah worker paralel tanpa menghormati
batas ini.

## Install

### Yang dibutuhkan

- **Rust** stable (1.80+, dites di 1.100)
- **Node.js 20+** dan npm — hanya untuk build UI
- `make` (opsional, tapi disarankan)
- macOS 13+ atau Linux. Windows belum dites; gunakan WSL2.
- Tidak butuh Docker, database eksternal, atau akun cloud selain InstaBox.

### Build dari source

```bash
git clone https://github.com/rifanidevmutualis/vmdash.git
cd vmdash

# build UI + release binary (UI di-embed ke binary)
make build

./target/release/vmdash
```

Kalau tidak memakai `make`:

```bash
cd web && npm install && npm run build && cd ..
cargo build --release
./target/release/vmdash
```

Binary hasil build ada di `target/release/vmdash` (±10 MB) dan sudah membawa UI di dalamnya.
Node hanya diperlukan saat build, bukan saat menjalankan.

### Install ke PATH

```bash
make install          # menyalin ke ~/.local/bin/vmdash
vmdash
```

Pastikan `~/.local/bin` ada di `PATH`. Kalau belum:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

### Pertama kali jalan

Buka <http://127.0.0.1:8787>. Server akan membuat:

- `~/Library/Application Support/vmdash/vmdash.db` — cache + audit
- `~/Library/Application Support/vmdash/master.key` — master key enkripsi (0600)

Lalu **Workspaces → Add workspace**, paste key `ibk_…`. Key bisa dibuat di
<https://dashboard.instabox.sh/dashboard/api-keys> dengan scope `machines:read`,
`machines:write`, `machines:delete`, dan `images:read`/`images:write` (snapshot).
Untuk menulis Org Secrets dari workspace key, tambahkan `workspace:admin`.

Semua panduan pemakaian, MCP, security, dan troubleshooting juga tersedia offline di menu
**Docs** di dalam dashboard.

### Update

```bash
git pull
make build
# restart proses vmdash
```

Data di `vmdash.db` tidak perlu dimigrasi manual; tabel baru dibuat otomatis saat start.

### Uninstall

```bash
rm -f ~/.local/bin/vmdash
rm -rf "$HOME/Library/Application Support/vmdash"   # macOS
# Linux: rm -rf "$HOME/.local/share/vmdash"
```

Menghapus data dir akan menghapus master key. API key yang tersimpan tidak bisa didekripsi lagi;
revoke juga key-nya di InstaBox kalau sudah tidak dipakai.

### Mode development

```bash
# terminal 1
cargo run

# terminal 2
cd web && npm run dev     # http://127.0.0.1:5173, proxy /api → 8787
```

### Environment

| Variabel | Default | Fungsi |
|---|---|---|
| `VMDASH_BIND` | `127.0.0.1` | alamat bind. Jangan `0.0.0.0` tanpa tunnel + token. |
| `VMDASH_PORT` | `8787` | port dashboard |
| `VMDASH_DATA_DIR` | `~/Library/Application Support/vmdash` | SQLite + master key |
| `VMDASH_WEB_DIR` | *(embedded)* | override UI dengan folder di disk |
| `VMDASH_SYNC_SECS` | `15` | interval polling fleet |
| `VMDASH_MCP_TOKEN` | dibuat otomatis | token MCP (override) |
| `VMDASH_PUBLIC_URL` | *(kosong)* | URL publik dashboard, untuk receiver webhook |
| `VMDASH_ALLOW_ANY_HOST` | `0` | `1` = izinkan Host selain localhost (perlu untuk tunnel dashboard) |
| `INSTABOX_API_URL` | `https://api.instabox.sh` | upstream |

## MCP

Server MCP ada di `http://127.0.0.1:8787/mcp` (Streamable HTTP, sessionless) dan `vmdash mcp-stdio`.
Token ada di tab **MCP**. Kirim sebagai:

```
Authorization: Bearer <token>
X-MCP-Token: <token>
?token=<token>
```

Claude Code:

```bash
claude mcp add --transport http vmdash http://127.0.0.1:8787/mcp \
  --header "Authorization: Bearer <token>"
```

Tool yang tersedia (20):

```
list_workspaces   list_machines   get_machine      create_machine
machine_action    delete_machine  exec             get_usage
files             ssh_token       desktop          ports
snapshots         fork_machine    resize_machine   metrics
logs              history         secrets          webhooks
```

Semua tool jalan di atas key yang tersimpan di server. **Agent tidak pernah menerima API key
InstaBox.** Setiap panggilan masuk audit log, dan delete wajib menyebut nama/ID machine.

`files` bisa list/read/write, `snapshots` bisa list/create/delete/restore, `secrets` bisa
list/set/delete/select/refresh, dan `webhooks` bisa list/create/update/delete/rotate/test/deliveries.
Terminal dan VNC tidak lewat MCP (butuh WebSocket); gunakan `ssh_token` atau `desktop` link dari
agent, atau tab Terminal/Desktop di dashboard.

Kalau agent-nya hidup di dalam VM InstaBox, `127.0.0.1` tidak bisa dijangkau. Pilih salah satu:

1. **stdio** — agent jalan di laptop yang sama.
2. **Tunnel** — `cloudflared tunnel --url http://127.0.0.1:8787`, lalu pakai
   `https://<name>.trycloudflare.com/mcp?token=<token>`.
3. Taruh binary ini di VPS kecil dan akses lewat HTTPS.

## Keamanan & penyimpanan API key

Key InstaBox **tidak** disimpan sebagai plaintext dan **tidak** dikirim ke browser atau MCP client.

| Item | Lokasi | Proteksi |
|---|---|---|
| API key | kolom `workspaces.key_cipher` di `vmdash.db` | ChaCha20-Poly1305, nonce 12 byte acak, base64; file DB/WAL `0600` |
| Master key | `master.key` di data dir | 32 byte acak, permission `0600`; data dir `0700` |
| Hint | `workspaces.key_hint` | hanya 4 karakter terakhir untuk tampilan |
| Fingerprint | `workspaces.key_fingerprint` | SHA-256 prefix, deteksi key duplikat |
| MCP token | tabel `settings` | plaintext; hanya untuk MCP lokal + WebSocket terminal/VNC |
| Audit | tabel `audit` | aksi & detail; tidak pernah key |

Data dir default:

- macOS: `~/Library/Application Support/vmdash/`
- Linux: `~/.local/share/vmdash/`
- Windows: `%APPDATA%\vmdash\`

Ciphertext-nya `base64(nonce || ciphertext)`. Plaintext hanya ada di memori proses saat request ke
InstaBox. Data dir `0700` dan file SQLite `0600` karena server memasang `umask 077`. Master key dan
database berada di direktori yang sama, jadi siapa pun yang bisa membaca keduanya bisa mendekripsi
key — ini enkripsi at-rest, bukan hardware vault. Aktifkan FileVault / BitLocker / LUKS, dan jangan
commit data dir.

Detail lengkap ada di **[SECURITY.md](SECURITY.md)** dan menu **Docs → Security model**.

- Browser tidak pernah menerima key. Frontend hanya bicara ke API lokal.
- API menolak `Host` selain localhost (mitigasi DNS rebinding). MCP tetap bisa lewat tunnel karena
  dilindungi token.
- `delete` butuh konfirmasi nama/ID, mengikuti aturan `X-Confirm-Delete` InstaBox.
- Tidak ada telemetry. Semua state ada di SQLite lokal.
- Lisensi MIT.

## Struktur

```
src/
  main.rs       bootstrap, router, host guard, poller
  config.rs     env + path
  crypto.rs     master key, seal/open, fingerprint
  store.rs      SQLite: workspaces, machines, operations, audit, webhooks
  instabox.rs   REST client + error/retry mapping
  sync.rs       polling per workspace
  api.rs        REST untuk UI + SSE + operation watcher
  extras.rs     files, SSH, desktop, ports, snapshots, telemetry, secrets,
                webhooks, dan WebSocket proxy terminal/VNC
  mcp.rs        JSON-RPC MCP (HTTP + stdio) dan 20 tool
web/
  src/views/    Fleet, Snapshots, Workspaces, Activity, MCP
  src/components/machine/  Terminal, Files, Desktop, Ports, Snapshots,
                           Telemetry, Settings
```

## Webhook receiver

InstaBox hanya mengirim ke HTTPS publik. Kalau ingin dashboard ini yang menerima:

```bash
cloudflared tunnel --url http://127.0.0.1:8787
export VMDASH_PUBLIC_URL=https://<name>.trycloudflare.com
./target/release/vmdash
```

Lalu buat endpoint di **Workspaces → ikon kunci → Webhooks** dengan URL
`https://<name>.trycloudflare.com/webhooks/instabox/<workspaceId>`. Signature Standard Webhooks
diverifikasi dengan secret yang disimpan terenkripsi; event masuk ke tabel lokal dan audit.
Secret hanya ditampilkan sekali saat create/rotate.

## Yang belum ada

- policy per agent (allowlist tool, budget, approval)
- multi-user / remote auth
- SSH interaktif di browser selain PTY terminal (SSH token sudah bisa untuk client luar)
- export `/data` dan custom image

Fondasinya sudah mendukung semua itu: `operations`, `audit`, `webhook_events`, dan layer MCP adalah
tempat yang tepat untuk policy.
