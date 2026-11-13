use std::env;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;

use anyhow::{Context, Result};

#[derive(Clone, Debug)]
pub struct Config {
    pub bind: IpAddr,
    pub port: u16,
    pub data_dir: PathBuf,
    pub web_dir: Option<PathBuf>,
    pub api_base: String,
    pub sync_secs: u64,
    pub mcp_token_env: Option<String>,
    pub public_url: Option<String>,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let data_dir = match env::var("VMDASH_DATA_DIR") {
            Ok(v) => PathBuf::from(v),
            Err(_) => dirs::data_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join("vmdash"),
        };

        let web_dir = env::var("VMDASH_WEB_DIR").ok().map(PathBuf::from);

        let bind: IpAddr = env::var("VMDASH_BIND")
            .unwrap_or_else(|_| "127.0.0.1".into())
            .parse()
            .context("VMDASH_BIND is not a valid IP address")?;

        let port: u16 = env::var("VMDASH_PORT")
            .unwrap_or_else(|_| "8787".into())
            .parse()
            .context("VMDASH_PORT is not a valid port")?;

        let api_base = env::var("INSTABOX_API_URL")
            .unwrap_or_else(|_| "https://api.instabox.sh".into());

        let sync_secs: u64 = env::var("VMDASH_SYNC_SECS")
            .unwrap_or_else(|_| "15".into())
            .parse()
            .context("VMDASH_SYNC_SECS is not a number")?;

        Ok(Self {
            bind,
            port,
            data_dir,
            web_dir,
            api_base,
            sync_secs: sync_secs.max(5),
            mcp_token_env: env::var("VMDASH_MCP_TOKEN").ok().filter(|s| !s.is_empty()),
            public_url: env::var("VMDASH_PUBLIC_URL")
                .ok()
                .map(|s| s.trim_end_matches('/').to_string())
                .filter(|s| !s.is_empty()),
        })
    }

    pub fn addr(&self) -> SocketAddr {
        SocketAddr::new(self.bind, self.port)
    }

    pub fn db_path(&self) -> PathBuf {
        self.data_dir.join("vmdash.db")
    }

    pub fn master_key_path(&self) -> PathBuf {
        self.data_dir.join("master.key")
    }
}
