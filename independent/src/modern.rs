use crate::gateway_auth::{AUTHENTICATED_SESSION_ID_LEN, AuthenticatedSessionId};
use crate::gateway_connector::GatewayConnectorGeneration;
use crate::special_tls11::SpecialTls11Stream;
use crate::{Error, ErrorKind, Result};
use rand::Rng;
use rand::rand_core::UnwrapErr;
use rand::rngs::SysRng;
use rustls::client::WebPkiServerVerifier;
use rustls::client::danger::ServerCertVerifier;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, ClientConnection, RootCertStore, StreamOwned};
use sha2::{Digest, Sha256};
use socket2::{SockRef, TcpKeepalive};
use std::fmt::{Debug, Formatter};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream, ToSocketAddrs};
use std::sync::Arc;
use std::time::Duration;
use url::Url;
use zeroize::{Zeroize, Zeroizing};

pub const MODERN_TOKEN_LEN: usize = 48;
pub const MODERN_SESSION_ID_LEN: usize = AUTHENTICATED_SESSION_ID_LEN;
pub const MODERN_CONTROL_REQUEST_LEN: usize = 64;
pub const MAX_CAPTURED_HANDSHAKE_BYTES: usize = 64 * 1024;
const TLS_RECORD_HEADER_LEN: usize = 5;
const TLS_HANDSHAKE_CONTENT_TYPE: u8 = 22;
const SERVER_HELLO_HANDSHAKE_TYPE: u8 = 2;
const CERTIFICATE_HANDSHAKE_TYPE: u8 = 11;
const SERVER_HELLO_DONE_HANDSHAKE_TYPE: u8 = 14;
const TLS11_VERSION: u16 = 0x0302;
const TLS_RSA_WITH_RC4_128_SHA: u16 = 0x0005;
const TLS_EMPTY_RENEGOTIATION_INFO_SCSV: u16 = 0x00ff;

/// Backward-compatible public name for downstream tools. Production
/// authentication owns the neutral [`AuthenticatedSessionId`] type directly.
pub type ModernSessionId = AuthenticatedSessionId;

pub struct ModernToken([u8; MODERN_TOKEN_LEN]);

impl ModernToken {
    pub fn derive(server_session_id: &[u8], session: &AuthenticatedSessionId) -> Result<Self> {
        if server_session_id.len() < 16 || server_session_id.len() > 32 {
            return Err(Error(
                "TLS ServerHello session identifier has an invalid length".into(),
            ));
        }
        let encoded = Zeroizing::new(hex::encode(server_session_id));
        if encoded.len() < 31 {
            return Err(Error(
                "TLS ServerHello session identifier is too short".into(),
            ));
        }
        let mut token = [0_u8; MODERN_TOKEN_LEN];
        token[..31].copy_from_slice(&encoded.as_bytes()[..31]);
        token[31] = 0;
        token[32..].copy_from_slice(session.as_bytes());
        Ok(Self(token))
    }

    fn as_bytes(&self) -> &[u8; MODERN_TOKEN_LEN] {
        &self.0
    }
}

impl Debug for ModernToken {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("ModernToken(<redacted>)")
    }
}

impl Drop for ModernToken {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

pub struct ModernTokenAcquisition {
    token: ModernToken,
    verified_leaf_sha256: [u8; 32],
    peer_address: SocketAddr,
    connector: Option<Arc<GatewayConnectorGeneration>>,
}

impl ModernTokenAcquisition {
    pub fn token(&self) -> &ModernToken {
        &self.token
    }

    pub fn verified_leaf_sha256(&self) -> &[u8; 32] {
        &self.verified_leaf_sha256
    }

    pub fn peer_address(&self) -> SocketAddr {
        self.peer_address
    }

    pub(crate) fn connector(&self) -> Option<&GatewayConnectorGeneration> {
        self.connector.as_deref()
    }
}

impl Debug for ModernTokenAcquisition {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("ModernTokenAcquisition(<redacted>)")
    }
}

