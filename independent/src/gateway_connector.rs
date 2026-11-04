//! Generation-bound Gateway origin, DNS and peer policy.
//!
//! P5a does not change production routing. It defines the immutable contract
//! consumed by later HTTP and special-TLS migrations: one reviewed Profile
//! origin is resolved once, every address is classified before credentials are
//! used, implicit proxies remain disabled, and connected peers must belong to
//! that exact generation's resolution set.

use crate::{Error, ErrorKind, Result};
use reqwest::blocking::ClientBuilder;
use socket2::{Domain, Protocol, Socket, Type};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};
use url::{Host, Url};

const MAX_PROFILE_ID_BYTES: usize = 64;
const MAX_RESOLVED_ADDRESSES: usize = 16;

fn configuration_error(message: impl Into<String>) -> Error {
    Error::classified(ErrorKind::Configuration, message)
}

fn address_policy_error(message: &'static str) -> Error {
    Error::classified(ErrorKind::GatewayAddressPolicyRejected, message)
}

fn connector_error(message: impl Into<String>) -> Error {
    Error::classified(ErrorKind::GatewayHttp, message)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AddressScope {
    Public,
    Private,
    Forbidden,
}

fn ipv4_scope(address: Ipv4Addr) -> AddressScope {
    let octets = address.octets();
    if address.is_unspecified()
        || address.is_loopback()
        || address.is_link_local()
        || address.is_multicast()
        || address.is_broadcast()
        || address.is_documentation()
        || octets[0] == 0
        || octets[0] >= 240
        || (octets[0] == 198 && (18..=19).contains(&octets[1]))
    {
        return AddressScope::Forbidden;
    }
    if address.is_private() || (octets[0] == 100 && (64..=127).contains(&octets[1])) {
        AddressScope::Private
    } else {
        AddressScope::Public
    }
}

fn ipv6_scope(address: Ipv6Addr) -> AddressScope {
    if let Some(mapped) = address.to_ipv4_mapped() {
        return ipv4_scope(mapped);
    }
    let segments = address.segments();
    if address.is_unspecified()
        || address.is_loopback()
        || address.is_multicast()
        || (segments[0] & 0xffc0) == 0xfe80
        || (segments[0] == 0x2001 && segments[1] == 0x0db8)
        || (segments[0] & 0xffc0) == 0xfec0
    {
        return AddressScope::Forbidden;
    }
    if (segments[0] & 0xfe00) == 0xfc00 {
        AddressScope::Private
    } else {
        AddressScope::Public
    }
}

fn address_scope(address: IpAddr) -> AddressScope {
    match address {
        IpAddr::V4(address) => ipv4_scope(address),
        IpAddr::V6(address) => ipv6_scope(address),
    }
}

fn valid_profile_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= MAX_PROFILE_ID_BYTES
        && bytes.first().is_some_and(u8::is_ascii_alphanumeric)
        && bytes.last().is_some_and(u8::is_ascii_alphanumeric)
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
}

fn normalize_origin(value: &str) -> Result<(String, Host<String>, String, u16)> {
    let url = Url::parse(value).map_err(|_| configuration_error("invalid Gateway origin"))?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(configuration_error(
            "Gateway origin must be a credential-free HTTPS root",
        ));
    }
    let host = url
        .host()
        .ok_or_else(|| configuration_error("Gateway origin has no host"))?
        .to_owned();
    let host_text = url
        .host_str()
        .ok_or_else(|| configuration_error("Gateway origin has no host"))?
        .to_owned();
    let port = url
        .port_or_known_default()
        .ok_or_else(|| configuration_error("Gateway origin has no port"))?;
    Ok((url.origin().ascii_serialization(), host, host_text, port))
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GatewayConnectorGeneration {
    profile_id: String,
    profile_revision: u64,
    generation: u64,
    origin: String,
    host: String,
    port: u16,
    addresses: Vec<SocketAddr>,
    reviewed_private_gateway_allowed: bool,
    source_interface: Option<String>,
    source_address: Option<IpAddr>,
}

