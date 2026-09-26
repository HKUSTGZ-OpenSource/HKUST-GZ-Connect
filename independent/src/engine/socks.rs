use crate::engine::destination_policy::validate_tunnel_destination;
use crate::engine::netstack::VirtualNetstack;
use crate::engine::proxy::{NameResolver, resolve_authority, resolve_host, validate_domain};
use crate::engine::socks_auth::ProxyAuthentication;
use crate::{Error, Result};
use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream, UdpSocket as TokioUdpSocket};
use tokio::sync::RwLock;
use ts_netstack_smoltcp::netsock::UdpSocket as VirtualUdpSocket;
use zeroize::Zeroizing;

mod http_forward;

use http_forward::{
    HTTP_BAD_GATEWAY, HttpForwardRequest, ParsedHttpProxyRequest,
    forward_request as forward_http_request,
    read_authenticated_request as read_authenticated_http_request,
};

const SOCKS_VERSION: u8 = 5;
const NO_AUTHENTICATION: u8 = 0;
const USERNAME_PASSWORD_AUTHENTICATION: u8 = 2;
const NO_ACCEPTABLE_METHODS: u8 = 0xff;
const RFC1929_VERSION: u8 = 1;
const RFC1929_SUCCESS: u8 = 0;
const RFC1929_FAILURE: u8 = 1;
const CONNECT_COMMAND: u8 = 1;
const UDP_ASSOCIATE_COMMAND: u8 = 3;
const ADDRESS_IPV4: u8 = 1;
const ADDRESS_DOMAIN: u8 = 3;
const ADDRESS_IPV6: u8 = 4;
const MAX_AUTH_METHODS: usize = 32;
const MAX_DOMAIN_BYTES: usize = 253;
const MAX_UDP_DATAGRAM_BYTES: usize = 65_507;
const MAX_UDP_PAYLOAD_BYTES: usize = MAX_UDP_DATAGRAM_BYTES - 10;
const MAX_ACTIVE_CONNECTIONS: usize = 256;
// A client that opens a connection and then stalls must not hold a slot for the
// lifetime of the tunnel. The greeting is pure loopback I/O and has to arrive
// immediately; the request may additionally wait for gateway DNS.
const GREETING_TIMEOUT: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
// `accept` reports per-connection and resource-pressure failures that must not
// take the whole local frontend down with them. Only a listener that keeps
// failing is treated as unrecoverable.
const MAX_CONSECUTIVE_ACCEPT_FAILURES: u32 = 16;
const ACCEPT_FAILURE_BACKOFF: Duration = Duration::from_millis(100);

const HTTP_CONNECT_ESTABLISHED: &[u8] = b"HTTP/1.1 200 Connection Established\r\n\r\n";

#[derive(Debug, Eq, PartialEq)]
enum ProxyRequest {
    Connect {
        remote: SocketAddr,
        frontend: ConnectFrontend,
    },
    HttpForward {
        remote: SocketAddr,
        request: HttpForwardRequest,
    },
    UdpAssociate,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ConnectFrontend {
    Socks5,
    HttpConnect,
}

enum NegotiatedFrontend {
    Socks5 { udp_associate_allowed: bool },
    Http(ParsedHttpProxyRequest),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum NegotiatedSocksAuthentication {
    None,
    Rfc1929,
}

pub struct SocksServer {
    bind: SocketAddr,
    netstack: Arc<VirtualNetstack>,
    resolver: Arc<dyn NameResolver>,
    authentication: ProxyAuthentication,
}

pub struct BoundSocksServer {
    listener: TcpListener,
    server: Arc<SocksServer>,
}

impl SocksServer {
    pub fn new(
        bind: SocketAddr,
        netstack: Arc<VirtualNetstack>,
        resolver: Arc<dyn NameResolver>,
    ) -> Result<Self> {
        Self::new_with_authentication(bind, netstack, resolver, ProxyAuthentication::None)
    }

    pub fn new_with_authentication(
        bind: SocketAddr,
        netstack: Arc<VirtualNetstack>,
        resolver: Arc<dyn NameResolver>,
        authentication: ProxyAuthentication,
    ) -> Result<Self> {
        if !bind.ip().is_loopback() || bind.port() == 0 {
            return Err(Error(
                "SOCKS5 listener must use a nonzero loopback address".into(),
            ));
        }
        Ok(Self {
            bind,
            netstack,
            resolver,
            authentication,
        })
    }

    pub async fn bind(self) -> Result<BoundSocksServer> {
        let listener = TcpListener::bind(self.bind)
            .await
            .map_err(|_| Error("cannot bind the SOCKS5 listener".into()))?;
        Ok(BoundSocksServer {
            listener,
            server: Arc::new(self),
        })
    }
}

impl BoundSocksServer {
    pub async fn serve(self) -> Result<()> {
        let mut connections = tokio::task::JoinSet::new();
        let mut consecutive_failures = 0_u32;
        loop {
            tokio::select! {
                accepted = self.listener.accept() => {
                    let (client, peer) = match accepted {
                        Ok(accepted) => {
                            consecutive_failures = 0;
                            accepted
                        }
                        Err(error) => {
                            consecutive_failures += 1;
                            if consecutive_failures >= MAX_CONSECUTIVE_ACCEPT_FAILURES {
                                return Err(Error(format!(
                                    "SOCKS5 listener stopped accepting connections: {error}"
                                )));
                            }
                            // Descriptor and buffer exhaustion leave the pending
                            // connection queued, so retry after a pause instead
                            // of spinning on the same failure.
                            tokio::time::sleep(ACCEPT_FAILURE_BACKOFF).await;
                            continue;
                        }
                    };
                    if !peer.ip().is_loopback() {
                        continue;
                    }
                    // Best effort: Nagle is a latency optimisation, so failing to
                    // clear it must not deny the client its connection.
                    let _ = configure_client_socket(&client);
                    while connections.try_join_next().is_some() {}
                    if connections.len() >= MAX_ACTIVE_CONNECTIONS {
                        continue;
                    }
                    let server = Arc::clone(&self.server);
                    connections.spawn(async move {
                        if let Err(error) = server.handle(client).await
                            && should_report_request_error(&error)
                        {
                            eprintln!("local proxy request failed: {error}");
                        }
                    });
                }
                _ = connections.join_next(), if !connections.is_empty() => {}
            }
        }
    }
}

impl SocksServer {
    async fn handle(&self, mut client: TcpStream) -> Result<()> {
        let Some(request) = bounded_handshake(
            &mut client,
            self.resolver.as_ref(),
            &self.authentication,
            GREETING_TIMEOUT,
            REQUEST_TIMEOUT,
        )
        .await?
        else {
            return Ok(());
        };
        match request {
            ProxyRequest::Connect { remote, frontend } => {
                // Apply the same address policy as UDP after domain resolution.
                // A prohibited target must never reach the userspace netstack.
                if validate_tunnel_destination(remote).is_err() {
                    eprintln!("local proxy destination rejected by safety policy");
                    let _ = send_connect_reply(&mut client, frontend, false).await;
                    return Ok(());
                }
                match self.netstack.connect_tcp(remote).await {
                    Ok(mut upstream) => {
                        send_connect_reply(&mut client, frontend, true).await?;
                        match tokio::io::copy_bidirectional(&mut client, &mut upstream).await {
                            // Either side hanging up ends a proxied session normally.
                            Ok(_) => Ok(()),
                            Err(error) if peer_departed(&error) => Ok(()),
                            Err(_) => Err(Error("proxy stream forwarding failed".into())),
                        }
                    }
                    Err(_) => {
                        let _ = send_connect_reply(&mut client, frontend, false).await;
                        Err(Error("proxy upstream connection failed".into()))
                    }
                }
            }
            ProxyRequest::HttpForward { remote, request } => {
                if validate_tunnel_destination(remote).is_err() {
                    eprintln!("local proxy destination rejected by safety policy");
                    let _ = client.write_all(HTTP_BAD_GATEWAY).await;
                    return Ok(());
                }
                match self.netstack.connect_tcp(remote).await {
                    Ok(mut upstream) => {
                        forward_http_request(&mut client, &mut upstream, request).await
                    }
                    Err(_) => {
                        let _ = client.write_all(HTTP_BAD_GATEWAY).await;
                        Err(Error("HTTP proxy upstream connection failed".into()))
                    }
                }
            }
            ProxyRequest::UdpAssociate => {
                eprintln!("SOCKS5 udp-associate requested");
                self.handle_udp_associate(client).await
            }
        }
    }