impl Drop for ModernTokenAcquisition {
    fn drop(&mut self) {
        self.verified_leaf_sha256.zeroize();
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum ModernCommand {
    RequestAddress = 0,
    Send = 5,
    Receive = 6,
}

pub struct ModernControlRequest(Zeroizing<[u8; MODERN_CONTROL_REQUEST_LEN]>);

impl ModernControlRequest {
    pub fn new(
        command: ModernCommand,
        token: &ModernToken,
        address: Option<Ipv4Addr>,
    ) -> Result<Self> {
        let mut request = Zeroizing::new([0_u8; MODERN_CONTROL_REQUEST_LEN]);
        request[..4].copy_from_slice(&(command as u32).to_le_bytes());
        request[4..52].copy_from_slice(token.as_bytes());
        match command {
            ModernCommand::RequestAddress => {
                if address.is_some() {
                    return Err(Error(
                        "address request must not contain a prior virtual address".into(),
                    ));
                }
                request[60..64].fill(0xff);
            }
            ModernCommand::Send | ModernCommand::Receive => {
                let address = address.ok_or_else(|| {
                    Error("send/receive request requires a virtual address".into())
                })?;
                let mut octets = address.octets();
                octets.reverse();
                request[60..64].copy_from_slice(&octets);
            }
        }
        Ok(Self(request))
    }

    pub fn as_bytes(&self) -> &[u8; MODERN_CONTROL_REQUEST_LEN] {
        &self.0
    }
}

impl Debug for ModernControlRequest {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("ModernControlRequest(<redacted>)")
    }
}

pub fn parse_address_reply(reply: &[u8]) -> Result<Ipv4Addr> {
    if reply.len() < 8 {
        return Err(Error::classified(
            ErrorKind::DataPlane,
            "modern address reply is shorter than 8 bytes",
        ));
    }
    if reply[0] != ModernCommand::RequestAddress as u8 {
        // The status byte is protocol metadata, not session material. Keeping
        // it in the diagnostic makes gateway-side transient rejections
        // distinguishable without ever logging the token or raw reply.
        let kind = if reply[0] == 3 {
            // Status 3 is the one gateway-side address-allocation rejection
            // observed to clear after the existing bounded settle/retry path.
            ErrorKind::DataPlaneTransient
        } else {
            ErrorKind::DataPlane
        };
        return Err(Error::classified(
            kind,
            format!(
                "modern address reply rejected the request (status={})",
                reply[0]
            ),
        ));
    }
    Ok(Ipv4Addr::new(reply[4], reply[5], reply[6], reply[7]))
}

pub fn validate_channel_reply(reply: &[u8], command: ModernCommand) -> Result<()> {
    let expected = match command {
        ModernCommand::Send => 2,
        ModernCommand::Receive => 1,
        ModernCommand::RequestAddress => {
            return Err(Error::classified(
                ErrorKind::DataPlane,
                "address replies require the address reply parser",
            ));
        }
    };
    if reply.is_empty() {
        return Err(Error::classified(
            ErrorKind::DataPlane,
            "modern channel reply is empty",
        ));
    }
    if reply[0] != expected {
        return Err(Error::classified(
            ErrorKind::DataPlane,
            "modern channel reply has an unexpected status",
        ));
    }
    Ok(())
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ModernEmptyChannelContract {
    pub address_control_established: bool,
    pub assigned_address_present: bool,
    pub send_channel_established: bool,
    pub receive_channel_established: bool,
}

pub fn probe_modern_empty_channels(
    base_url: &str,
    acquisition: &ModernTokenAcquisition,
    timeout: Duration,
    configured_special_leaf_sha256: Option<&[u8; 32]>,
) -> Result<ModernEmptyChannelContract> {
    let url = Url::parse(base_url).map_err(|_| Error("invalid modern channel base URL".into()))?;
    let host = url
        .host_str()
        .ok_or_else(|| Error("modern channel endpoint has no host".into()))?;
    let mut address_control = SpecialTls11Stream::connect(
        acquisition.peer_address(),
        host,
        timeout,
        acquisition.verified_leaf_sha256(),
        configured_special_leaf_sha256,
    )
    .map_err(|error| Error(format!("modern address TLS: {error}")))?;
    let address_request =
        ModernControlRequest::new(ModernCommand::RequestAddress, acquisition.token(), None)?;
    address_control
        .write_application_data(address_request.as_bytes())
        .map_err(|error| Error(format!("modern address request: {error}")))?;
    let address_reply = address_control
        .read_application_data(128)
        .map_err(|error| Error(format!("modern address reply: {error}")))?;
    let assigned_address = parse_address_reply(&address_reply)?;

    let mut send = SpecialTls11Stream::connect(
        acquisition.peer_address(),
        host,
        timeout,
        acquisition.verified_leaf_sha256(),
        configured_special_leaf_sha256,
    )
    .map_err(|error| Error(format!("modern send TLS: {error}")))?;
    let send_request = ModernControlRequest::new(
        ModernCommand::Send,
        acquisition.token(),
        Some(assigned_address),
    )?;
    send.write_application_data(send_request.as_bytes())
        .map_err(|error| Error(format!("modern send request: {error}")))?;
    let send_reply = send
        .read_application_data(1500)
        .map_err(|error| Error(format!("modern send reply: {error}")))?;
    validate_channel_reply(&send_reply, ModernCommand::Send)?;

    let mut receive = SpecialTls11Stream::connect(
        acquisition.peer_address(),
        host,
        timeout,
        acquisition.verified_leaf_sha256(),
        configured_special_leaf_sha256,
    )
    .map_err(|error| Error(format!("modern receive TLS: {error}")))?;
    let receive_request = ModernControlRequest::new(
        ModernCommand::Receive,
        acquisition.token(),
        Some(assigned_address),
    )?;
    receive
        .write_application_data(receive_request.as_bytes())
        .map_err(|error| Error(format!("modern receive request: {error}")))?;
    let receive_reply = receive
        .read_application_data(1500)
        .map_err(|error| Error(format!("modern receive reply: {error}")))?;
    validate_channel_reply(&receive_reply, ModernCommand::Receive)?;

    drop(receive);
    drop(send);
    drop(address_control);
    Ok(ModernEmptyChannelContract {
        address_control_established: true,
        assigned_address_present: !assigned_address.is_unspecified(),
        send_channel_established: true,
        receive_channel_established: true,
    })
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SpecialTlsContract {
    pub protocol_version: u16,
    pub cipher_suite: u16,
    pub compression_method: u8,
    pub certificate_count: usize,
    pub certificate_verified: bool,
    pub certificate_verification: &'static str,
    pub presented_leaf_sha256: [u8; 32],
}

struct SpecialServerFlight {
    version: u16,
    cipher: u16,
    compression: u8,
    certificates: Zeroizing<Vec<Vec<u8>>>,
    complete: bool,
}

fn push_u24(output: &mut Vec<u8>, value: usize) -> Result<()> {
    if value > 0x00ff_ffff {
        return Err(Error("TLS handshake value exceeds 24-bit length".into()));
    }
    output.extend_from_slice(&[
        ((value >> 16) & 0xff) as u8,
        ((value >> 8) & 0xff) as u8,
        (value & 0xff) as u8,
    ]);
    Ok(())
}

pub fn build_special_client_hello(random: [u8; 32]) -> Result<Zeroizing<Vec<u8>>> {
    let mut body = Zeroizing::new(Vec::with_capacity(96));
    body.extend_from_slice(&TLS11_VERSION.to_be_bytes());
    body.extend_from_slice(&random);
    body.push(32);
    body.extend_from_slice(b"L3IP");
    body.extend_from_slice(&[0; 28]);
    body.extend_from_slice(&4_u16.to_be_bytes());
    body.extend_from_slice(&TLS_RSA_WITH_RC4_128_SHA.to_be_bytes());
    body.extend_from_slice(&TLS_EMPTY_RENEGOTIATION_INFO_SCSV.to_be_bytes());
    body.push(2);
    body.extend_from_slice(&[1, 0]);
    body.extend_from_slice(&5_u16.to_be_bytes());
    body.extend_from_slice(&[0, 15, 0, 1, 1]);

    let mut handshake = Zeroizing::new(Vec::with_capacity(body.len() + 4));
    handshake.push(1);
    push_u24(&mut handshake, body.len())?;
    handshake.extend_from_slice(&body);

    let mut record = Zeroizing::new(Vec::with_capacity(handshake.len() + 5));
    record.push(TLS_HANDSHAKE_CONTENT_TYPE);
    record.extend_from_slice(&TLS11_VERSION.to_be_bytes());
    record.extend_from_slice(
        &u16::try_from(handshake.len())
            .map_err(|_| Error("TLS ClientHello is too large".into()))?
            .to_be_bytes(),
    );
    record.extend_from_slice(&handshake);
    Ok(record)
}

fn read_u24(value: &[u8]) -> Result<usize> {
    if value.len() < 3 {
        return Err(Error("TLS 24-bit value is truncated".into()));
    }
    Ok(((value[0] as usize) << 16) | ((value[1] as usize) << 8) | value[2] as usize)
}

fn collect_plain_handshake(records: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    let mut cursor = 0;
    let mut handshake = Zeroizing::new(Vec::new());
    while records.len().saturating_sub(cursor) >= TLS_RECORD_HEADER_LEN {
        let content_type = records[cursor];
        let length = u16::from_be_bytes([records[cursor + 3], records[cursor + 4]]) as usize;
        cursor += TLS_RECORD_HEADER_LEN;
        let end = cursor
            .checked_add(length)
            .ok_or_else(|| Error("TLS record length overflow".into()))?;
        if end > records.len() {
            break;
        }
        if content_type == TLS_HANDSHAKE_CONTENT_TYPE {
            handshake.extend_from_slice(&records[cursor..end]);
        } else if content_type == 21 {
            return Err(Error("special TLS server returned an alert".into()));
        }
        cursor = end;
    }
    Ok(handshake)
}

fn parse_special_server_flight(records: &[u8]) -> Result<SpecialServerFlight> {
    let handshake = collect_plain_handshake(records)?;
    let mut offset = 0;
    let mut server_hello = None;
    let mut certificates = Zeroizing::new(Vec::new());
    let mut complete = false;
    while handshake.len().saturating_sub(offset) >= 4 {
        let message_type = handshake[offset];
        let length = read_u24(&handshake[offset + 1..offset + 4])?;
        let body_start = offset + 4;
        let body_end = body_start
            .checked_add(length)
            .ok_or_else(|| Error("TLS handshake length overflow".into()))?;
        if body_end > handshake.len() {
            break;
        }
        let body = &handshake[body_start..body_end];
        match message_type {
            SERVER_HELLO_HANDSHAKE_TYPE => {
                if body.len() < 38 {
                    return Err(Error("special TLS ServerHello is too short".into()));
                }
                let session_length = body[34] as usize;
                let suffix = 35_usize
                    .checked_add(session_length)
                    .ok_or_else(|| Error("special TLS session length overflow".into()))?;
                if session_length > 32 || body.len() < suffix + 3 {
                    return Err(Error(
                        "special TLS ServerHello session field is invalid".into(),
                    ));
                }
                server_hello = Some((
                    u16::from_be_bytes([body[0], body[1]]),
                    u16::from_be_bytes([body[suffix], body[suffix + 1]]),
                    body[suffix + 2],
                ));
            }
            CERTIFICATE_HANDSHAKE_TYPE => {
                if body.len() < 3 {
                    return Err(Error("special TLS certificate list is truncated".into()));
                }
                let list_length = read_u24(body)?;
                if list_length != body.len() - 3 {
                    return Err(Error(
                        "special TLS certificate list length is invalid".into(),
                    ));
                }
                let mut certificate_offset = 3;
                while certificate_offset < body.len() {
                    if body.len() - certificate_offset < 3 {
                        return Err(Error("special TLS certificate length is truncated".into()));
                    }
                    let certificate_length =
                        read_u24(&body[certificate_offset..certificate_offset + 3])?;
                    certificate_offset += 3;
                    let certificate_end = certificate_offset
                        .checked_add(certificate_length)
                        .ok_or_else(|| Error("TLS certificate length overflow".into()))?;
                    if certificate_end > body.len() || certificate_length == 0 {
                        return Err(Error("special TLS certificate is truncated".into()));
                    }
                    certificates.push(body[certificate_offset..certificate_end].to_vec());
                    certificate_offset = certificate_end;
                }
            }
            SERVER_HELLO_DONE_HANDSHAKE_TYPE => {
                if !body.is_empty() {
                    return Err(Error("special TLS ServerHelloDone must be empty".into()));
                }
                complete = true;
            }
            _ => {}
        }
        offset = body_end;
    }
    let (version, cipher, compression) =
        server_hello.ok_or_else(|| Error("special TLS ServerHello is missing".into()))?;
    Ok(SpecialServerFlight {
        version,
        cipher,
        compression,
        certificates,
        complete,
    })
}

pub(crate) fn verify_special_certificates(
    host: &str,
    certificates: &[Vec<u8>],
    verified_https_leaf_sha256: &[u8; 32],
    configured_special_leaf_sha256: Option<&[u8; 32]>,
) -> Result<(bool, &'static str, [u8; 32])> {
    let (leaf, intermediates) = certificates
        .split_first()
        .ok_or_else(|| Error("special TLS server supplied no certificate".into()))?;
    let leaf = CertificateDer::from(leaf.as_slice());
    let intermediates = intermediates
        .iter()
        .map(|certificate| CertificateDer::from(certificate.as_slice()))
        .collect::<Vec<_>>();
    let roots = Arc::new(RootCertStore::from_iter(
        webpki_roots::TLS_SERVER_ROOTS.iter().cloned(),
    ));
    let verifier = WebPkiServerVerifier::builder(roots)
        .build()
        .map_err(|_| Error("cannot create special TLS certificate verifier".into()))?;
    let server_name = ServerName::try_from(host.to_owned())
        .map_err(|_| Error("special TLS endpoint has an invalid DNS name".into()))?;
    if verifier
        .verify_server_cert(&leaf, &intermediates, &server_name, &[], UnixTime::now())
        .is_ok()
    {
        let presented_leaf_sha256 = Sha256::digest(leaf.as_ref()).into();
        return Ok((true, "webpki", presented_leaf_sha256));
    }
    let presented_leaf_sha256: [u8; 32] = Sha256::digest(leaf.as_ref()).into();
    if &presented_leaf_sha256 == verified_https_leaf_sha256 {
        Ok((true, "verified_https_leaf_binding", presented_leaf_sha256))
    } else if configured_special_leaf_sha256 == Some(&presented_leaf_sha256) {
        Ok((true, "configured_leaf_pin", presented_leaf_sha256))
    } else {
        Ok((false, "administrator_pin_required", presented_leaf_sha256))
    }
}

pub fn probe_special_tls_contract(
    base_url: &str,
    timeout: Duration,
    verified_https_leaf_sha256: &[u8; 32],
    configured_special_leaf_sha256: Option<&[u8; 32]>,
) -> Result<SpecialTlsContract> {
    let url = Url::parse(base_url).map_err(|_| Error("invalid special TLS base URL".into()))?;
    let (host, address) = resolve_gateway(&url)?;
    let mut stream = connect_gateway_tcp(address, timeout)?;
    let mut random = [0_u8; 32];
    UnwrapErr(SysRng).fill_bytes(&mut random);
    let hello = build_special_client_hello(random)?;
    random.zeroize();
    stream
        .write_all(&hello)
        .map_err(|_| Error("special TLS ClientHello write failed".into()))?;

    let mut records = Zeroizing::new(Vec::with_capacity(8192));
    let mut chunk = Zeroizing::new([0_u8; 8192]);
    loop {
        let count = stream
            .read(chunk.as_mut())
            .map_err(|_| Error("special TLS server flight read failed".into()))?;
        if count == 0 {
            break;
        }
        if records.len() + count > MAX_CAPTURED_HANDSHAKE_BYTES {
            return Err(Error("special TLS server flight exceeds limit".into()));
        }
        records.extend_from_slice(&chunk[..count]);
        if parse_special_server_flight(&records).is_ok_and(|flight| flight.complete) {
            break;
        }
    }
    let flight = parse_special_server_flight(&records)?;
    if !flight.complete {
        return Err(Error("special TLS server flight is incomplete".into()));
    }
    if flight.version != TLS11_VERSION
        || flight.cipher != TLS_RSA_WITH_RC4_128_SHA
        || flight.compression != 0
    {
        return Err(Error(
            "special TLS server selected an unsupported contract".into(),
        ));
    }
    let (certificate_verified, certificate_verification, presented_leaf_sha256) =
        verify_special_certificates(
            &host,
            &flight.certificates,
            verified_https_leaf_sha256,
            configured_special_leaf_sha256,
        )?;
    Ok(SpecialTlsContract {
        protocol_version: flight.version,
        cipher_suite: flight.cipher,
        compression_method: flight.compression,
        certificate_count: flight.certificates.len(),
        certificate_verified,
        certificate_verification,
        presented_leaf_sha256,
    })
}

pub fn parse_sha256_pin(value: &str) -> Result<[u8; 32]> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(Error(
            "special TLS certificate pin must be 64 hexadecimal characters".into(),
        ));
    }
    let mut decoded =
        hex::decode(value).map_err(|_| Error("special TLS certificate pin is invalid".into()))?;
    let pin = decoded
        .as_slice()
        .try_into()
        .expect("validated SHA-256 pin length");
    decoded.zeroize();
    Ok(pin)
}

struct CapturingTcp {
    stream: TcpStream,
    received: Vec<u8>,
}

impl Read for CapturingTcp {
    fn read(&mut self, destination: &mut [u8]) -> std::io::Result<usize> {
        let count = self.stream.read(destination)?;
        let remaining = MAX_CAPTURED_HANDSHAKE_BYTES.saturating_sub(self.received.len());
        self.received
            .extend_from_slice(&destination[..count.min(remaining)]);
        Ok(count)
    }
}

impl Write for CapturingTcp {
    fn write(&mut self, source: &[u8]) -> std::io::Result<usize> {
        self.stream.write(source)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.stream.flush()
    }
}

pub fn parse_server_hello_session_id(records: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    let mut cursor = 0;
    let mut handshake = Zeroizing::new(Vec::new());
    while records.len().saturating_sub(cursor) >= TLS_RECORD_HEADER_LEN {
        let content_type = records[cursor];
        let length = u16::from_be_bytes([records[cursor + 3], records[cursor + 4]]) as usize;
        cursor += TLS_RECORD_HEADER_LEN;
        let end = cursor
            .checked_add(length)
            .ok_or_else(|| Error("TLS record length overflow".into()))?;
        if end > records.len() {
            break;
        }
        if content_type == TLS_HANDSHAKE_CONTENT_TYPE {
            handshake.extend_from_slice(&records[cursor..end]);
        }
        cursor = end;
    }
    let mut offset = 0;
    while handshake.len().saturating_sub(offset) >= 4 {
        let message_type = handshake[offset];
        let length = ((handshake[offset + 1] as usize) << 16)
            | ((handshake[offset + 2] as usize) << 8)
            | handshake[offset + 3] as usize;
        let body_start = offset + 4;
        let body_end = body_start
            .checked_add(length)
            .ok_or_else(|| Error("TLS handshake length overflow".into()))?;
        if body_end > handshake.len() {
            break;
        }
        if message_type == SERVER_HELLO_HANDSHAKE_TYPE {
            if length < 35 {
                return Err(Error("TLS ServerHello is too short".into()));
            }
            let session_length = handshake[body_start + 34] as usize;
            if session_length == 0 || session_length > 32 || 35 + session_length > length {
                return Err(Error(
                    "TLS ServerHello session identifier has an invalid length".into(),
                ));
            }
            return Ok(Zeroizing::new(
                handshake[body_start + 35..body_start + 35 + session_length].to_vec(),
            ));
        }
        offset = body_end;
    }
    Err(Error(
        "TLS ServerHello session identifier was not captured".into(),
    ))
}

/// Opens a gateway TCP connection with the timeouts and latency settings every
/// caller needs.
///
/// `TCP_NODELAY` matters here because the transport carries one tunneled IP
/// packet per TLS record: with Nagle enabled a request packet waits for the
/// gateway to acknowledge the previous one, so interactive traffic pays a
/// delayed-ACK stall on every packet instead of a single round trip.
pub(crate) fn connect_gateway_tcp(address: SocketAddr, timeout: Duration) -> Result<TcpStream> {
    let stream = TcpStream::connect_timeout(&address, timeout).map_err(|error| {
        Error::classified(
            ErrorKind::DataPlaneTransient,
            format!("cannot connect to the gateway TCP endpoint: {error}"),
        )
    })?;
    configure_gateway_tcp(stream, timeout)
}

pub(crate) fn connect_gateway_tcp_to_connector(
    connector: &GatewayConnectorGeneration,
    peer: SocketAddr,
    timeout: Duration,
) -> Result<TcpStream> {
    let stream = connector
        .connect_tcp_to(peer, timeout)
        .map_err(classify_connector_transport_error)?;
    configure_gateway_tcp(stream, timeout)
}

fn configure_gateway_tcp(stream: TcpStream, timeout: Duration) -> Result<TcpStream> {
    const KEEPALIVE_IDLE: Duration = Duration::from_secs(15);
    const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(5);

    stream.set_read_timeout(Some(timeout)).map_err(|error| {
        Error::classified(
            ErrorKind::DataPlane,
            format!("cannot set the gateway TCP read timeout: {error}"),
        )
    })?;
    stream.set_write_timeout(Some(timeout)).map_err(|error| {
        Error::classified(
            ErrorKind::DataPlane,
            format!("cannot set the gateway TCP write timeout: {error}"),
        )
    })?;
    stream.set_nodelay(true).map_err(|error| {
        Error::classified(
            ErrorKind::DataPlane,
            format!("cannot disable Nagle on the gateway TCP socket: {error}"),
        )
    })?;
    let keepalive = TcpKeepalive::new()
        .with_time(KEEPALIVE_IDLE)
        .with_interval(KEEPALIVE_INTERVAL);
    SockRef::from(&stream)
        .set_tcp_keepalive(&keepalive)
        .map_err(|error| {
            Error::classified(
                ErrorKind::DataPlane,
                format!("cannot enable gateway TCP keepalive: {error}"),
            )
        })?;
    Ok(stream)
}

fn classify_connector_transport_error(error: Error) -> Error {
    let kind = match error.kind() {
        ErrorKind::GatewayHttp | ErrorKind::GatewayHttpIndeterminate | ErrorKind::Io => {
            ErrorKind::DataPlaneTransient
        }
        _ => ErrorKind::DataPlane,
    };
    Error::classified(
        kind,
        "Gateway connector rejected the Modern transport socket",
    )
}

fn resolve_gateway(url: &Url) -> Result<(String, SocketAddr)> {
    if url.scheme() != "https" {
        return Err(Error("modern token endpoint must use HTTPS".into()));
    }
    let host = url
        .host_str()
        .ok_or_else(|| Error("modern token endpoint has no host".into()))?
        .to_owned();
    let port = url.port_or_known_default().unwrap_or(443);
    let address = (host.as_str(), port)
        .to_socket_addrs()?
        .find(SocketAddr::is_ipv4)
        .ok_or_else(|| Error("modern token endpoint has no IPv4 address".into()))?;
    Ok((host, address))
}

pub fn request_modern_token(
    base_url: &str,
    session: &AuthenticatedSessionId,
    timeout: Duration,
) -> Result<ModernTokenAcquisition> {
    let url = Url::parse(base_url).map_err(|_| Error("invalid modern token base URL".into()))?;
    let (host, address) = resolve_gateway(&url)?;
    let socket = connect_gateway_tcp(address, timeout)?;
    request_modern_token_on_socket(host, address, socket, None, session)
}

pub fn request_modern_token_with_connector(
    connector: Arc<GatewayConnectorGeneration>,
    session: &AuthenticatedSessionId,
    timeout: Duration,
) -> Result<ModernTokenAcquisition> {
    let socket = connector
        .connect_tcp(timeout)
        .map_err(classify_connector_transport_error)?;
    let address = socket.peer_addr().map_err(|_| {
        Error::classified(
            ErrorKind::DataPlane,
            "Gateway connector Modern peer could not be inspected",
        )
    })?;
    let socket = configure_gateway_tcp(socket, timeout)?;
    let host = connector.host().to_owned();
    request_modern_token_on_socket(host, address, socket, Some(connector), session)
}

fn request_modern_token_on_socket(
    host: String,
    address: SocketAddr,
    socket: TcpStream,
    connector: Option<Arc<GatewayConnectorGeneration>>,
    session: &AuthenticatedSessionId,
) -> Result<ModernTokenAcquisition> {
    let roots = RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let config = ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let server_name = ServerName::try_from(host.clone())
        .map_err(|_| Error("modern token endpoint has an invalid DNS name".into()))?;
    let connection = ClientConnection::new(Arc::new(config), server_name)
        .map_err(|_| Error("cannot create verified TLS token connection".into()))?;
    let captured = CapturingTcp {
        stream: socket,
        received: Vec::with_capacity(4096),
    };
    let mut tls = StreamOwned::new(connection, captured);

    let mut request = Zeroizing::new(Vec::with_capacity(320));
    for path in ["/por/conf.csp", "/por/rclist.csp"] {
        request.extend_from_slice(b"GET ");
        request.extend_from_slice(path.as_bytes());
        request.extend_from_slice(b" HTTP/1.1\r\nHost: ");
        request.extend_from_slice(host.as_bytes());
        request.extend_from_slice(b"\r\nCookie: TWFID=");
        request.extend_from_slice(session.as_bytes());
        request.extend_from_slice(b"\r\nConnection: keep-alive\r\n\r\n");
    }
    tls.write_all(&request)
        .map_err(|_| Error("modern token request write failed".into()))?;
    tls.flush()
        .map_err(|_| Error("modern token request flush failed".into()))?;
    let mut accepted = Zeroizing::new([0_u8; 8]);
    tls.read_exact(accepted.as_mut())
        .map_err(|_| Error("modern token request was not accepted".into()))?;
    // The token is derived from the TLS ServerHello, but a reply that is not an
    // HTTP status line means the request never reached the gateway web tier and
    // the captured handshake cannot be trusted.
    validate_modern_http_prefix(accepted.as_ref())?;
    let server_session_id = parse_server_hello_session_id(&tls.sock.received)?;
    let verified_leaf = tls
        .conn
        .peer_certificates()
        .and_then(|certificates| certificates.first())
        .ok_or_else(|| Error("verified token TLS peer certificate is missing".into()))?;
    let verified_leaf_sha256 = Sha256::digest(verified_leaf.as_ref()).into();
    let token = ModernToken::derive(&server_session_id, session)?;
    Ok(ModernTokenAcquisition {
        token,
        verified_leaf_sha256,
        peer_address: address,
        connector,
    })
}

fn validate_modern_http_prefix(prefix: &[u8]) -> Result<()> {
    if prefix.starts_with(b"HTTP/1.") {
        return Ok(());
    }
    Err(Error(
        "modern token endpoint did not return an HTTP response".into(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modern_token_requires_an_http_response_prefix() {
        assert!(validate_modern_http_prefix(b"HTTP/1.1").is_ok());
        assert!(validate_modern_http_prefix(b"NOT-HTTP").is_err());
        assert!(validate_modern_http_prefix(b"HTTP/2.0").is_err());
    }

    fn synthetic_server_hello(session_id: &[u8]) -> Vec<u8> {
        let mut body = vec![0x03, 0x03];
        body.extend_from_slice(&[7; 32]);
        body.push(session_id.len() as u8);
        body.extend_from_slice(session_id);
        body.extend_from_slice(&[0x13, 0x01, 0]);
        let mut handshake = vec![
            SERVER_HELLO_HANDSHAKE_TYPE,
            ((body.len() >> 16) & 0xff) as u8,
            ((body.len() >> 8) & 0xff) as u8,
            (body.len() & 0xff) as u8,
        ];
        handshake.extend_from_slice(&body);
        let mut record = vec![
            TLS_HANDSHAKE_CONTENT_TYPE,
            0x03,
            0x03,
            ((handshake.len() >> 8) & 0xff) as u8,
            (handshake.len() & 0xff) as u8,
        ];
        record.extend_from_slice(&handshake);
        record
    }

    #[test]
    fn token_contract_is_bounded_and_redacted() {
        let session = ModernSessionId::from_bytes(b"0123456789abcdef").unwrap();
        let token = ModernToken::derive(&[0xab; 32], &session).unwrap();
        assert_eq!(&token.as_bytes()[..4], b"abab");
        assert_eq!(token.as_bytes()[31], 0);
        assert_eq!(&token.as_bytes()[32..], b"0123456789abcdef");
        assert_eq!(format!("{token:?}"), "ModernToken(<redacted>)");
        assert!(ModernToken::derive(&[1; 15], &session).is_err());
    }

    #[test]
    fn token_acquisition_retains_the_exact_connector_generation() {
        let peer: SocketAddr = "8.8.8.8:443".parse().unwrap();
        let connector = Arc::new(
            GatewayConnectorGeneration::from_resolved(
                "school-a",
                4,
                19,
                "https://gateway.example.test",
                false,
                vec![peer],
            )
            .unwrap(),
        );
        let session = ModernSessionId::from_bytes(b"0123456789abcdef").unwrap();
        let acquisition = ModernTokenAcquisition {
            token: ModernToken::derive(&[0xab; 32], &session).unwrap(),
            verified_leaf_sha256: [7; 32],
            peer_address: peer,
            connector: Some(Arc::clone(&connector)),
        };
        let observed = acquisition.connector().unwrap();
        assert_eq!(observed.profile_id(), "school-a");
        assert_eq!(observed.profile_revision(), 4);
        assert_eq!(observed.generation(), 19);
        assert!(observed.peer_allowed(acquisition.peer_address()));
        assert_eq!(
            format!("{acquisition:?}"),
            "ModernTokenAcquisition(<redacted>)"
        );
    }

    #[test]
    fn control_requests_have_reviewed_layouts() {
        let session = ModernSessionId::from_bytes(b"0123456789abcdef").unwrap();
        let token = ModernToken::derive(&[0xab; 32], &session).unwrap();
        let address =
            ModernControlRequest::new(ModernCommand::RequestAddress, &token, None).unwrap();
        assert_eq!(&address.as_bytes()[..4], &[0, 0, 0, 0]);
        assert_eq!(&address.as_bytes()[60..], &[0xff; 4]);
        let send = ModernControlRequest::new(
            ModernCommand::Send,
            &token,
            Some(Ipv4Addr::new(10, 20, 30, 40)),
        )
        .unwrap();
        assert_eq!(&send.as_bytes()[..4], &[5, 0, 0, 0]);
        assert_eq!(&send.as_bytes()[60..], &[40, 30, 20, 10]);
        assert!(ModernControlRequest::new(ModernCommand::Receive, &token, None).is_err());
    }

    #[test]
    fn replies_fail_closed() {
        assert_eq!(
            parse_address_reply(&[0, 0, 0, 0, 10, 0, 0, 9]).unwrap(),
            Ipv4Addr::new(10, 0, 0, 9)
        );
        assert_eq!(
            parse_address_reply(&[0; 7]).unwrap_err().kind(),
            ErrorKind::DataPlane
        );
        let rejected = parse_address_reply(&[3, 0, 0, 0, 10, 0, 0, 9]).unwrap_err();
        assert_eq!(rejected.kind(), ErrorKind::DataPlaneTransient);
        assert_eq!(
            rejected.to_string(),
            "modern address reply rejected the request (status=3)"
        );
        assert_eq!(
            parse_address_reply(&[4, 0, 0, 0, 10, 0, 0, 9])
                .unwrap_err()
                .kind(),
            ErrorKind::DataPlane
        );
        assert!(validate_channel_reply(&[2], ModernCommand::Send).is_ok());
        assert!(validate_channel_reply(&[1], ModernCommand::Receive).is_ok());
        assert_eq!(
            validate_channel_reply(&[1], ModernCommand::Send)
                .unwrap_err()
                .kind(),
            ErrorKind::DataPlane
        );
    }

    #[test]
    fn extracts_server_hello_session_identifier() {
        let expected = [0x42; 32];
        let records = synthetic_server_hello(&expected);
        assert_eq!(
            parse_server_hello_session_id(&records).unwrap().as_slice(),
            expected
        );
        assert!(parse_server_hello_session_id(&records[..12]).is_err());
    }

    #[test]
    fn special_client_hello_has_stable_bounded_shape() {
        let hello = build_special_client_hello([7; 32]).unwrap();
        assert_eq!(hello.len(), 92);
        assert_eq!(&hello[..3], &[22, 3, 2]);
        assert_eq!(&hello[44..48], b"L3IP");
        assert_eq!(&hello[76..80], &[0, 4, 0, 5]);
        assert_eq!(&hello[80..84], &[0, 255, 2, 1]);
        assert_eq!(&hello[84..], &[0, 0, 5, 0, 15, 0, 1, 1]);
    }

    #[test]
    fn gateway_sockets_are_latency_configured() {
        // Every tunneled IP packet is one write on these sockets, so leaving
        // Nagle enabled delays each packet until the gateway's delayed ACK
        // arrives.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let stream = connect_gateway_tcp(address, Duration::from_secs(7)).unwrap();
        assert!(stream.nodelay().unwrap());
        assert!(SockRef::from(&stream).keepalive().unwrap());
        assert_eq!(stream.read_timeout().unwrap(), Some(Duration::from_secs(7)));
        assert_eq!(
            stream.write_timeout().unwrap(),
            Some(Duration::from_secs(7))
        );
    }

    #[test]
    fn certificate_pin_parser_is_strict() {
        assert_eq!(parse_sha256_pin(&"ab".repeat(32)).unwrap(), [0xab; 32]);
        assert!(parse_sha256_pin(&"ab".repeat(31)).is_err());
        assert!(parse_sha256_pin(&"zz".repeat(32)).is_err());
    }
}