impl GatewayConnectorGeneration {
    pub fn resolve_with<F>(
        profile_id: &str,
        profile_revision: u64,
        generation: u64,
        origin: &str,
        reviewed_private_gateway_allowed: bool,
        resolver: F,
    ) -> Result<Self>
    where
        F: FnOnce(&str, u16) -> std::io::Result<Vec<SocketAddr>>,
    {
        if !valid_profile_id(profile_id) || profile_revision == 0 || generation == 0 {
            return Err(configuration_error(
                "Gateway connector Profile or generation is invalid",
            ));
        }
        let (origin, parsed_host, host, port) = normalize_origin(origin)?;
        let resolved = match parsed_host {
            Host::Ipv4(address) => vec![SocketAddr::new(IpAddr::V4(address), port)],
            Host::Ipv6(address) => vec![SocketAddr::new(IpAddr::V6(address), port)],
            Host::Domain(_) => resolver(&host, port).map_err(|error| {
                connector_error(format!("Gateway DNS resolution failed: {error}"))
            })?,
        };
        Self::from_resolved(
            profile_id,
            profile_revision,
            generation,
            &origin,
            reviewed_private_gateway_allowed,
            resolved,
        )
    }

    pub fn resolve_system(
        profile_id: &str,
        profile_revision: u64,
        generation: u64,
        origin: &str,
        reviewed_private_gateway_allowed: bool,
    ) -> Result<Self> {
        Self::resolve_with(
            profile_id,
            profile_revision,
            generation,
            origin,
            reviewed_private_gateway_allowed,
            |host, port| {
                (host, port)
                    .to_socket_addrs()
                    .map(|values| values.collect())
            },
        )
    }

    pub fn from_resolved(
        profile_id: &str,
        profile_revision: u64,
        generation: u64,
        origin: &str,
        reviewed_private_gateway_allowed: bool,
        resolved: Vec<SocketAddr>,
    ) -> Result<Self> {
        if !valid_profile_id(profile_id) || profile_revision == 0 || generation == 0 {
            return Err(configuration_error(
                "Gateway connector Profile or generation is invalid",
            ));
        }
        let (origin, parsed_host, host, port) = normalize_origin(origin)?;
        if resolved.is_empty() || resolved.len() > MAX_RESOLVED_ADDRESSES {
            return Err(configuration_error(
                "Gateway resolution set has an invalid size",
            ));
        }
        let mut addresses = Vec::with_capacity(resolved.len());
        let mut selected_scope = None;
        for address in resolved {
            if address.port() != port {
                return Err(configuration_error(
                    "Gateway resolution returned an unexpected port",
                ));
            }
            let scope = address_scope(address.ip());
            if scope == AddressScope::Forbidden
                || (scope == AddressScope::Private && !reviewed_private_gateway_allowed)
            {
                return Err(address_policy_error(
                    "Gateway resolution returned a forbidden address",
                ));
            }
            if selected_scope.is_some_and(|selected| selected != scope) {
                return Err(address_policy_error(
                    "Gateway resolution mixed public and private addresses",
                ));
            }
            selected_scope = Some(scope);
            if !addresses.contains(&address) {
                addresses.push(address);
            }
        }
        match parsed_host {
            Host::Ipv4(expected) => {
                if addresses.len() != 1 || addresses[0].ip() != IpAddr::V4(expected) {
                    return Err(configuration_error(
                        "Gateway IP literal does not match its peer address",
                    ));
                }
            }
            Host::Ipv6(expected) => {
                if addresses.len() != 1 || addresses[0].ip() != IpAddr::V6(expected) {
                    return Err(configuration_error(
                        "Gateway IP literal does not match its peer address",
                    ));
                }
            }
            Host::Domain(_) => {}
        }
        Ok(Self {
            profile_id: profile_id.to_owned(),
            profile_revision,
            generation,
            origin,
            host,
            port,
            addresses,
            reviewed_private_gateway_allowed,
            source_interface: None,
            source_address: None,
        })
    }