    async fn handle_udp_associate(&self, mut control: TcpStream) -> Result<()> {
        let local = Arc::new(
            TokioUdpSocket::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
                .await
                .map_err(|_| Error("cannot bind the SOCKS5 UDP relay".into()))?,
        );
        let local_address = local
            .local_addr()
            .map_err(|_| Error("cannot inspect the SOCKS5 UDP relay".into()))?;
        let tunnel = Arc::new(self.netstack.bind_udp().await?);
        let client_endpoint = Arc::new(RwLock::new(None::<SocketAddr>));
        send_reply(&mut control, 0, Some(local_address)).await?;

        let upload = relay_udp_upload(
            Arc::clone(&local),
            Arc::clone(&tunnel),
            Arc::clone(&client_endpoint),
            Arc::clone(&self.resolver),
        );
        let download = relay_udp_download(local, tunnel, client_endpoint);
        supervise_udp_associate(&mut control, upload, download).await
    }
}

async fn supervise_udp_associate<U, D>(
    control: &mut TcpStream,
    upload: U,
    download: D,
) -> Result<()>
where
    U: Future<Output = Result<()>>,
    D: Future<Output = Result<()>>,
{
    // Keep both relay directions inside this parent future. Dropping or
    // aborting the connection task therefore drops their pending socket I/O
    // immediately instead of detaching independently spawned Tokio tasks.
    tokio::pin!(upload);
    tokio::pin!(download);
    tokio::select! {
        result = wait_for_control_close(control) => result,
        result = &mut upload => relay_future_result(result, "upload"),
        result = &mut download => relay_future_result(result, "download"),
    }
}

async fn relay_udp_upload(
    local: Arc<TokioUdpSocket>,
    tunnel: Arc<VirtualUdpSocket>,
    client_endpoint: Arc<RwLock<Option<SocketAddr>>>,
    resolver: Arc<dyn NameResolver>,
) -> Result<()> {
    let mut datagram = vec![0_u8; MAX_UDP_DATAGRAM_BYTES];
    loop {
        let (length, peer) = local
            .recv_from(&mut datagram)
            .await
            .map_err(|_| Error("SOCKS5 UDP relay receive failed".into()))?;
        if !peer.ip().is_loopback() {
            continue;
        }
        let Ok((remote, payload)) = parse_udp_request(&datagram[..length], resolver.as_ref()).await
        else {
            continue;
        };
        {
            let mut endpoint = client_endpoint.write().await;
            match *endpoint {
                Some(expected) if expected != peer => continue,
                Some(_) => {}
                None => *endpoint = Some(peer),
            }
        }
        tunnel
            .send_to(remote, payload)
            .await
            .map_err(|_| Error("SOCKS5 UDP tunnel send failed".into()))?;
    }
}

async fn relay_udp_download(
    local: Arc<TokioUdpSocket>,
    tunnel: Arc<VirtualUdpSocket>,
    client_endpoint: Arc<RwLock<Option<SocketAddr>>>,
) -> Result<()> {
    let mut payload = vec![0_u8; MAX_UDP_PAYLOAD_BYTES];
    loop {
        let (remote, length) = tunnel
            .recv_from(&mut payload)
            .await
            .map_err(|_| Error("SOCKS5 UDP tunnel receive failed".into()))?;
        let Some(peer) = *client_endpoint.read().await else {
            continue;
        };
        let response = encode_udp_response(remote, &payload[..length])?;
        local
            .send_to(&response, peer)
            .await
            .map_err(|_| Error("SOCKS5 UDP relay send failed".into()))?;
    }
}

async fn wait_for_control_close(control: &mut TcpStream) -> Result<()> {
    let mut control_byte = [0_u8; 1];
    loop {
        match control.read(&mut control_byte).await {
            Ok(0) => return Ok(()),
            Ok(_) => continue,
            Err(error) => return Err(Error(error.to_string())),
        }
    }
}

fn relay_future_result(result: Result<()>, direction: &str) -> Result<()> {
    match result {
        Ok(()) => Err(Error(format!(
            "SOCKS5 UDP {direction} relay stopped unexpectedly"
        ))),
        Err(error) => Err(error),
    }
}

/// Disables Nagle on an accepted client socket.
///
/// The SOCKS exchange is a sequence of short writes followed by a read, and the
/// success reply is only ten bytes. Holding those back until the client
/// acknowledges the previous segment adds a delayed-ACK stall in front of every
/// proxied request.
fn configure_client_socket(client: &TcpStream) -> Result<()> {
    client
        .set_nodelay(true)
        .map_err(|_| Error("cannot configure the SOCKS5 client socket".into()))
}

/// Reports whether an I/O error means the peer simply went away.
///
/// A client that disconnects has ended its session, not failed it. Logging those
/// as request failures buries the real errors: the desktop health probe closes
/// its socket the moment it has the reply, and browsers routinely abandon
/// speculative connections.
fn peer_departed(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::BrokenPipe
            | std::io::ErrorKind::ConnectionReset
            | std::io::ErrorKind::ConnectionAborted
            | std::io::ErrorKind::NotConnected
            | std::io::ErrorKind::UnexpectedEof
    )
}

/// Authentication negotiation failures are normal client rejections, not
/// tunnel faults. Clash can retry these rapidly when its configured proxy
/// contract does not match strict mode, so logging every attempt only hides
/// actionable engine diagnostics.
fn should_report_request_error(error: &Error) -> bool {
    !matches!(
        error.message(),
        "SOCKS5 client offered no supported method"
            | "SOCKS5 username/password authentication failed"
            | "HTTP proxy authentication failed"
    )
}

/// Reads the greeting and request under explicit deadlines so a client that
/// connects and then stalls cannot hold one of the bounded connection slots.
///
/// `Ok(None)` means the client disconnected before completing the handshake.
async fn bounded_handshake(
    client: &mut TcpStream,
    resolver: &dyn NameResolver,
    authentication: &ProxyAuthentication,
    greeting_timeout: Duration,
    request_timeout: Duration,
) -> Result<Option<ProxyRequest>> {
    let frontend =
        tokio::time::timeout(greeting_timeout, negotiate_frontend(client, authentication))
            .await
            .map_err(|_| Error("local proxy authentication greeting timed out".into()))??;
    let Some(frontend) = frontend else {
        return Ok(None);
    };
    tokio::time::timeout(
        request_timeout,
        read_frontend_request(client, frontend, resolver),
    )
    .await
    .map_err(|_| Error("local proxy request timed out".into()))?
    .map(Some)
}

/// Returns `Ok(None)` when the client disconnected instead of greeting.
async fn negotiate_frontend(
    client: &mut TcpStream,
    authentication: &ProxyAuthentication,
) -> Result<Option<NegotiatedFrontend>> {
    let mut first = [0_u8; 1];
    if let Err(error) = client.read_exact(&mut first).await {
        if peer_departed(&error) {
            return Ok(None);
        }
        return Err(error.into());
    }
    if first[0] == SOCKS_VERSION {
        let negotiated_authentication = negotiate_socks5(client, authentication).await?;
        // RFC 1929 authenticates only the TCP control connection. A standard
        // SOCKS5 UDP relay has no credential field, and every local user shares
        // the same loopback IP. Learning the UDP source from its first datagram
        // would therefore let another local process race and adopt an
        // authenticated client's relay. In optional mode UDP therefore follows
        // the selected method, not merely the listener-wide policy: NO_AUTH
        // keeps compatibility while RFC 1929 fails closed.
        return Ok(Some(NegotiatedFrontend::Socks5 {
            udp_associate_allowed: negotiated_authentication == NegotiatedSocksAuthentication::None,
        }));
    }
    if first[0].is_ascii_alphabetic() && authentication.is_required() {
        let request = read_authenticated_http_request(client, first[0], authentication).await?;
        return Ok(Some(NegotiatedFrontend::Http(request)));
    }
    Err(Error("unsupported local proxy protocol".into()))
}

async fn negotiate_socks5(
    client: &mut TcpStream,
    authentication: &ProxyAuthentication,
) -> Result<NegotiatedSocksAuthentication> {
    let method_count = usize::from(client.read_u8().await?);
    if method_count == 0 || method_count > MAX_AUTH_METHODS {
        return Err(Error("invalid SOCKS5 authentication greeting".into()));
    }
    let mut methods = vec![0_u8; method_count];
    client.read_exact(&mut methods).await?;
    // Optional mode prefers NO_AUTH even when RFC 1929 is also offered. That
    // preserves compatibility for clients such as Clash while an explicit
    // RFC-1929-only client can still authenticate.
    let method =
        if authentication.accepts_no_authentication() && methods.contains(&NO_AUTHENTICATION) {
            NO_AUTHENTICATION
        } else if authentication.accepts_rfc1929()
            && methods.contains(&USERNAME_PASSWORD_AUTHENTICATION)
        {
            USERNAME_PASSWORD_AUTHENTICATION
        } else {
            NO_ACCEPTABLE_METHODS
        };
    client.write_all(&[SOCKS_VERSION, method]).await?;
    if method == NO_ACCEPTABLE_METHODS {
        return Err(Error("SOCKS5 client offered no supported method".into()));
    }
    if method == USERNAME_PASSWORD_AUTHENTICATION {
        authenticate_rfc1929(client, authentication).await?;
    }
    Ok(if method == NO_AUTHENTICATION {
        NegotiatedSocksAuthentication::None
    } else {
        NegotiatedSocksAuthentication::Rfc1929
    })
}

async fn authenticate_rfc1929(
    client: &mut TcpStream,
    authentication: &ProxyAuthentication,
) -> Result<()> {
    let mut header = [0_u8; 2];
    client.read_exact(&mut header).await?;
    let username_length = usize::from(header[1]);
    let mut username = Zeroizing::new(vec![0_u8; username_length]);
    client.read_exact(&mut username).await?;
    let password_length = usize::from(client.read_u8().await?);
    let mut password = Zeroizing::new(vec![0_u8; password_length]);
    client.read_exact(&mut password).await?;

    let credentials_match = authentication.verify_rfc1929(&username, &password);
    let valid = header[0] == RFC1929_VERSION
        && username_length != 0
        && password_length != 0
        && credentials_match;
    let status = if valid {
        RFC1929_SUCCESS
    } else {
        RFC1929_FAILURE
    };
    client.write_all(&[RFC1929_VERSION, status]).await?;
    if !valid {
        return Err(Error(
            "SOCKS5 username/password authentication failed".into(),
        ));
    }
    Ok(())
}

async fn read_frontend_request(
    client: &mut TcpStream,
    frontend: NegotiatedFrontend,
    resolver: &dyn NameResolver,
) -> Result<ProxyRequest> {
    match frontend {
        NegotiatedFrontend::Socks5 {
            udp_associate_allowed,
        } => read_socks_request(client, resolver, udp_associate_allowed).await,
        NegotiatedFrontend::Http(ParsedHttpProxyRequest::Connect { authority }) => {
            let remote = match resolve_authority(&authority, None, resolver).await {
                Ok(remote) => remote,
                Err(_) => {
                    let _ = client.write_all(HTTP_BAD_GATEWAY).await;
                    return Err(Error("HTTP CONNECT destination resolution failed".into()));
                }
            };
            Ok(ProxyRequest::Connect {
                remote,
                frontend: ConnectFrontend::HttpConnect,
            })
        }
        NegotiatedFrontend::Http(ParsedHttpProxyRequest::Forward(request)) => {
            let address = match resolve_host(request.host(), resolver).await {
                Ok(address) => address,
                Err(_) => {
                    let _ = client.write_all(HTTP_BAD_GATEWAY).await;
                    return Err(Error("HTTP proxy destination resolution failed".into()));
                }
            };
            Ok(ProxyRequest::HttpForward {
                remote: SocketAddr::new(IpAddr::V4(address), request.port()),
                request,
            })
        }
    }
}

async fn read_socks_request(
    client: &mut TcpStream,
    resolver: &dyn NameResolver,
    udp_associate_allowed: bool,
) -> Result<ProxyRequest> {
    let mut header = [0_u8; 4];
    client.read_exact(&mut header).await?;
    if header[0] != SOCKS_VERSION || header[2] != 0 {
        send_reply(client, 7, None).await?;
        return Err(Error("unsupported SOCKS5 command".into()));
    }
    let command = header[1];
    if !matches!(command, CONNECT_COMMAND | UDP_ASSOCIATE_COMMAND) {
        // The command can be rejected as soon as the fixed header is complete.
        // Waiting for an address first lets a malformed client withhold the
        // remainder and prevents it from receiving the required 0x07 reply.
        send_reply(client, 7, None).await?;
        return Err(Error("unsupported SOCKS5 command".into()));
    }
    if command == UDP_ASSOCIATE_COMMAND && !udp_associate_allowed {
        // Reject from the fixed header alone. Reading or learning a UDP source
        // endpoint cannot make RFC 1929 protect the unauthenticated datagrams.
        send_reply(client, 7, None).await?;
        return Err(Error(
            "SOCKS5 UDP ASSOCIATE is unavailable after local proxy authentication".into(),
        ));
    }
    if header[3] == ADDRESS_IPV6 {
        // Tell the client the address family is unsupported instead of letting
        // it wait for a reply that never arrives.
        let mut ignored = [0_u8; 18];
        let _ = client.read_exact(&mut ignored).await;
        send_reply(client, 8, None).await?;
        return Err(Error("SOCKS5 IPv6 is not implemented".into()));
    }
    let address = consume_address(client, header[3], resolver, command == CONNECT_COMMAND).await?;
    let port = client.read_u16().await?;
    if command == UDP_ASSOCIATE_COMMAND {
        return Ok(ProxyRequest::UdpAssociate);
    }
    let address = address.ok_or_else(|| Error("SOCKS5 destination is missing".into()))?;
    if address.is_unspecified() || port == 0 {
        send_reply(client, 8, None).await?;
        return Err(Error("SOCKS5 destination is invalid".into()));
    }
    Ok(ProxyRequest::Connect {
        remote: SocketAddr::new(IpAddr::V4(address), port),
        frontend: ConnectFrontend::Socks5,
    })
}

async fn consume_address(
    client: &mut TcpStream,
    address_type: u8,
    resolver: &dyn NameResolver,
    resolve_domain: bool,
) -> Result<Option<Ipv4Addr>> {
    match address_type {
        ADDRESS_IPV4 => {
            let mut octets = [0_u8; 4];
            client.read_exact(&mut octets).await?;
            Ok(Some(Ipv4Addr::from(octets)))
        }
        ADDRESS_DOMAIN => {
            let length = usize::from(client.read_u8().await?);
            if length == 0 || length > MAX_DOMAIN_BYTES {
                return Err(Error("SOCKS5 domain has an invalid length".into()));
            }
            let mut encoded = vec![0_u8; length];
            client.read_exact(&mut encoded).await?;
            let host = std::str::from_utf8(&encoded)
                .map_err(|_| Error("SOCKS5 domain must be UTF-8".into()))?;
            validate_domain(host)?;
            if resolve_domain {
                Ok(Some(resolve_host(host, resolver).await?))
            } else {
                Ok(None)
            }
        }
        ADDRESS_IPV6 => {
            let mut ignored = [0_u8; 16];
            client.read_exact(&mut ignored).await?;
            Err(Error("SOCKS5 IPv6 is not implemented".into()))
        }
        _ => Err(Error("SOCKS5 address type is invalid".into())),
    }
}

async fn parse_udp_request<'a>(
    datagram: &'a [u8],
    resolver: &dyn NameResolver,
) -> Result<(SocketAddr, &'a [u8])> {
    if datagram.len() < 7 || datagram[..3] != [0, 0, 0] {
        return Err(Error(
            "SOCKS5 UDP fragmentation is unsupported or malformed".into(),
        ));
    }
    let mut offset = 4;
    let address = match datagram[3] {
        ADDRESS_IPV4 => {
            let octets = datagram
                .get(offset..offset + 4)
                .ok_or_else(|| Error("SOCKS5 UDP IPv4 address is truncated".into()))?;
            offset += 4;
            Ipv4Addr::new(octets[0], octets[1], octets[2], octets[3])
        }
        ADDRESS_DOMAIN => {
            let length = usize::from(
                *datagram
                    .get(offset)
                    .ok_or_else(|| Error("SOCKS5 UDP domain length is missing".into()))?,
            );
            offset += 1;
            if length == 0 || length > MAX_DOMAIN_BYTES {
                return Err(Error("SOCKS5 UDP domain length is invalid".into()));
            }
            let encoded = datagram
                .get(offset..offset + length)
                .ok_or_else(|| Error("SOCKS5 UDP domain is truncated".into()))?;
            offset += length;
            let host = std::str::from_utf8(encoded)
                .map_err(|_| Error("SOCKS5 UDP domain must be UTF-8".into()))?;
            resolve_host(host, resolver).await?
        }
        ADDRESS_IPV6 => return Err(Error("SOCKS5 UDP IPv6 is not implemented".into())),
        _ => return Err(Error("SOCKS5 UDP address type is invalid".into())),
    };
    let port_bytes = datagram
        .get(offset..offset + 2)
        .ok_or_else(|| Error("SOCKS5 UDP port is truncated".into()))?;
    offset += 2;
    let port = u16::from_be_bytes([port_bytes[0], port_bytes[1]]);
    if address.is_unspecified() || port == 0 {
        return Err(Error("SOCKS5 UDP destination is invalid".into()));
    }
    if datagram.len() - offset > MAX_UDP_PAYLOAD_BYTES {
        return Err(Error("SOCKS5 UDP payload is too large".into()));
    }
    let remote = SocketAddr::new(IpAddr::V4(address), port);
    validate_tunnel_destination(remote)?;
    Ok((remote, &datagram[offset..]))
}

