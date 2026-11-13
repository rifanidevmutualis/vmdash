# Security policy

## Reporting a vulnerability

Open a private security advisory on the repository, or contact the maintainer directly. Please do
not open a public issue for a vulnerability that exposes credentials or allows code execution.

Include:

- affected version (shown in the dashboard footer or `package.json`);
- operating system;
- steps to reproduce;
- whether an InstaBox API key or MCP token could be read or used.

## How InstaBox API keys are stored

vmdash stores one encrypted blob per workspace, not one plaintext key per machine.

| Item | Where | Protection |
|---|---|---|
| InstaBox API key | `workspaces.key_cipher` in `vmdash.db` | ChaCha20-Poly1305, random 12-byte nonce, base64; DB/WAL files `0600` |
| Master key | `master.key` in the data directory | 32 random bytes, file mode `0600`; data directory `0700` |
| Key hint | `workspaces.key_hint` | last 4 characters only |
| Fingerprint | `workspaces.key_fingerprint` | SHA-256 prefix, duplicate detection |
| MCP token | `settings` table | plaintext; authorises local MCP and terminal/VNC WebSockets |
| Audit log | `audit` table | actions and details; never key material |

The data directory defaults to:

- macOS: `~/Library/Application Support/vmdash/`
- Linux: `~/.local/share/vmdash/`
- Windows: `%APPDATA%\vmdash\`

Override it with `VMDASH_DATA_DIR`.

The ciphertext layout is `base64(nonce || ciphertext)`. Plaintext exists only in the server process
memory while a request to InstaBox is being made. The data directory is `0700` and SQLite files are
created with `0600` (the server sets `umask 077`). The key is never serialised to the browser and
never passed to an MCP client; `/api/settings` returns only the MCP token, and workspace responses
skip the cipher and fingerprint.

## Threat model

**Protected against**

- A web page reading keys through the browser (no key is sent to the browser).
- Cross-origin reads of the local API (no CORS headers, and non-localhost `Host` headers are
  rejected by default).
- An MCP client asking for a key; tools act on the client's behalf.
- A stolen MCP token creating new InstaBox keys. It can only drive workspaces already connected.

**Not protected against**

- A local user or process that can read both `vmdash.db` and `master.key`. The master key sits next
  to the database by default, so this is encryption at rest, not a hardware vault.
- Malware running as the same OS user while the server is unlocked.
- Someone who can control the InstaBox account itself.

## Recommendations

- Enable FileVault, BitLocker, or LUKS.
- Keep the data directory out of repositories and untrusted backups.
- Use `VMDASH_DATA_DIR` on an encrypted volume if the default is not encrypted.
- Use the smallest InstaBox scopes that work. A key with `machines:write` is code execution inside
  every machine of its workspace.
- Do not expose the dashboard on `0.0.0.0`. If you need remote access, use a private network or a
  tunnel with authentication, and rotate the MCP token.
- Treat SSH tokens and desktop share links as secrets.
- Rotate keys at InstaBox if a machine is shared or a snapshot leaves your control.

## If a key is compromised

1. Revoke the key at InstaBox → API keys. This also ends SSH certificates issued by it.
2. Remove the workspace in vmdash; the encrypted blob is deleted from SQLite.
3. Add a new key with minimal scopes.
4. Rotate the MCP token in the MCP tab.
5. Review the Activity audit log for unexpected exec, file, port, or snapshot actions.

## Scope

vmdash is a local control plane. It does not proxy general traffic, does not phone home, and has no
telemetry. InstaBox itself is a separate service; report issues in the InstaBox API or dashboard to
its maintainers.
