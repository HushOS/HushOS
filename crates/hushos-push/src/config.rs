//! Settings from the environment. Each secret can come from a file instead (`NAME_FILE`), which
//! is how the APNs key and the FCM service account are given: mounted, never committed.

use std::net::{IpAddr, SocketAddr};

use axum::http::HeaderName;

use crate::api::Settings;
use crate::limits::Budget;

pub struct ApnsConfig {
    pub key: Vec<u8>,
    pub key_id: String,
    pub team_id: String,
    pub topic: String,
}

pub struct Config {
    pub listen: SocketAddr,
    pub database_url: String,
    pub apns: Option<ApnsConfig>,
    pub fcm_service_account: Option<Vec<u8>>,
    pub settings: Settings,
}

/// The environment, as a function so tests can give their own.
pub type Lookup<'a> = &'a dyn Fn(&str) -> Option<String>;

/// `NAME`, or the contents of the file `NAME_FILE` names; both at once is a mistake.
fn value(env: Lookup, name: &str) -> Result<Option<Vec<u8>>, String> {
    let direct = env(name).filter(|value| !value.is_empty());
    let file = env(&format!("{name}_FILE")).filter(|value| !value.is_empty());
    match (direct, file) {
        (Some(_), Some(_)) => Err(format!("set {name} or {name}_FILE, not both")),
        (Some(value), None) => Ok(Some(value.into_bytes())),
        (None, Some(path)) => {
            std::fs::read(&path).map(Some).map_err(|error| format!("{name}_FILE ({path}): {error}"))
        }
        (None, None) => Ok(None),
    }
}

fn text(env: Lookup, name: &str) -> Result<Option<String>, String> {
    value(env, name)?
        .map(|bytes| String::from_utf8(bytes).map(|text| text.trim().to_owned()))
        .transpose()
        .map_err(|_| format!("{name} is not UTF-8"))
}

fn budget(env: Lookup, name: &str, default: u32) -> Result<Budget, String> {
    match env(name).filter(|value| !value.is_empty()) {
        None => Ok(Budget(default)),
        Some(value) => match value.parse::<u32>() {
            Ok(n) if (1..=1_000_000).contains(&n) => Ok(Budget(n)),
            _ => Err(format!("{name} must be a whole number from 1 to 1000000")),
        },
    }
}

impl Config {
    pub fn from_env(env: Lookup) -> Result<Config, String> {
        let listen = env("PUSH_LISTEN").unwrap_or_else(|| "0.0.0.0:8080".to_owned());
        let listen = listen.parse().map_err(|_| format!("PUSH_LISTEN {listen:?} is not an address and port"))?;
        let database_url = text(env, "DATABASE_URL")?.ok_or("DATABASE_URL (or DATABASE_URL_FILE) is required")?;

        let apns = match value(env, "APNS_KEY")? {
            None => None,
            Some(key) => Some(ApnsConfig {
                key,
                key_id: env("APNS_KEY_ID").filter(|v| !v.is_empty()).ok_or("APNS_KEY_ID is required with APNS_KEY")?,
                team_id: env("APNS_TEAM_ID").filter(|v| !v.is_empty()).ok_or("APNS_TEAM_ID is required with APNS_KEY")?,
                topic: env("APNS_TOPIC").filter(|v| !v.is_empty()).unwrap_or_else(|| "com.hushos.app".to_owned()),
            }),
        };
        let fcm_service_account = value(env, "FCM_SERVICE_ACCOUNT")?;

        let trusted_proxy_header = match env("PUSH_TRUSTED_PROXY_HEADER").filter(|v| !v.is_empty()) {
            None => None,
            Some(name) => Some(
                HeaderName::try_from(name.to_ascii_lowercase())
                    .map_err(|_| format!("PUSH_TRUSTED_PROXY_HEADER {name:?} is not a header name"))?,
            ),
        };
        let trusted_senders = env("PUSH_TRUSTED_SENDERS")
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(|item| item.parse::<IpAddr>().map_err(|_| format!("PUSH_TRUSTED_SENDERS: {item:?} is not an address")))
            .collect::<Result<Vec<_>, _>>()?;
        let settings = Settings {
            trusted_proxy_header,
            trusted_senders,
            address_security: budget(env, "PUSH_ADDRESS_SECURITY_PER_HOUR", 1000)?,
            address_other: budget(env, "PUSH_ADDRESS_OTHER_PER_HOUR", 3000)?,
        };
        Ok(Config { listen, database_url, apns, fcm_service_account, settings })
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn config(pairs: &[(&str, &str)]) -> Result<Config, String> {
        let map: HashMap<String, String> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        Config::from_env(&|name| map.get(name).cloned())
    }

    #[test]
    fn secrets_come_from_files_and_never_from_both_places() {
        let dir = std::env::temp_dir().join(format!("hushos-push-config-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("database-url");
        std::fs::write(&path, "postgres://relay@db/hushos_push\n").unwrap();
        let path = path.to_str().unwrap();

        let from_file = config(&[("DATABASE_URL_FILE", path)]).unwrap();
        assert_eq!(from_file.database_url, "postgres://relay@db/hushos_push");
        assert!(config(&[("DATABASE_URL_FILE", path), ("DATABASE_URL", "postgres://other")]).is_err());
        assert!(config(&[("DATABASE_URL_FILE", "/nonexistent/hushos-push")]).is_err());
        assert!(config(&[]).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn an_apns_key_needs_its_ids_and_limits_must_be_sane() {
        let base = [("DATABASE_URL", "postgres://relay@db/hushos_push")];
        let ok = config(&base).unwrap();
        assert!(ok.apns.is_none() && ok.fcm_service_account.is_none());
        assert_eq!((ok.settings.address_security, ok.settings.address_other), (Budget(1000), Budget(3000)));
        assert!(config(&[base[0], ("APNS_KEY", "key")]).is_err());
        assert!(config(&[base[0], ("APNS_KEY", "key"), ("APNS_KEY_ID", "ABC123")]).is_err());
        let apns = config(&[base[0], ("APNS_KEY", "key"), ("APNS_KEY_ID", "ABC123"), ("APNS_TEAM_ID", "TEAM")]).unwrap();
        assert_eq!(apns.apns.unwrap().topic, "com.hushos.app");
        assert!(config(&[base[0], ("PUSH_ADDRESS_SECURITY_PER_HOUR", "0")]).is_err());
        assert!(config(&[base[0], ("PUSH_TRUSTED_SENDERS", "198.51.100.4, hushos.com")]).is_err());
        let trusted = config(&[base[0], ("PUSH_TRUSTED_SENDERS", "198.51.100.4, 2001:db8::1")]).unwrap();
        assert_eq!(trusted.settings.trusted_senders.len(), 2);
    }
}