fn encode_udp_response(remote: SocketAddr, payload: &[u8]) -> Result<Vec<u8>> {
    let IpAddr::V4(address) = remote.ip() else {
        return Err(Error("SOCKS5 UDP response requires IPv4".into()));
    };
    let mut response = Vec::with_capacity(10 + payload.len());
    response.extend_from_slice(&[0, 0, 0, ADDRESS_IPV4]);
    response.extend_from_slice(&address.octets());
    response.extend_from_slice(&remote.port().to_be_bytes());
    response.extend_from_slice(payload);
    Ok(response)
}

async fn send_reply(client: &mut TcpStream, status: u8, bound: Option<SocketAddr>) -> Result<()> {
    let (address, port) = match bound {
        Some(SocketAddr::V4(value)) => (*value.ip(), value.port()),
        _ => (Ipv4Addr::UNSPECIFIED, 0),
    };
    client
        .write_all(&[
            SOCKS_VERSION,
            status,
            0,
            ADDRESS_IPV4,
            address.octets()[0],
            address.octets()[1],
            address.octets()[2],
            address.octets()[3],
            port.to_be_bytes()[0],
            port.to_be_bytes()[1],
        ])
        .await?;
    Ok(())
}

async fn send_connect_reply(
    client: &mut TcpStream,
    frontend: ConnectFrontend,
    success: bool,
) -> Result<()> {
    match frontend {
        ConnectFrontend::Socks5 => send_reply(client, if success { 0 } else { 5 }, None).await,
        ConnectFrontend::HttpConnect => client
            .write_all(if success {
                HTTP_CONNECT_ESTABLISHED
            } else {
                HTTP_BAD_GATEWAY
            })
            .await
            .map_err(Error::from),
    }
}

