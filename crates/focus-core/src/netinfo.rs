//! Choosing which local address to host on. We bind to ONE chosen interface, never 0.0.0.0.

use serde::Serialize;
use std::net::IpAddr;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct LanAddr {
    pub ip: String,
    pub interface: String,
    pub private: bool,
}

pub fn is_private_v4(ip: &std::net::Ipv4Addr) -> bool {
    ip.is_private()
}

/// Pure ranking so it can be unit-tested: private IPv4 first, then other IPv4, never loopback/link-local/IPv6.
pub fn rank(addrs: Vec<(String, IpAddr)>) -> Vec<LanAddr> {
    let mut v: Vec<LanAddr> = addrs
        .into_iter()
        .filter_map(|(name, ip)| match ip {
            IpAddr::V4(a)
                if !a.is_loopback()
                    && !a.is_link_local()
                    && !a.is_unspecified()
                    && !a.is_multicast() =>
            {
                Some(LanAddr {
                    ip: a.to_string(),
                    interface: name,
                    private: is_private_v4(&a),
                })
            }
            _ => None,
        })
        .collect();
    v.sort_by_key(|a| !a.private);
    v
}

pub fn lan_addresses() -> Vec<LanAddr> {
    let list = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter(|i| !i.is_loopback())
        .map(|i| (i.name.clone(), i.ip()))
        .collect();
    rank(list)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ranks_private_first_and_drops_loopback_and_link_local() {
        let r = rank(vec![
            ("lo".into(), "127.0.0.1".parse().unwrap()),
            ("v".into(), "169.254.3.4".parse().unwrap()),
            ("pub".into(), "8.8.4.4".parse().unwrap()),
            ("wifi".into(), "192.168.1.20".parse().unwrap()),
            ("v6".into(), "fe80::1".parse().unwrap()),
        ]);
        assert_eq!(
            r.iter().map(|a| a.ip.as_str()).collect::<Vec<_>>(),
            vec!["192.168.1.20", "8.8.4.4"]
        );
    }
}
