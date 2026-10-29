//! mDNS / DNS-SD discovery (`_focusos._tcp`). Best effort: many networks block multicast,
//! so manual entry is always available. We only browse for our own service type.

use crate::error::{Error, Result};
use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use serde::Serialize;
use std::collections::HashMap;
use std::time::Duration;

pub const SERVICE_TYPE: &str = "_focusos._tcp.local.";

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct DiscoveredHost {
    pub class_id: String,
    pub addrs: Vec<String>,
}

pub struct Advertiser {
    daemon: ServiceDaemon,
    fullname: String,
}

impl Advertiser {
    /// Advertise only the class id and protocol version, not the class name or members.
    pub fn start(class_id: &str, ip: std::net::IpAddr, port: u16) -> Result<Self> {
        let daemon =
            ServiceDaemon::new().map_err(|e| Error::Network(format!("mDNS unavailable: {e}")))?;
        let instance = format!("focus-{}", &class_id[..class_id.len().min(12)]);
        let host = format!("{instance}.local.");
        let mut txt = HashMap::new();
        txt.insert("cid".to_string(), class_id.to_string());
        txt.insert("v".to_string(), "1".to_string());
        let info = ServiceInfo::new(SERVICE_TYPE, &instance, &host, ip, port, Some(txt))
            .map_err(|e| Error::Network(format!("mDNS record: {e}")))?;
        let fullname = info.get_fullname().to_string();
        daemon
            .register(info)
            .map_err(|e| Error::Network(format!("mDNS register: {e}")))?;
        Ok(Self { daemon, fullname })
    }
}

impl Drop for Advertiser {
    fn drop(&mut self) {
        let _ = self.daemon.unregister(&self.fullname);
        let _ = self.daemon.shutdown();
    }
}

/// Browse for `timeout`, returning hosts (optionally filtered to one class id).
pub fn browse(timeout: Duration, only_class: Option<&str>) -> Result<Vec<DiscoveredHost>> {
    let daemon =
        ServiceDaemon::new().map_err(|e| Error::Network(format!("mDNS unavailable: {e}")))?;
    let rx = daemon
        .browse(SERVICE_TYPE)
        .map_err(|e| Error::Network(format!("mDNS browse: {e}")))?;
    let deadline = std::time::Instant::now() + timeout;
    let mut found: Vec<DiscoveredHost> = vec![];
    while let Some(left) = deadline.checked_duration_since(std::time::Instant::now()) {
        match rx.recv_timeout(left) {
            Ok(ServiceEvent::ServiceResolved(info)) => {
                let cid = info.get_property_val_str("cid").unwrap_or("").to_string();
                if cid.is_empty() || cid.len() > 64 || only_class.is_some_and(|c| c != cid) {
                    continue;
                }
                let port = info.get_port();
                let addrs: Vec<String> = info
                    .get_addresses()
                    .iter()
                    .filter(|a| a.is_ipv4())
                    .map(|a| format!("{a}:{port}"))
                    .collect();
                if !addrs.is_empty() && !found.iter().any(|f| f.class_id == cid) {
                    found.push(DiscoveredHost {
                        class_id: cid,
                        addrs,
                    });
                }
            }
            Ok(_) => {}
            Err(_) => break,
        }
    }
    let _ = daemon.shutdown();
    Ok(found)
}