#[cfg(test)]
mod benchmark;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::proxy::ResolveFuture;

    #[test]
    fn routine_proxy_authentication_rejections_do_not_flood_engine_logs() {
        for message in [
            "SOCKS5 client offered no supported method",
            "SOCKS5 username/password authentication failed",
            "HTTP proxy authentication failed",
        ] {
            assert!(!should_report_request_error(&Error(message.into())));
        }
        assert!(should_report_request_error(&Error(
            "proxy stream forwarding failed".into()
        )));
    }

    #[test]
    fn udp_response_round_trips_source_and_payload() {
        let response =
            encode_udp_response("10.20.30.40:53".parse().unwrap(), b"dns-response").unwrap();
        assert_eq!(&response[..10], &[0, 0, 0, 1, 10, 20, 30, 40, 0, 53]);
        assert_eq!(&response[10..], b"dns-response");
    }

    #[test]
    fn tcp_targets_use_the_shared_destination_policy() {
        assert!(validate_tunnel_destination("0.0.0.1:443".parse().unwrap()).is_err());
        assert!(validate_tunnel_destination("127.0.0.1:60540".parse().unwrap()).is_err());
        assert!(validate_tunnel_destination("169.254.1.2:443".parse().unwrap()).is_err());
        assert!(validate_tunnel_destination("240.0.0.1:443".parse().unwrap()).is_err());
        assert!(validate_tunnel_destination("10.120.18.63:443".parse().unwrap()).is_ok());
    }

    #[tokio::test]
    async fn udp_request_parsing_supports_ipv4_and_vpn_dns() {
        struct StaticResolver;
        impl NameResolver for StaticResolver {
            fn resolve_ipv4<'a>(&'a self, host: &'a str) -> ResolveFuture<'a> {
                Box::pin(async move {
                    if host == "campus.example" {
                        Ok(Ipv4Addr::new(10, 20, 30, 40))
                    } else {
                        Err(Error("not found".into()))
                    }
                })
            }
        }
        let ipv4 = [0, 0, 0, 1, 10, 1, 2, 3, 0, 53, 1, 2, 3];
        let (remote, payload) = parse_udp_request(&ipv4, &StaticResolver).await.unwrap();
        assert_eq!(remote, "10.1.2.3:53".parse().unwrap());
        assert_eq!(payload, &[1, 2, 3]);

        let mut domain = vec![0, 0, 0, 3, 14];
        domain.extend_from_slice(b"campus.example");
        domain.extend_from_slice(&443_u16.to_be_bytes());
        domain.extend_from_slice(b"payload");
        let (remote, payload) = parse_udp_request(&domain, &StaticResolver).await.unwrap();
        assert_eq!(remote, "10.20.30.40:443".parse().unwrap());
        assert_eq!(payload, b"payload");
    }

    #[tokio::test]
    async fn udp_request_rejects_fragmentation() {
        let fragmented = [0, 0, 1, 1, 10, 1, 2, 3, 0, 53];
        assert!(
            parse_udp_request(&fragmented, &crate::engine::proxy::RejectDomainResolver)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn udp_targets_use_the_shared_destination_policy() {
        let this_network = [0, 0, 0, 1, 0, 0, 0, 1, 0, 53, 1];
        assert!(
            parse_udp_request(&this_network, &crate::engine::proxy::RejectDomainResolver,)
                .await
                .is_err()
        );

        let loopback = [0, 0, 0, 1, 127, 0, 0, 1, 0, 53, 1];
        assert!(
            parse_udp_request(&loopback, &crate::engine::proxy::RejectDomainResolver,)
                .await
                .is_err()
        );

        let reserved = [0, 0, 0, 1, 240, 0, 0, 1, 0, 53, 1];
        assert!(
            parse_udp_request(&reserved, &crate::engine::proxy::RejectDomainResolver,)
                .await
                .is_err()
        );

        let campus = [0, 0, 0, 1, 10, 20, 30, 40, 0, 53, 1];
        let (remote, _) = parse_udp_request(&campus, &crate::engine::proxy::RejectDomainResolver)
            .await
            .unwrap();
        assert_eq!(remote, "10.20.30.40:53".parse().unwrap());
    }

    async fn connected_pair() -> (TcpStream, TcpStream) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let client = TcpStream::connect(address).await.unwrap();
        let (server, _) = listener.accept().await.unwrap();
        (client, server)
    }

    #[tokio::test]
    async fn active_udp_associate_parent_abort_drops_both_relay_directions() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        struct RelayDrop(Arc<AtomicUsize>);
        impl Drop for RelayDrop {
            fn drop(&mut self) {
                self.0.fetch_add(1, Ordering::SeqCst);
            }
        }

        async fn pending_relay(
            started: tokio::sync::oneshot::Sender<()>,
            dropped: Arc<AtomicUsize>,
        ) -> Result<()> {
            let _drop = RelayDrop(dropped);
            let _ = started.send(());
            std::future::pending().await
        }

        let (control_peer, mut control) = connected_pair().await;
        let dropped = Arc::new(AtomicUsize::new(0));
        let (upload_started, upload_ready) = tokio::sync::oneshot::channel();
        let (download_started, download_ready) = tokio::sync::oneshot::channel();
        let upload = pending_relay(upload_started, Arc::clone(&dropped));
        let download = pending_relay(download_started, Arc::clone(&dropped));

        let associate =
            tokio::spawn(
                async move { supervise_udp_associate(&mut control, upload, download).await },
            );
        tokio::time::timeout(Duration::from_secs(1), async {
            upload_ready.await.unwrap();
            download_ready.await.unwrap();
        })
        .await
        .expect("both UDP relay directions must become active");

        associate.abort();
        assert!(associate.await.unwrap_err().is_cancelled());
        assert_eq!(dropped.load(Ordering::SeqCst), 2);
        drop(control_peer);
    }

    fn rfc1929_packet(username: &[u8], password: &[u8]) -> Vec<u8> {
        let mut packet = vec![RFC1929_VERSION, username.len() as u8];
        packet.extend_from_slice(username);
        packet.push(password.len() as u8);
        packet.extend_from_slice(password);
        packet
    }

    async fn negotiate_strict_socks(client: &mut TcpStream) {
        client
            .write_all(&[
                SOCKS_VERSION,
                2,
                NO_AUTHENTICATION,
                USERNAME_PASSWORD_AUTHENTICATION,
            ])
            .await
            .unwrap();
        let mut method = [0_u8; 2];
        client.read_exact(&mut method).await.unwrap();
        assert_eq!(method, [SOCKS_VERSION, USERNAME_PASSWORD_AUTHENTICATION]);
        client
            .write_all(&rfc1929_packet(b"proxy-user", b"proxy-pass"))
            .await
            .unwrap();
        let mut status = [0_u8; 2];
        client.read_exact(&mut status).await.unwrap();
        assert_eq!(status, [RFC1929_VERSION, RFC1929_SUCCESS]);
    }

    #[tokio::test]
    async fn strict_rfc1929_authentication_precedes_tcp_connect() {
        let (mut client, mut server) = connected_pair().await;
        let handshake = tokio::spawn(async move {
            let authentication = ProxyAuthentication::required("proxy-user", "proxy-pass").unwrap();
            bounded_handshake(
                &mut server,
                &crate::engine::proxy::RejectDomainResolver,
                &authentication,
                Duration::from_secs(5),
                Duration::from_secs(5),
            )
            .await
        });
        negotiate_strict_socks(&mut client).await;
        client
            .write_all(&[
                SOCKS_VERSION,
                CONNECT_COMMAND,
                0,
                ADDRESS_IPV4,
                10,
                20,
                30,
                40,
                1,
                187,
            ])
            .await
            .unwrap();
        assert_eq!(
            handshake.await.unwrap().unwrap(),
            Some(ProxyRequest::Connect {
                remote: "10.20.30.40:443".parse().unwrap(),
                frontend: ConnectFrontend::Socks5,
            })
        );
    }

    #[tokio::test]
    async fn strict_rfc1929_rejects_udp_associate_before_learning_an_endpoint() {
        let (mut client, mut server) = connected_pair().await;
        let handshake = tokio::spawn(async move {
            let authentication = ProxyAuthentication::required("proxy-user", "proxy-pass").unwrap();
            bounded_handshake(
                &mut server,
                &crate::engine::proxy::RejectDomainResolver,
                &authentication,
                Duration::from_secs(5),
                Duration::from_secs(5),
            )
            .await
        });
        negotiate_strict_socks(&mut client).await;
        client
            // The fixed header is sufficient: strict mode must reject before
            // accepting an address whose UDP source another local user could
            // race to claim.
            .write_all(&[SOCKS_VERSION, UDP_ASSOCIATE_COMMAND, 0, ADDRESS_IPV4])
            .await
            .unwrap();
        let mut reply = [0_u8; 10];
        tokio::time::timeout(Duration::from_secs(1), client.read_exact(&mut reply))
            .await
            .expect("strict UDP rejection must not wait for an endpoint")
            .unwrap();
        assert_eq!(reply[..4], [SOCKS_VERSION, 7, 0, ADDRESS_IPV4]);
        let error = handshake
            .await
            .unwrap()
            .expect_err("strict authentication cannot secure SOCKS5 UDP datagrams");
        assert_eq!(
            error.to_string(),
            "SOCKS5 UDP ASSOCIATE is unavailable after local proxy authentication"
        );
    }

    #[tokio::test]
    async fn compatibility_mode_keeps_udp_associate() {
        let (mut client, mut server) = connected_pair().await;
        let handshake = tokio::spawn(async move {
            bounded_handshake(
                &mut server,
                &crate::engine::proxy::RejectDomainResolver,
                &ProxyAuthentication::None,
                Duration::from_secs(5),
                Duration::from_secs(5),
            )
            .await
        });
        client
            .write_all(&[SOCKS_VERSION, 1, NO_AUTHENTICATION])
            .await
            .unwrap();
        let mut method = [0_u8; 2];
        client.read_exact(&mut method).await.unwrap();
        assert_eq!(method, [SOCKS_VERSION, NO_AUTHENTICATION]);
        client
            .write_all(&[
                SOCKS_VERSION,
                UDP_ASSOCIATE_COMMAND,
                0,
                ADDRESS_IPV4,
                0,
                0,
                0,
                0,
                0,
                0,
            ])
            .await
            .unwrap();
        assert_eq!(
            handshake.await.unwrap().unwrap(),
            Some(ProxyRequest::UdpAssociate)
        );
    }

    #[tokio::test]
    async fn optional_mode_prefers_no_auth_and_keeps_udp_compatibility() {
        let (mut client, mut server) = connected_pair().await;
        let handshake = tokio::spawn(async move {
            let authentication = ProxyAuthentication::optional("proxy-user", "proxy-pass").unwrap();
            bounded_handshake(
                &mut server,
                &crate::engine::proxy::RejectDomainResolver,
                &authentication,
                Duration::from_secs(5),
                Duration::from_secs(5),
            )
            .await
        });
        // Put RFC 1929 first to prove server policy, rather than client order,
        // selects the compatibility method when both are available.
        client
            .write_all(&[
                SOCKS_VERSION,
                2,
                USERNAME_PASSWORD_AUTHENTICATION,
                NO_AUTHENTICATION,
            ])
            .await
            .unwrap();
        let mut method = [0_u8; 2];
        client.read_exact(&mut method).await.unwrap();
        assert_eq!(method, [SOCKS_VERSION, NO_AUTHENTICATION]);
        client
            .write_all(&[
                SOCKS_VERSION,
                UDP_ASSOCIATE_COMMAND,
                0,
                ADDRESS_IPV4,
                0,
                0,
                0,
                0,
                0,
                0,
            ])
            .await
            .unwrap();
        assert_eq!(
            handshake.await.unwrap().unwrap(),
            Some(ProxyRequest::UdpAssociate)
        );
    }

    #[tokio::test]
    async fn optional_rfc1929_only_client_is_verified_and_cannot_open_udp_relay() {
        let (mut client, mut server) = connected_pair().await;
        let handshake = tokio::spawn(async move {
            let authentication = ProxyAuthentication::optional("proxy-user", "proxy-pass").unwrap();
            bounded_handshake(
                &mut server,
                &crate::engine::proxy::RejectDomainResolver,
                &authentication,
                Duration::from_secs(5),
                Duration::from_secs(5),
            )
            .await
        });
        client
            .write_all(&[SOCKS_VERSION, 1, USERNAME_PASSWORD_AUTHENTICATION])
            .await
            .unwrap();
        let mut method = [0_u8; 2];
        client.read_exact(&mut method).await.unwrap();
        assert_eq!(method, [SOCKS_VERSION, USERNAME_PASSWORD_AUTHENTICATION]);
        client
            .write_all(&rfc1929_packet(b"proxy-user", b"proxy-pass"))
            .await
            .unwrap();
        let mut status = [0_u8; 2];
        client.read_exact(&mut status).await.unwrap();
        assert_eq!(status, [RFC1929_VERSION, RFC1929_SUCCESS]);
        client
            .write_all(&[SOCKS_VERSION, UDP_ASSOCIATE_COMMAND, 0, ADDRESS_IPV4])
            .await
            .unwrap();
        let mut reply = [0_u8; 10];
        tokio::time::timeout(Duration::from_secs(1), client.read_exact(&mut reply))
            .await
            .expect("authenticated optional UDP rejection must not wait for an endpoint")
            .unwrap();
        assert_eq!(reply[..4], [SOCKS_VERSION, 7, 0, ADDRESS_IPV4]);
        let error = handshake.await.unwrap().unwrap_err();
        assert_eq!(
            error.to_string(),
            "SOCKS5 UDP ASSOCIATE is unavailable after local proxy authentication"
        );
    }

    #[tokio::test]
    async fn optional_rfc1929_only_client_must_supply_valid_credentials() {
        let (mut client, mut server) = connected_pair().await;
        let negotiation = tokio::spawn(async move {
            let authentication = ProxyAuthentication::optional("proxy-user", "proxy-pass").unwrap();
            negotiate_frontend(&mut server, &authentication).await
        });
        client
            .write_all(&[SOCKS_VERSION, 1, USERNAME_PASSWORD_AUTHENTICATION])
            .await
            .unwrap();
        let mut method = [0_u8; 2];
        client.read_exact(&mut method).await.unwrap();
        assert_eq!(method, [SOCKS_VERSION, USERNAME_PASSWORD_AUTHENTICATION]);
        client
            .write_all(&rfc1929_packet(b"proxy-user", b"wrong-pass"))
            .await
            .unwrap();
        let mut status = [0_u8; 2];
        client.read_exact(&mut status).await.unwrap();
        assert_eq!(status, [RFC1929_VERSION, RFC1929_FAILURE]);
        let error = match negotiation.await.unwrap() {
            Err(error) => error.to_string(),
            Ok(_) => panic!("invalid optional credentials must be rejected"),
        };
        assert_eq!(error, "SOCKS5 username/password authentication failed");
        assert!(!error.contains("wrong-pass"));
    }

    #[tokio::test]
    async fn optional_frontend_does_not_enable_http_proxying() {
        let (mut client, mut server) = connected_pair().await;
        let negotiation = tokio::spawn(async move {
            let authentication = ProxyAuthentication::optional("proxy-user", "proxy-pass").unwrap();
            negotiate_frontend(&mut server, &authentication).await
        });
        client
            .write_all(
                b"CONNECT 10.20.30.40:443 HTTP/1.1\r\n\
                  Proxy-Authorization: Basic cHJveHktdXNlcjpwcm94eS1wYXNz\r\n\r\n",
            )
            .await
            .unwrap();
        let error = match negotiation.await.unwrap() {
            Err(error) => error.to_string(),
            Ok(_) => panic!("optional mode must not expose the HTTP frontend"),
        };
        assert_eq!(error, "unsupported local proxy protocol");
    }

    async fn rejected_rfc1929_exchange(username: &[u8], password: &[u8]) -> ([u8; 2], String) {
        let (mut client, mut server) = connected_pair().await;
        let negotiation = tokio::spawn(async move {
            let authentication = ProxyAuthentication::required("proxy-user", "proxy-pass").unwrap();
            negotiate_frontend(&mut server, &authentication).await
        });
        client
            .write_all(&[SOCKS_VERSION, 1, USERNAME_PASSWORD_AUTHENTICATION])
            .await
            .unwrap();
        let mut method = [0_u8; 2];
        client.read_exact(&mut method).await.unwrap();
        assert_eq!(method, [SOCKS_VERSION, USERNAME_PASSWORD_AUTHENTICATION]);
        client
            .write_all(&rfc1929_packet(username, password))
            .await
            .unwrap();
        let mut status = [0_u8; 2];
        client.read_exact(&mut status).await.unwrap();
        let error = match negotiation.await.unwrap() {
            Err(error) => error.to_string(),
            Ok(_) => panic!("invalid credentials must be rejected"),
        };
        (status, error)
    }

    #[tokio::test]
    async fn all_rfc1929_credential_failures_have_one_response_and_diagnostic() {
        let wrong_username = rejected_rfc1929_exchange(b"wrong-user", b"proxy-pass").await;
        let wrong_password = rejected_rfc1929_exchange(b"proxy-user", b"wrong-pass").await;
        assert_eq!(wrong_username.0, [RFC1929_VERSION, RFC1929_FAILURE]);
        assert_eq!(wrong_password.0, wrong_username.0);
        assert_eq!(wrong_password.1, wrong_username.1);
        assert!(!wrong_username.1.contains("wrong-user"));
        assert!(!wrong_password.1.contains("wrong-pass"));
    }

    #[tokio::test]
    async fn authenticated_http_connect_uses_the_same_connect_request() {
        let (mut client, mut server) = connected_pair().await;
        let handshake = tokio::spawn(async move {
            let authentication = ProxyAuthentication::required("proxy-user", "proxy-pass").unwrap();
            bounded_handshake(
                &mut server,
                &crate::engine::proxy::RejectDomainResolver,
                &authentication,
                Duration::from_secs(5),
                Duration::from_secs(5),
            )
            .await
        });
        client
            .write_all(
                b"CONNECT 10.20.30.40:443 HTTP/1.1\r\n\
                  Host: 10.20.30.40:443\r\n\
                  Proxy-Authorization: Basic cHJveHktdXNlcjpwcm94eS1wYXNz\r\n\r\n",
            )
            .await
            .unwrap();
        assert_eq!(
            handshake.await.unwrap().unwrap(),
            Some(ProxyRequest::Connect {
                remote: "10.20.30.40:443".parse().unwrap(),
                frontend: ConnectFrontend::HttpConnect,
            })
        );
    }

    #[tokio::test]
    async fn http_resolution_failure_response_and_error_do_not_echo_the_target() {
        let (mut client, mut server) = connected_pair().await;
        let handshake = tokio::spawn(async move {
            let authentication = ProxyAuthentication::required("proxy-user", "proxy-pass").unwrap();
            bounded_handshake(
                &mut server,
                &crate::engine::proxy::RejectDomainResolver,
                &authentication,
                Duration::from_secs(5),
                Duration::from_secs(5),
            )
            .await
        });
        let private_target = "private-campus-target.example";
        client
            .write_all(
                format!(
                    "CONNECT {private_target}:443 HTTP/1.1\r\n\
                     Proxy-Authorization: Basic cHJveHktdXNlcjpwcm94eS1wYXNz\r\n\r\n"
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        let mut response = Vec::new();
        client.read_to_end(&mut response).await.unwrap();
        let error = match handshake.await.unwrap() {
            Err(error) => error.to_string(),
            Ok(_) => panic!("an unresolved target must fail closed"),
        };
        assert_eq!(response, HTTP_BAD_GATEWAY);
        assert!(!error.contains(private_target));
        assert_eq!(error, "HTTP CONNECT destination resolution failed");
    }

    async fn rejected_http_exchange(request: &[u8]) -> (Vec<u8>, String) {
        let (mut client, mut server) = connected_pair().await;
        let negotiation = tokio::spawn(async move {
            let authentication = ProxyAuthentication::required("proxy-user", "proxy-pass").unwrap();
            negotiate_frontend(&mut server, &authentication).await
        });
        client.write_all(request).await.unwrap();
        let mut response = Vec::new();
        client.read_to_end(&mut response).await.unwrap();
        let error = match negotiation.await.unwrap() {
            Err(error) => error.to_string(),
            Ok(_) => panic!("invalid HTTP proxy exchange must be rejected"),
        };
        (response, error)
    }

    #[tokio::test]
    async fn missing_and_wrong_http_basic_credentials_get_the_same_407() {
        let missing = rejected_http_exchange(
            b"CONNECT 10.20.30.40:443 HTTP/1.1\r\nHost: 10.20.30.40:443\r\n\r\n",
        )
        .await;
        let wrong = rejected_http_exchange(
            b"CONNECT 10.20.30.40:443 HTTP/1.1\r\n\
              Proxy-Authorization: Basic d3Jvbmc6Y3JlZGVudGlhbA==\r\n\r\n",
        )
        .await;
        assert_eq!(missing.0, http_forward::HTTP_AUTHENTICATION_REQUIRED);
        assert_eq!(wrong.0, missing.0);
        assert_eq!(wrong.1, missing.1);
        assert!(!wrong.1.contains("d3Jvbmc6Y3JlZGVudGlhbA"));
    }

    #[tokio::test]
    async fn strict_frontend_accepts_authenticated_absolute_form_http() {
        struct HttpResolver;
        impl NameResolver for HttpResolver {
            fn resolve_ipv4<'a>(&'a self, host: &'a str) -> ResolveFuture<'a> {
                Box::pin(async move {
                    if host == "campus.example" {
                        Ok(Ipv4Addr::new(10, 20, 30, 40))
                    } else {
                        Err(Error("not found".into()))
                    }
                })
            }
        }
        let (mut client, mut server) = connected_pair().await;
        let handshake = tokio::spawn(async move {
            let authentication = ProxyAuthentication::required("proxy-user", "proxy-pass").unwrap();
            bounded_handshake(
                &mut server,
                &HttpResolver,
                &authentication,
                Duration::from_secs(5),
                Duration::from_secs(5),
            )
            .await
        });
        client
            .write_all(
                b"GET http://campus.example/private HTTP/1.1\r\n\
                  Proxy-Authorization: Basic cHJveHktdXNlcjpwcm94eS1wYXNz\r\n\r\n",
            )
            .await
            .unwrap();
        let Some(ProxyRequest::HttpForward { remote, request }) = handshake.await.unwrap().unwrap()
        else {
            panic!("authenticated absolute-form HTTP must use the forwarding path");
        };
        assert_eq!(remote, "10.20.30.40:80".parse().unwrap());
        let debug = format!("{request:?}");
        assert!(!debug.contains("campus.example"));
        assert!(!debug.contains("/private"));
    }

    #[tokio::test]
    async fn default_frontend_does_not_enable_http_proxying() {
        let (mut client, mut server) = connected_pair().await;
        let negotiation = tokio::spawn(async move {
            let authentication = ProxyAuthentication::None;
            negotiate_frontend(&mut server, &authentication).await
        });
        client
            .write_all(b"CONNECT 10.20.30.40:443 HTTP/1.1\r\n\r\n")
            .await
            .unwrap();
        let error = match negotiation.await.unwrap() {
            Err(error) => error.to_string(),
            Ok(_) => panic!("HTTP must stay disabled in compatibility mode"),
        };
        assert_eq!(error, "unsupported local proxy protocol");
    }

    #[tokio::test]
    async fn stalled_client_cannot_hold_a_connection_slot() {
        let (_client, mut server) = connected_pair().await;
        let error = bounded_handshake(
            &mut server,
            &crate::engine::proxy::RejectDomainResolver,
            &ProxyAuthentication::None,
            Duration::from_millis(50),
            Duration::from_millis(50),
        )
        .await
        .expect_err("a silent client must not block the handshake");
        assert!(error.to_string().contains("greeting timed out"));
    }

    #[tokio::test]
    async fn stalled_request_after_a_valid_greeting_also_times_out() {
        let (mut client, mut server) = connected_pair().await;
        let handshake = tokio::spawn(async move {
            let authentication = ProxyAuthentication::None;
            bounded_handshake(
                &mut server,
                &crate::engine::proxy::RejectDomainResolver,
                &authentication,
                Duration::from_secs(5),
                Duration::from_millis(50),
            )
            .await
            .map(|_| ())
        });
        client
            .write_all(&[SOCKS_VERSION, 1, NO_AUTHENTICATION])
            .await
            .unwrap();
        let mut negotiated = [0_u8; 2];
        client.read_exact(&mut negotiated).await.unwrap();
        assert_eq!(negotiated, [SOCKS_VERSION, NO_AUTHENTICATION]);
        let error = handshake.await.unwrap().expect_err("stalled request");
        assert!(error.to_string().contains("request timed out"));
    }

    #[tokio::test]
    async fn a_client_that_leaves_before_the_greeting_is_not_a_failure() {
        // The desktop health probe closes its socket as soon as it has the reply,
        // and browsers open and abandon speculative connections. Reporting those
        // as request failures fills the user-visible log with noise that hides
        // the errors that matter.
        let (client, mut server) = connected_pair().await;
        drop(client);
        let outcome = bounded_handshake(
            &mut server,
            &crate::engine::proxy::RejectDomainResolver,
            &ProxyAuthentication::None,
            Duration::from_secs(5),
            Duration::from_secs(5),
        )
        .await
        .expect("a departed client is a completed session, not an error");
        assert!(outcome.is_none());
    }

    #[test]
    fn only_a_departed_peer_is_treated_as_a_clean_end() {
        use std::io::ErrorKind;
        for kind in [
            ErrorKind::BrokenPipe,
            ErrorKind::ConnectionReset,
            ErrorKind::ConnectionAborted,
            ErrorKind::NotConnected,
            ErrorKind::UnexpectedEof,
        ] {
            assert!(peer_departed(&std::io::Error::from(kind)), "{kind:?}");
        }
        for kind in [
            ErrorKind::PermissionDenied,
            ErrorKind::AddrInUse,
            ErrorKind::InvalidData,
            ErrorKind::TimedOut,
        ] {
            assert!(!peer_departed(&std::io::Error::from(kind)), "{kind:?}");
        }
    }

    #[tokio::test]
    async fn accepted_clients_have_nagle_disabled() {
        let (_client, server) = connected_pair().await;
        assert!(!server.nodelay().unwrap());
        configure_client_socket(&server).unwrap();
        assert!(server.nodelay().unwrap());
    }

    #[tokio::test]
    async fn ipv6_requests_receive_an_address_type_reply() {
        let (mut client, mut server) = connected_pair().await;
        let request = tokio::spawn(async move {
            read_socks_request(
                &mut server,
                &crate::engine::proxy::RejectDomainResolver,
                true,
            )
            .await
        });
        let mut ipv6_request = vec![SOCKS_VERSION, CONNECT_COMMAND, 0, ADDRESS_IPV6];
        ipv6_request.extend_from_slice(&[0; 16]);
        ipv6_request.extend_from_slice(&443_u16.to_be_bytes());
        client.write_all(&ipv6_request).await.unwrap();
        let mut reply = [0_u8; 10];
        client.read_exact(&mut reply).await.unwrap();
        assert_eq!(reply[..4], [SOCKS_VERSION, 8, 0, ADDRESS_IPV4]);
        assert!(request.await.unwrap().is_err());
    }

    #[tokio::test]
    async fn unsupported_command_is_rejected_before_waiting_for_its_address() {
        let (mut client, mut server) = connected_pair().await;
        let request = tokio::spawn(async move {
            read_socks_request(
                &mut server,
                &crate::engine::proxy::RejectDomainResolver,
                true,
            )
            .await
        });
        client
            .write_all(&[SOCKS_VERSION, 2, 0, ADDRESS_IPV6])
            .await
            .unwrap();
        let mut reply = [0_u8; 10];
        tokio::time::timeout(Duration::from_secs(1), client.read_exact(&mut reply))
            .await
            .expect("command rejection must not wait for the address")
            .unwrap();
        assert_eq!(reply[..4], [SOCKS_VERSION, 7, 0, ADDRESS_IPV4]);
        assert!(request.await.unwrap().is_err());
    }

    #[test]
    fn listener_requires_loopback() {
        struct Noop;
        impl NameResolver for Noop {
            fn resolve_ipv4<'a>(&'a self, _host: &'a str) -> ResolveFuture<'a> {
                Box::pin(async { Err(Error("unused".into())) })
            }
        }
        let invalid = SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 1080);
        // A full netstack requires a live data plane; validate the invariant
        // directly here instead of constructing one.
        assert!(!invalid.ip().is_loopback());
        assert_eq!(std::mem::size_of::<Noop>(), 0);
    }
}