    pub fn with_underlay(mut self, interface: &str, source_address: IpAddr) -> Result<Self> {
        if interface.is_empty()
            || interface.len() > 64
            || !interface.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b':')
            })
            || source_address.is_unspecified()
            || source_address.is_loopback()
            || source_address.is_multicast()
        {
            return Err(configuration_error("Gateway underlay selection is invalid"));
        }
        self.source_interface = Some(interface.to_owned());
        self.source_address = Some(source_address);
        Ok(self)
    }

    pub fn profile_id(&self) -> &str {
        &self.profile_id
    }

    pub const fn profile_revision(&self) -> u64 {
        self.profile_revision
    }

    pub const fn generation(&self) -> u64 {
        self.generation
    }

    pub fn origin(&self) -> &str {
        &self.origin
    }

    pub fn host(&self) -> &str {
        &self.host
    }

    pub const fn port(&self) -> u16 {
        self.port
    }

    pub fn resolved_addresses(&self) -> &[SocketAddr] {
        &self.addresses
    }

    pub const fn reviewed_private_gateway_allowed(&self) -> bool {
        self.reviewed_private_gateway_allowed
    }

    pub fn peer_allowed(&self, peer: SocketAddr) -> bool {
        self.addresses.contains(&peer)
    }

    pub fn apply_to_reqwest_builder(&self, builder: ClientBuilder) -> ClientBuilder {
        let mut builder = builder
            .no_proxy()
            .resolve_to_addrs(&self.host, &self.addresses);
        if let Some(address) = self.source_address {
            builder = builder.local_address(address);
        }
        #[cfg(not(target_os = "windows"))]
        if let Some(interface) = self.source_interface.as_deref() {
            builder = builder.interface(interface);
        }
        builder
    }

    fn connect_address(&self, peer: SocketAddr, timeout: Duration) -> std::io::Result<TcpStream> {
        let Some(source) = self.source_address else {
            return TcpStream::connect_timeout(&peer, timeout);
        };
        if source.is_ipv4() != peer.is_ipv4() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AddrNotAvailable,
                "selected source address family does not match Gateway peer",
            ));
        }
        let socket = Socket::new(Domain::for_address(peer), Type::STREAM, Some(Protocol::TCP))?;
        socket.bind(&SocketAddr::new(source, 0).into())?;
        socket.connect_timeout(&peer.into(), timeout)?;
        Ok(socket.into())
    }

    pub fn connect_tcp(&self, timeout: Duration) -> Result<TcpStream> {
        if timeout.is_zero() {
            return Err(configuration_error(
                "Gateway connector timeout must be nonzero",
            ));
        }
        let deadline = Instant::now()
            .checked_add(timeout)
            .ok_or_else(|| configuration_error("Gateway connector timeout is too large"))?;
        let mut last_error = None;
        for address in &self.addresses {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            match self.connect_address(*address, remaining) {
                Ok(stream) => {
                    self.verify_connected_peer(&stream)?;
                    return Ok(stream);
                }
                Err(error) => last_error = Some(error),
            }
        }
        Err(connector_error(format!(
            "cannot connect to any Gateway peer: {}",
            last_error
                .map(|error| error.to_string())
                .unwrap_or_else(|| "no address".to_owned())
        )))
    }

    pub fn connect_tcp_to(&self, peer: SocketAddr, timeout: Duration) -> Result<TcpStream> {
        if timeout.is_zero() {
            return Err(configuration_error(
                "Gateway connector timeout must be nonzero",
            ));
        }
        if !self.peer_allowed(peer) {
            return Err(Error::classified(
                ErrorKind::GatewayProtocolInvalid,
                "requested Gateway peer is outside the connector generation",
            ));
        }
        let stream = self.connect_address(peer, timeout).map_err(|error| {
            connector_error(format!(
                "cannot connect to the selected Gateway peer: {error}"
            ))
        })?;
        self.verify_connected_peer(&stream)?;
        Ok(stream)
    }

    fn verify_connected_peer(&self, stream: &TcpStream) -> Result<()> {
        let peer = stream
            .peer_addr()
            .map_err(|error| connector_error(format!("cannot inspect Gateway peer: {error}")))?;
        if !self.peer_allowed(peer) {
            return Err(Error::classified(
                ErrorKind::GatewayProtocolInvalid,
                "connected Gateway peer is outside the connector generation",
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::blocking::Client;

    fn public(address: &str) -> SocketAddr {
        if address.contains(':') {
            format!("[{address}]:443").parse().unwrap()
        } else {
            format!("{address}:443").parse().unwrap()
        }
    }

    #[test]
    fn connector_binds_reviewed_profile_origin_generation_and_dns_set() {
        let connector = GatewayConnectorGeneration::from_resolved(
            "school-a",
            7,
            11,
            "https://vpn.example.edu",
            false,
            vec![public("8.8.8.8"), public("1.1.1.1"), public("8.8.8.8")],
        )
        .unwrap();
        assert_eq!(connector.profile_id(), "school-a");
        assert_eq!(connector.profile_revision(), 7);
        assert_eq!(connector.generation(), 11);
        assert_eq!(connector.origin(), "https://vpn.example.edu");
        assert_eq!(connector.host(), "vpn.example.edu");
        assert_eq!(connector.port(), 443);
        assert_eq!(connector.resolved_addresses().len(), 2);
        assert!(connector.peer_allowed(public("8.8.8.8")));
        assert!(!connector.peer_allowed(public("9.9.9.9")));
        connector
            .apply_to_reqwest_builder(Client::builder())
            .build()
            .unwrap();
        let rejected = connector
            .connect_tcp_to(public("9.9.9.9"), Duration::from_millis(1))
            .unwrap_err();
        assert_eq!(rejected.kind(), ErrorKind::GatewayProtocolInvalid);
    }

    #[test]
    fn underlay_selection_is_bounded_and_applies_to_http_and_raw_transports() {
        let connector = GatewayConnectorGeneration::from_resolved(
            "school-a",
            7,
            11,
            "https://vpn.example.edu",
            false,
            vec![public("8.8.8.8")],
        )
        .unwrap()
        .with_underlay("en0", "192.0.2.10".parse().unwrap())
        .unwrap();
        assert_eq!(connector.source_interface.as_deref(), Some("en0"));
        assert_eq!(
            connector.source_address,
            Some("192.0.2.10".parse().unwrap())
        );
        connector
            .apply_to_reqwest_builder(Client::builder())
            .build()
            .unwrap();
        for (interface, address) in [
            ("", "192.0.2.10"),
            ("adapter with spaces", "192.0.2.10"),
            ("en0", "127.0.0.1"),
            ("en0", "224.0.0.1"),
        ] {
            let candidate = GatewayConnectorGeneration::from_resolved(
                "school-a",
                7,
                11,
                "https://vpn.example.edu",
                false,
                vec![public("8.8.8.8")],
            )
            .unwrap();
            assert!(
                candidate
                    .with_underlay(interface, address.parse().unwrap())
                    .is_err()
            );
        }
    }

    #[test]
    fn origin_is_an_exact_credential_free_https_root() {
        for origin in [
            "http://vpn.example.edu",
            "https://user@vpn.example.edu",
            "https://vpn.example.edu/path",
            "https://vpn.example.edu/?query=1",
            "https://vpn.example.edu/#fragment",
        ] {
            assert!(
                GatewayConnectorGeneration::from_resolved(
                    "school-a",
                    1,
                    1,
                    origin,
                    false,
                    vec![public("8.8.8.8")],
                )
                .is_err()
            );
        }
    }

    #[test]
    fn address_policy_rejections_are_typed_and_value_free() {
        let forbidden = [
            "127.0.0.1",
            "169.254.1.1",
            "224.0.0.1",
            "0.0.0.0",
            "192.0.2.1",
            "198.18.0.1",
            "198.19.255.254",
            "::1",
            "::",
            "fe80::1",
            "ff02::1",
            "2001:db8::1",
            "::ffff:127.0.0.1",
            "::ffff:198.18.0.1",
        ];
        let private = ["10.0.0.1", "100.64.0.1", "fd00::1", "::ffff:10.0.0.1"];
        for allow_private in [false, true] {
            for address in forbidden
                .iter()
                .chain(private.iter().filter(|_| !allow_private))
            {
                let error = GatewayConnectorGeneration::from_resolved(
                    "school-a",
                    1,
                    1,
                    "https://vpn.example.edu",
                    allow_private,
                    vec![public(address)],
                )
                .unwrap_err();
                assert_eq!(
                    error.kind(),
                    ErrorKind::GatewayAddressPolicyRejected,
                    "{address}"
                );
                assert!(!error.kind().is_retryable());
                assert!(!error.to_string().contains(address));
                assert!(!error.to_string().contains("vpn.example.edu"));
            }
        }
    }

    #[test]
    fn reviewed_private_exception_never_allows_mixed_scope() {
        let private = GatewayConnectorGeneration::from_resolved(
            "school-a",
            1,
            1,
            "https://vpn.example.edu",
            true,
            vec![
                public("10.0.0.1"),
                public("100.64.0.1"),
                public("fd00::1"),
                public("::ffff:10.0.0.1"),
            ],
        )
        .unwrap();
        assert!(private.reviewed_private_gateway_allowed());
        assert!(private.peer_allowed(public("fd00::1")));
        for allow_private in [false, true] {
            for addresses in [
                vec![public("10.0.0.1"), public("8.8.8.8")],
                vec![public("8.8.8.8"), public("10.0.0.1")],
            ] {
                let error = GatewayConnectorGeneration::from_resolved(
                    "school-a",
                    1,
                    1,
                    "https://vpn.example.edu",
                    allow_private,
                    addresses,
                )
                .unwrap_err();
                assert_eq!(error.kind(), ErrorKind::GatewayAddressPolicyRejected);
                assert!(!error.kind().is_retryable());
            }
        }
    }

    #[test]
    fn public_resolution_sets_remain_allowed() {
        for allow_private in [false, true] {
            let connector = GatewayConnectorGeneration::from_resolved(
                "school-a",
                1,
                1,
                "https://vpn.example.edu",
                allow_private,
                vec![
                    public("8.8.8.8"),
                    public("2001:4860:4860::8888"),
                    public("::ffff:8.8.8.8"),
                ],
            )
            .unwrap();
            assert!(connector.peer_allowed(public("8.8.8.8")));
            assert!(connector.peer_allowed(public("2001:4860:4860::8888")));
            assert!(connector.peer_allowed(public("::ffff:8.8.8.8")));
        }
    }

    #[test]
    fn ip_literal_skips_dns_and_must_match_exact_peer() {
        let mut resolutions = 0;
        let connector = GatewayConnectorGeneration::resolve_with(
            "school-a",
            1,
            1,
            "https://8.8.8.8",
            false,
            |_host, _port| {
                resolutions += 1;
                Ok(vec![])
            },
        )
        .unwrap();
        assert_eq!(resolutions, 0);
        assert!(connector.peer_allowed(public("8.8.8.8")));
        assert!(
            GatewayConnectorGeneration::from_resolved(
                "school-a",
                1,
                1,
                "https://8.8.8.8",
                false,
                vec![public("1.1.1.1")],
            )
            .is_err()
        );
    }

    #[test]
    fn resolver_failure_bounds_and_port_drift_fail_closed() {
        let error = GatewayConnectorGeneration::resolve_with(
            "school-a",
            1,
            1,
            "https://vpn.example.edu:8443",
            false,
            |_host, _port| Err(std::io::Error::other("fixture")),
        )
        .unwrap_err();
        assert_eq!(error.kind(), ErrorKind::GatewayHttp);
        assert!(
            GatewayConnectorGeneration::from_resolved(
                "school-a",
                1,
                1,
                "https://vpn.example.edu:8443",
                false,
                vec![public("8.8.8.8")],
            )
            .is_err()
        );
        assert!(
            GatewayConnectorGeneration::from_resolved(
                "school-a",
                1,
                1,
                "https://vpn.example.edu",
                false,
                (0..=MAX_RESOLVED_ADDRESSES)
                    .map(|index| SocketAddr::new(
                        IpAddr::V4(Ipv4Addr::new(8, 8, 4, index as u8)),
                        443
                    ))
                    .collect(),
            )
            .is_err()
        );
    }

    #[test]
    fn invalid_profile_generation_and_timeout_are_rejected() {
        assert!(
            GatewayConnectorGeneration::from_resolved(
                "School A",
                1,
                1,
                "https://vpn.example.edu",
                false,
                vec![public("8.8.8.8")],
            )
            .is_err()
        );
        let connector = GatewayConnectorGeneration::from_resolved(
            "school-a",
            1,
            1,
            "https://vpn.example.edu",
            false,
            vec![public("8.8.8.8")],
        )
        .unwrap();
        assert!(connector.connect_tcp(Duration::ZERO).is_err());
    }
}
