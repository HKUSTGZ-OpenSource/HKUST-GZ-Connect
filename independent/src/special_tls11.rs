use crate::gateway_connector::GatewayConnectorGeneration;
use crate::modern::{
    build_special_client_hello, connect_gateway_tcp, connect_gateway_tcp_to_connector,
    verify_special_certificates,
};
use crate::{Error, ErrorKind, Result};
use hmac::{Hmac, Mac};
use md5::Md5;
use rand::RngCore;
use rand::rngs::OsRng;
use rc4::{KeyInit, Rc4, StreamCipher};
use rsa::pkcs8::DecodePublicKey;
use rsa::{Pkcs1v15Encrypt, RsaPublicKey};
use sha1::Sha1;
use std::io::{Read, Write};
use std::net::{Shutdown, SocketAddr, TcpStream};
use std::time::Duration;
use subtle::ConstantTimeEq;
use x509_parser::parse_x509_certificate;
use zeroize::{Zeroize, Zeroizing};

const TLS11_VERSION: [u8; 2] = [0x03, 0x02];
const HANDSHAKE: u8 = 22;
const CHANGE_CIPHER_SPEC: u8 = 20;
const APPLICATION_DATA: u8 = 23;
const ALERT: u8 = 21;
const HEARTBEAT: u8 = 24;
const MAX_RECORD_PAYLOAD: usize = 18_432;
const MAX_SERVER_FLIGHT: usize = 64 * 1024;
const MAX_HEARTBEAT_PAYLOAD: usize = 4 * 1024;
const MIN_HEARTBEAT_PADDING: usize = 16;
const MAX_CONTROL_RECORDS_PER_READ: usize = 16;
const SHA1_MAC_LEN: usize = 20;
const TLS_RECORD_HEADER_LEN: usize = 5;

type HmacMd5 = Hmac<Md5>;
type HmacSha1 = Hmac<Sha1>;

struct ServerFlight {
    transcript: Zeroizing<Vec<u8>>,
    server_random: [u8; 32],
    certificates: Zeroizing<Vec<Vec<u8>>>,
}

struct RecordCipher {
    mac_key: Zeroizing<[u8; SHA1_MAC_LEN]>,
    cipher: Rc4,
    sequence: u64,
}

#[derive(Debug, Eq, PartialEq)]
struct TlsAlert {
    level: u8,
    description: u8,
    name: &'static str,
}

#[derive(Debug, Eq, PartialEq)]
enum HeartbeatMessage<'a> {
    Request(&'a [u8]),
    Response(&'a [u8]),
}

impl RecordCipher {
    fn new(mac_key: [u8; SHA1_MAC_LEN], key: [u8; 16]) -> Self {
        let key = Zeroizing::new(key);
        let cipher = Rc4::new_from_slice(key.as_ref())
            .expect("the fixed 16-byte TLS RC4 key is always supported");
        Self {
            mac_key: Zeroizing::new(mac_key),
            cipher,
            sequence: 0,
        }
    }

    fn mac(&self, content_type: u8, plaintext: &[u8]) -> Result<[u8; SHA1_MAC_LEN]> {
        let mut mac = <HmacSha1 as Mac>::new_from_slice(self.mac_key.as_ref())
            .map_err(|_| Error("cannot initialize TLS record MAC".into()))?;
        mac.update(&self.sequence.to_be_bytes());
        mac.update(&[content_type]);
        mac.update(&TLS11_VERSION);
        mac.update(
            &u16::try_from(plaintext.len())
                .map_err(|_| Error("TLS plaintext is too large".into()))?
                .to_be_bytes(),
        );
        mac.update(plaintext);
        Ok(mac.finalize().into_bytes().into())
    }

    fn encrypt(&mut self, content_type: u8, plaintext: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
        let mac = self.mac(content_type, plaintext)?;
        let mut ciphertext = Zeroizing::new(Vec::with_capacity(plaintext.len() + mac.len()));
        ciphertext.extend_from_slice(plaintext);
        ciphertext.extend_from_slice(&mac);
        self.cipher.apply_keystream(&mut ciphertext);
        self.sequence = self
            .sequence
            .checked_add(1)
            .ok_or_else(|| Error("TLS record sequence exhausted".into()))?;
        Ok(ciphertext)
    }

    fn decrypt(&mut self, content_type: u8, ciphertext: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
        if ciphertext.len() < SHA1_MAC_LEN {
            return Err(Error("encrypted TLS record is too short".into()));
        }
        let mut decoded = Zeroizing::new(ciphertext.to_vec());
        self.cipher.apply_keystream(&mut decoded);
        let plaintext_length = decoded.len() - SHA1_MAC_LEN;
        let received_mac = decoded[plaintext_length..].to_vec();
        decoded.truncate(plaintext_length);
        let expected_mac = self.mac(content_type, &decoded)?;
        if !constant_time_equal(&received_mac, &expected_mac) {
            return Err(Error("TLS record MAC verification failed".into()));
        }
        self.sequence = self
            .sequence
            .checked_add(1)
            .ok_or_else(|| Error("TLS record sequence exhausted".into()))?;
        Ok(decoded)
    }
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len() && bool::from(left.ct_eq(right))
}

fn parse_alert(plaintext: &[u8]) -> Result<TlsAlert> {
    if plaintext.len() != 2 {
        return Err(Error("TLS alert must contain exactly two bytes".into()));
    }
    let level = plaintext[0];
    if !matches!(level, 1 | 2) {
        return Err(Error("TLS alert has an unknown level".into()));
    }
    let description = plaintext[1];
    let name = alert_description_name(description)
        .ok_or_else(|| Error("TLS alert has an unknown description".into()))?;
    Ok(TlsAlert {
        level,
        description,
        name,
    })
}

fn alert_description_name(description: u8) -> Option<&'static str> {
    Some(match description {
        0 => "close_notify",
        10 => "unexpected_message",
        20 => "bad_record_mac",
        21 => "decryption_failed",
        22 => "record_overflow",
        30 => "decompression_failure",
        40 => "handshake_failure",
        41 => "no_certificate",
        42 => "bad_certificate",
        43 => "unsupported_certificate",
        44 => "certificate_revoked",
        45 => "certificate_expired",
        46 => "certificate_unknown",
        47 => "illegal_parameter",
        48 => "unknown_ca",
        49 => "access_denied",
        50 => "decode_error",
        51 => "decrypt_error",
        60 => "export_restriction",
        70 => "protocol_version",
        71 => "insufficient_security",
        80 => "internal_error",
        90 => "user_canceled",
        100 => "no_renegotiation",
        110 => "unsupported_extension",
        _ => return None,
    })
}

fn peer_alert_error(alert: &TlsAlert) -> Error {
    if alert.description == 0 {
        Error("TLS peer closed the authenticated channel".into())
    } else {
        let level = if alert.level == 2 { "fatal" } else { "warning" };
        Error(format!("TLS peer sent {level} alert {}", alert.name))
    }
}

fn parse_heartbeat(plaintext: &[u8]) -> Result<HeartbeatMessage<'_>> {
    let header = plaintext
        .get(..3)
        .ok_or_else(|| Error("TLS heartbeat is truncated".into()))?;
    let payload_length = usize::from(u16::from_be_bytes([header[1], header[2]]));
    if payload_length > MAX_HEARTBEAT_PAYLOAD {
        return Err(Error(
            "TLS heartbeat payload exceeds the safety limit".into(),
        ));
    }
    let payload_end = 3_usize
        .checked_add(payload_length)
        .ok_or_else(|| Error("TLS heartbeat length overflow".into()))?;
    let payload = plaintext
        .get(3..payload_end)
        .ok_or_else(|| Error("TLS heartbeat payload is truncated".into()))?;
    let padding_length = plaintext.len().saturating_sub(payload_end);
    if padding_length < MIN_HEARTBEAT_PADDING {
        return Err(Error("TLS heartbeat padding is too short".into()));
    }
    match header[0] {
        1 => Ok(HeartbeatMessage::Request(payload)),
        2 => Ok(HeartbeatMessage::Response(payload)),
        _ => Err(Error("TLS heartbeat has an unknown message type".into())),
    }
}

fn build_heartbeat_response(
    payload: &[u8],
    padding: &[u8; MIN_HEARTBEAT_PADDING],
) -> Result<Zeroizing<Vec<u8>>> {
    if payload.len() > MAX_HEARTBEAT_PAYLOAD {
        return Err(Error(
            "TLS heartbeat payload exceeds the safety limit".into(),
        ));
    }
    let mut response = Zeroizing::new(Vec::with_capacity(
        3 + payload.len() + MIN_HEARTBEAT_PADDING,
    ));
    response.push(2);
    response.extend_from_slice(
        &u16::try_from(payload.len())
            .map_err(|_| Error("TLS heartbeat payload exceeds the wire limit".into()))?
            .to_be_bytes(),
    );
    response.extend_from_slice(payload);
    response.extend_from_slice(padding);
    Ok(response)
}

fn p_hash<M: Mac + Clone + hmac::digest::KeyInit>(
    secret: &[u8],
    seed: &[u8],
    length: usize,
) -> Result<Zeroizing<Vec<u8>>> {
    let mut a = {
        let mut mac = <M as Mac>::new_from_slice(secret)
            .map_err(|_| Error("cannot initialize TLS PRF".into()))?;
        mac.update(seed);
        Zeroizing::new(mac.finalize().into_bytes().to_vec())
    };
    let mut output = Zeroizing::new(Vec::with_capacity(length));
    while output.len() < length {
        let mut mac = <M as Mac>::new_from_slice(secret)
            .map_err(|_| Error("cannot initialize TLS PRF".into()))?;
        mac.update(&a);
        mac.update(seed);
        output.extend_from_slice(&mac.finalize().into_bytes());
        let mut next_a = <M as Mac>::new_from_slice(secret)
            .map_err(|_| Error("cannot initialize TLS PRF".into()))?;
        next_a.update(&a);
        a = Zeroizing::new(next_a.finalize().into_bytes().to_vec());
    }
    output.truncate(length);
    Ok(output)
}

fn tls10_prf(
    secret: &[u8],
    label: &[u8],
    seed: &[u8],
    length: usize,
) -> Result<Zeroizing<Vec<u8>>> {
    let split = secret.len().div_ceil(2);
    let mut label_seed = Zeroizing::new(Vec::with_capacity(label.len() + seed.len()));
    label_seed.extend_from_slice(label);
    label_seed.extend_from_slice(seed);
    let md5 = p_hash::<HmacMd5>(&secret[..split], &label_seed, length)?;
    let sha1 = p_hash::<HmacSha1>(&secret[secret.len() - split..], &label_seed, length)?;
    Ok(Zeroizing::new(
        md5.iter().zip(sha1.iter()).map(|(a, b)| a ^ b).collect(),
    ))
}

fn handshake_hash(transcript: &[u8]) -> Zeroizing<Vec<u8>> {
    use md5::Digest as _;
    let mut output = Zeroizing::new(Vec::with_capacity(36));
    output.extend_from_slice(&Md5::digest(transcript));
    output.extend_from_slice(&Sha1::digest(transcript));
    output
}

fn push_u24(output: &mut Vec<u8>, value: usize) -> Result<()> {
    if value > 0x00ff_ffff {
        return Err(Error("TLS handshake length exceeds 24 bits".into()));
    }
    output.extend_from_slice(&[
        ((value >> 16) & 0xff) as u8,
        ((value >> 8) & 0xff) as u8,
        (value & 0xff) as u8,
    ]);
    Ok(())
}

fn handshake_message(message_type: u8, body: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    let mut message = Zeroizing::new(Vec::with_capacity(body.len() + 4));
    message.push(message_type);
    push_u24(&mut message, body.len())?;
    message.extend_from_slice(body);
    Ok(message)
}

fn transient_data_plane_io(context: &'static str, error: std::io::Error) -> Error {
    Error::classified(ErrorKind::DataPlaneTransient, format!("{context}: {error}"))
}

fn write_record<W: Write>(stream: &mut W, content_type: u8, payload: &[u8]) -> Result<()> {
    if payload.len() > MAX_RECORD_PAYLOAD {
        return Err(Error("TLS record payload exceeds limit".into()));
    }
    // Header and payload go out together. Writing the 5-byte header on its own
    // puts a small segment on the wire and then waits for the reply, which is
    // the write-write-read pattern that Nagle plus a delayed ACK stalls for tens
    // of milliseconds. On this transport every tunneled IP packet is one record,
    // so that stall would apply to every packet the client sends.
    let mut record = Zeroizing::new(Vec::with_capacity(TLS_RECORD_HEADER_LEN + payload.len()));
    record.extend_from_slice(&[content_type, TLS11_VERSION[0], TLS11_VERSION[1]]);
    record.extend_from_slice(
        &u16::try_from(payload.len())
            .map_err(|_| Error("TLS record payload exceeds limit".into()))?
            .to_be_bytes(),
    );
    record.extend_from_slice(payload);
    stream
        .write_all(&record)
        .map_err(|error| transient_data_plane_io("special TLS record write failed", error))?;
    Ok(())
}

fn read_record(stream: &mut TcpStream) -> Result<(u8, Zeroizing<Vec<u8>>)> {
    let mut header = [0_u8; 5];
    stream
        .read_exact(&mut header)
        .map_err(|error| transient_data_plane_io("special TLS record header read failed", error))?;
    if header[1..3] != TLS11_VERSION {
        return Err(Error("special TLS record has an unexpected version".into()));
    }
    let length = u16::from_be_bytes([header[3], header[4]]) as usize;
    if length > MAX_RECORD_PAYLOAD {
        return Err(Error("special TLS record exceeds limit".into()));
    }
    let mut payload = Zeroizing::new(vec![0_u8; length]);
    stream
        .read_exact(&mut payload)
        .map_err(|error| transient_data_plane_io("special TLS record body read failed", error))?;
    Ok((header[0], payload))
}

fn parse_server_flight(stream: &mut TcpStream) -> Result<ServerFlight> {
    let mut transcript = Zeroizing::new(Vec::new());
    let mut server_random = None;
    let mut certificates = Zeroizing::new(Vec::new());
    let mut consumed = 0;
    let mut offset = 0;
    loop {
        let (content_type, payload) = read_record(stream)?;
        if content_type == ALERT {
            let alert = parse_alert(&payload)?;
            return Err(peer_alert_error(&alert));
        }
        if content_type != HANDSHAKE {
            return Err(Error("unexpected record before ServerHelloDone".into()));
        }
        consumed += payload.len();
        if consumed > MAX_SERVER_FLIGHT {
            return Err(Error("TLS server flight exceeds limit".into()));
        }
        transcript.extend_from_slice(&payload);
        while transcript.len().saturating_sub(offset) >= 4 {
            let length = ((transcript[offset + 1] as usize) << 16)
                | ((transcript[offset + 2] as usize) << 8)
                | transcript[offset + 3] as usize;
            let body_start = offset + 4;
            let body_end = body_start
                .checked_add(length)
                .ok_or_else(|| Error("TLS handshake length overflow".into()))?;
            if body_end > transcript.len() {
                break;
            }
            let body = &transcript[body_start..body_end];
            match transcript[offset] {
                2 => {
                    if body.len() < 38 {
                        return Err(Error("TLS ServerHello is too short".into()));
                    }
                    let session_length = body[34] as usize;
                    let suffix = 35_usize
                        .checked_add(session_length)
                        .ok_or_else(|| Error("TLS session length overflow".into()))?;
                    if body[..2] != TLS11_VERSION
                        || session_length > 32
                        || body.len() < suffix + 3
                        || body[suffix..suffix + 2] != [0, 5]
                        || body[suffix + 2] != 0
                    {
                        return Err(Error(
                            "TLS ServerHello selected an unsupported contract".into(),
                        ));
                    }
                    server_random = Some(body[2..34].try_into().expect("validated random"));
                }
                11 => {
                    if body.len() < 3 {
                        return Err(Error("TLS certificate list is truncated".into()));
                    }
                    let declared_list_length =
                        ((body[0] as usize) << 16) | ((body[1] as usize) << 8) | body[2] as usize;
                    if declared_list_length != body.len() - 3 {
                        return Err(Error("TLS certificate list length is invalid".into()));
                    }
                    let mut certificate_offset = 3;
                    while certificate_offset < body.len() {
                        if body.len() - certificate_offset < 3 {
                            return Err(Error("TLS certificate length is truncated".into()));
                        }
                        let certificate_length = ((body[certificate_offset] as usize) << 16)
                            | ((body[certificate_offset + 1] as usize) << 8)
                            | body[certificate_offset + 2] as usize;
                        certificate_offset += 3;
                        let end = certificate_offset + certificate_length;
                        if end > body.len() || certificate_length == 0 {
                            return Err(Error("TLS certificate is truncated".into()));
                        }
                        certificates.push(body[certificate_offset..end].to_vec());
                        certificate_offset = end;
                    }
                }
                12 => {
                    return Err(Error(
                        "TLS RSA handshake unexpectedly included ServerKeyExchange".into(),
                    ));
                }
                14 => {
                    if !body.is_empty() {
                        return Err(Error("TLS ServerHelloDone must be empty".into()));
                    }
                    return Ok(ServerFlight {
                        transcript,
                        server_random: server_random
                            .ok_or_else(|| Error("TLS ServerHello is missing".into()))?,
                        certificates,
                    });
                }
                _ => {}
            }
            offset = body_end;
        }
    }
}

pub struct SpecialTls11Stream {
    stream: TcpStream,
    client_cipher: RecordCipher,
    server_cipher: RecordCipher,
}

/// A cipher-free handle that can only close the underlying transport socket.
///
/// The userspace netstack keeps packet send/receive streams on dedicated OS
/// threads. A cloned TCP handle lets process assembly wake those blocking reads
/// during normal shutdown without cloning record keys or exposing wire access.
#[must_use = "the shutdown handle must be retained for the stream lifetime"]
pub(crate) struct SpecialTls11Shutdown {
    stream: TcpStream,
}

impl SpecialTls11Shutdown {
    #[cfg(test)]
    pub(crate) fn from_tcp_stream_for_test(stream: TcpStream) -> Self {
        Self { stream }
    }

    pub(crate) fn shutdown(&self) -> Result<()> {
        match self.stream.shutdown(Shutdown::Both) {
            Ok(()) => Ok(()),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotConnected
                        | std::io::ErrorKind::BrokenPipe
                        | std::io::ErrorKind::ConnectionReset
                        | std::io::ErrorKind::ConnectionAborted
                ) =>
            {
                Ok(())
            }
            Err(_) => Err(Error("cannot close special TLS transport socket".into())),
        }
    }
}

impl Drop for SpecialTls11Shutdown {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}

impl SpecialTls11Stream {
    pub(crate) fn shutdown_handle(&self) -> Result<SpecialTls11Shutdown> {
        self.stream
            .try_clone()
            .map(|stream| SpecialTls11Shutdown { stream })
            .map_err(|_| Error("cannot clone special TLS shutdown handle".into()))
    }

    pub fn connect(
        address: SocketAddr,
        host: &str,
        timeout: Duration,
        verified_https_leaf_sha256: &[u8; 32],
        configured_special_leaf_sha256: Option<&[u8; 32]>,
    ) -> Result<Self> {
        let stream = connect_gateway_tcp(address, timeout)?;
        Self::handshake(
            stream,
            host,
            verified_https_leaf_sha256,
            configured_special_leaf_sha256,
        )
    }

    pub(crate) fn connect_with_connector(
        connector: &GatewayConnectorGeneration,
        peer: SocketAddr,
        host: &str,
        timeout: Duration,
        verified_https_leaf_sha256: &[u8; 32],
        configured_special_leaf_sha256: Option<&[u8; 32]>,
    ) -> Result<Self> {
        if connector.host() != host {
            return Err(Error::classified(
                ErrorKind::DataPlane,
                "special TLS host does not match the Gateway connector",
            ));
        }
        let stream = connect_gateway_tcp_to_connector(connector, peer, timeout)?;
        Self::handshake(
            stream,
            host,
            verified_https_leaf_sha256,
            configured_special_leaf_sha256,
        )
    }

    fn handshake(
        mut stream: TcpStream,
        host: &str,
        verified_https_leaf_sha256: &[u8; 32],
        configured_special_leaf_sha256: Option<&[u8; 32]>,
    ) -> Result<Self> {
        let mut client_random = [0_u8; 32];
        OsRng.fill_bytes(&mut client_random);
        let client_hello = build_special_client_hello(client_random)?;
        stream.write_all(&client_hello)?;
        let mut transcript = Zeroizing::new(client_hello[5..].to_vec());
        let server_flight = parse_server_flight(&mut stream)?;
        transcript.extend_from_slice(&server_flight.transcript);
        let (verified, _, _) = verify_special_certificates(
            host,
            &server_flight.certificates,
            verified_https_leaf_sha256,
            configured_special_leaf_sha256,
        )?;
        if !verified {
            return Err(Error(
                "special TLS certificate requires administrator pin".into(),
            ));
        }

        let leaf = server_flight
            .certificates
            .first()
            .ok_or_else(|| Error("TLS server certificate is missing".into()))?;
        let (_, certificate) = parse_x509_certificate(leaf)
            .map_err(|_| Error("TLS server certificate is invalid".into()))?;
        let public_key = RsaPublicKey::from_public_key_der(certificate.public_key().raw)
            .map_err(|_| Error("TLS server certificate has no supported RSA key".into()))?;
        let mut premaster = Zeroizing::new([0_u8; 48]);
        premaster[..2].copy_from_slice(&TLS11_VERSION);
        OsRng.fill_bytes(&mut premaster[2..]);
        let encrypted_premaster = Zeroizing::new(
            public_key
                .encrypt(&mut OsRng, Pkcs1v15Encrypt, premaster.as_ref())
                .map_err(|_| Error("TLS RSA key exchange failed".into()))?,
        );
        let mut key_exchange_body =
            Zeroizing::new(Vec::with_capacity(encrypted_premaster.len() + 2));
        key_exchange_body.extend_from_slice(
            &u16::try_from(encrypted_premaster.len())
                .map_err(|_| Error("TLS RSA ciphertext is too large".into()))?
                .to_be_bytes(),
        );
        key_exchange_body.extend_from_slice(&encrypted_premaster);
        let key_exchange = handshake_message(16, &key_exchange_body)?;
        write_record(&mut stream, HANDSHAKE, &key_exchange)?;
        transcript.extend_from_slice(&key_exchange);

        let mut master_seed = Zeroizing::new(Vec::with_capacity(64));
        master_seed.extend_from_slice(&client_random);
        master_seed.extend_from_slice(&server_flight.server_random);
        let master = tls10_prf(premaster.as_ref(), b"master secret", &master_seed, 48)?;
        premaster.zeroize();
        let mut key_seed = Zeroizing::new(Vec::with_capacity(64));
        key_seed.extend_from_slice(&server_flight.server_random);
        key_seed.extend_from_slice(&client_random);
        client_random.zeroize();
        let key_block = tls10_prf(&master, b"key expansion", &key_seed, 72)?;
        let client_mac = key_block[0..20].try_into().expect("fixed key block");
        let server_mac = key_block[20..40].try_into().expect("fixed key block");
        let mut client_key: [u8; 16] = key_block[40..56].try_into().expect("fixed key block");
        let mut server_key: [u8; 16] = key_block[56..72].try_into().expect("fixed key block");
        let mut client_cipher = RecordCipher::new(client_mac, client_key);
        let mut server_cipher = RecordCipher::new(server_mac, server_key);
        client_key.zeroize();
        server_key.zeroize();

        write_record(&mut stream, CHANGE_CIPHER_SPEC, &[1])?;
        let client_verify = tls10_prf(
            &master,
            b"client finished",
            &handshake_hash(&transcript),
            12,
        )?;
        let client_finished = handshake_message(20, &client_verify)?;
        let encrypted_finished = client_cipher.encrypt(HANDSHAKE, &client_finished)?;
        write_record(&mut stream, HANDSHAKE, &encrypted_finished)?;
        transcript.extend_from_slice(&client_finished);

        let (content_type, change_cipher_spec) = read_record(&mut stream)?;
        if content_type == ALERT {
            let alert = parse_alert(&change_cipher_spec)?;
            return Err(peer_alert_error(&alert));
        }
        if content_type != CHANGE_CIPHER_SPEC || change_cipher_spec.as_slice() != [1] {
            return Err(Error("TLS server ChangeCipherSpec is invalid".into()));
        }
        let (content_type, encrypted_server_finished) = read_record(&mut stream)?;
        if content_type == ALERT {
            let plaintext = server_cipher.decrypt(ALERT, &encrypted_server_finished)?;
            let alert = parse_alert(&plaintext)?;
            return Err(peer_alert_error(&alert));
        }
        if content_type != HANDSHAKE {
            return Err(Error("TLS server Finished record is missing".into()));
        }
        let server_finished = server_cipher.decrypt(HANDSHAKE, &encrypted_server_finished)?;
        let expected_server_verify = tls10_prf(
            &master,
            b"server finished",
            &handshake_hash(&transcript),
            12,
        )?;
        let expected_finished = handshake_message(20, &expected_server_verify)?;
        if !constant_time_equal(&server_finished, &expected_finished) {
            return Err(Error("TLS server Finished verification failed".into()));
        }
        Ok(Self {
            stream,
            client_cipher,
            server_cipher,
        })
    }

    pub fn write_application_data(&mut self, plaintext: &[u8]) -> Result<()> {
        if plaintext.is_empty() || plaintext.len() > 16 * 1024 {
            return Err(Error(
                "TLS application payload has an invalid length".into(),
            ));
        }
        let encrypted = self.client_cipher.encrypt(APPLICATION_DATA, plaintext)?;
        write_record(&mut self.stream, APPLICATION_DATA, &encrypted)
    }

    pub fn peer_address(&self) -> std::io::Result<SocketAddr> {
        self.stream.peer_addr()
    }

    pub fn set_read_timeout(&self, timeout: Option<Duration>) -> Result<()> {
        self.stream.set_read_timeout(timeout)?;
        Ok(())
    }

    pub fn set_write_timeout(&self, timeout: Option<Duration>) -> Result<()> {
        self.stream.set_write_timeout(timeout)?;
        Ok(())
    }

    pub fn read_application_data(&mut self, maximum: usize) -> Result<Zeroizing<Vec<u8>>> {
        if maximum == 0 || maximum > 16 * 1024 {
            return Err(Error(
                "TLS application response limit has an invalid length".into(),
            ));
        }
        for _ in 0..MAX_CONTROL_RECORDS_PER_READ {
            let (content_type, ciphertext) = read_record(&mut self.stream)?;
            match content_type {
                APPLICATION_DATA => {
                    let plaintext = self.server_cipher.decrypt(APPLICATION_DATA, &ciphertext)?;
                    if plaintext.is_empty() || plaintext.len() > maximum {
                        return Err(Error(
                            "TLS application response has an invalid length".into(),
                        ));
                    }
                    return Ok(plaintext);
                }
                ALERT => {
                    let plaintext = self.server_cipher.decrypt(ALERT, &ciphertext)?;
                    let alert = parse_alert(&plaintext)?;
                    return Err(peer_alert_error(&alert));
                }
                HEARTBEAT => {
                    let plaintext = self.server_cipher.decrypt(HEARTBEAT, &ciphertext)?;
                    match parse_heartbeat(&plaintext)? {
                        HeartbeatMessage::Request(payload) => {
                            let mut padding = Zeroizing::new([0_u8; MIN_HEARTBEAT_PADDING]);
                            OsRng.fill_bytes(padding.as_mut());
                            let response = build_heartbeat_response(payload, &padding)?;
                            let encrypted = self.client_cipher.encrypt(HEARTBEAT, &response)?;
                            write_record(&mut self.stream, HEARTBEAT, &encrypted)?;
                        }
                        HeartbeatMessage::Response(_) => {}
                    }
                }
                _ => {
                    return Err(Error("unexpected authenticated TLS record type".into()));
                }
            }
        }
        Err(Error(
            "too many consecutive TLS control records before application data".into(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connector_bound_handshake_rejects_host_drift_before_network_io() {
        let peer: SocketAddr = "8.8.8.8:443".parse().unwrap();
        let connector = GatewayConnectorGeneration::from_resolved(
            "school-a",
            1,
            9,
            "https://gateway.example.test",
            false,
            vec![peer],
        )
        .unwrap();
        let result = SpecialTls11Stream::connect_with_connector(
            &connector,
            peer,
            "different.example.test",
            Duration::from_millis(1),
            &[0; 32],
            None,
        );
        let error = match result {
            Ok(_) => panic!("host drift reached a special TLS connection"),
            Err(error) => error,
        };
        assert_eq!(error.kind(), ErrorKind::DataPlane);
    }

    #[test]
    fn cipher_free_shutdown_handle_wakes_a_blocked_peer() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let client = TcpStream::connect(address).unwrap();
        let (mut server, _) = listener.accept().unwrap();
        server
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        let handle = SpecialTls11Shutdown {
            stream: client.try_clone().unwrap(),
        };
        handle.shutdown().unwrap();
        let mut byte = [0_u8; 1];
        assert_eq!(server.read(&mut byte).unwrap(), 0);
    }

    #[test]
    fn prf_is_deterministic_and_label_bound() {
        let first = tls10_prf(b"synthetic secret", b"label", b"seed", 64).unwrap();
        let second = tls10_prf(b"synthetic secret", b"label", b"seed", 64).unwrap();
        let other = tls10_prf(b"synthetic secret", b"other", b"seed", 64).unwrap();
        assert_eq!(first, second);
        assert_ne!(first, other);
        assert_eq!(first.len(), 64);
        assert_eq!(
            hex::encode(first),
            "8793ea16237fa3610209e587fe37b081db6453f77b4b0364e942a81c3cfcd861\
             505f4a1f078c89bd2da86f982e1295938a1f743f2d653fd05ab7498d6c603e18"
                .replace(' ', "")
        );
    }

    #[test]
    fn each_record_reaches_the_socket_in_a_single_write() {
        // A separate header write makes every tunneled packet a small segment
        // followed by a dependent read, which Nagle plus the gateway's delayed
        // ACK turns into a stall of tens of milliseconds per packet.
        struct CountingWriter {
            writes: Vec<usize>,
        }
        impl Write for CountingWriter {
            fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
                self.writes.push(buffer.len());
                Ok(buffer.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let mut writer = CountingWriter { writes: Vec::new() };
        write_record(&mut writer, APPLICATION_DATA, b"one tunneled packet").unwrap();
        assert_eq!(writer.writes, vec![TLS_RECORD_HEADER_LEN + 19]);
        write_record(&mut writer, HANDSHAKE, &[7; 300]).unwrap();
        assert_eq!(
            writer.writes,
            vec![TLS_RECORD_HEADER_LEN + 19, TLS_RECORD_HEADER_LEN + 300]
        );
    }

    #[test]
    fn legacy_rc4_128_matches_published_keystream_vector() {
        // RFC 6229, section 2, 128-bit key at offsets 0 and 16. This protects
        // the vendor-compatibility adapter from a silent cipher migration.
        let key = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
        let mut cipher = Rc4::new_from_slice(&key).expect("a 16-byte RC4 key is supported");
        let mut output = [0_u8; 32];
        cipher.apply_keystream(&mut output);
        assert_eq!(
            hex::encode(output),
            concat!(
                "9ac7cc9a609d1ef7b2932899cde41b97",
                "5248c4959014126a6e8a84f11d1a9e1c"
            )
        );
    }

    #[test]
    fn record_cipher_round_trips_with_independent_states() {
        let mut sender = RecordCipher::new([3; 20], [7; 16]);
        let mut receiver = RecordCipher::new([3; 20], [7; 16]);
        let ciphertext = sender
            .encrypt(APPLICATION_DATA, b"bounded payload")
            .unwrap();
        assert_eq!(
            receiver
                .decrypt(APPLICATION_DATA, &ciphertext)
                .unwrap()
                .as_slice(),
            b"bounded payload"
        );
        assert!(receiver.decrypt(APPLICATION_DATA, &ciphertext).is_err());
    }

    #[test]
    fn synthetic_alert_fixture_is_exact_and_known() {
        assert_eq!(
            parse_alert(&[1, 0]).unwrap(),
            TlsAlert {
                level: 1,
                description: 0,
                name: "close_notify",
            }
        );
        assert_eq!(
            parse_alert(&[2, 20]).unwrap(),
            TlsAlert {
                level: 2,
                description: 20,
                name: "bad_record_mac",
            }
        );
        for malformed in [
            &[][..],
            &[1][..],
            &[1, 0, 0][..],
            &[3, 0][..],
            &[2, 255][..],
        ] {
            assert!(parse_alert(malformed).is_err());
        }
    }

    #[test]
    fn synthetic_heartbeat_request_echoes_only_the_bounded_payload() {
        let payload = b"gateway-liveness";
        let mut request = vec![1, 0, payload.len() as u8];
        request.extend_from_slice(payload);
        request.extend_from_slice(&[0xa5; MIN_HEARTBEAT_PADDING + 7]);
        assert_eq!(
            parse_heartbeat(&request).unwrap(),
            HeartbeatMessage::Request(payload)
        );

        let response = build_heartbeat_response(payload, &[0x5a; MIN_HEARTBEAT_PADDING]).unwrap();
        assert_eq!(response[0], 2);
        assert_eq!(
            u16::from_be_bytes([response[1], response[2]]) as usize,
            payload.len()
        );
        assert_eq!(&response[3..3 + payload.len()], payload);
        assert_eq!(
            &response[3 + payload.len()..],
            &[0x5a; MIN_HEARTBEAT_PADDING]
        );
        assert!(!response.contains(&0xa5));
    }

    #[test]
    fn synthetic_heartbeat_fixture_rejects_heartbleed_shapes() {
        let declared_too_long = [1, 0, 32, 1, 2, 3, 4, 0, 0, 0, 0];
        assert!(parse_heartbeat(&declared_too_long).is_err());

        let mut short_padding = vec![1, 0, 1, 7];
        short_padding.extend_from_slice(&[0; MIN_HEARTBEAT_PADDING - 1]);
        assert!(parse_heartbeat(&short_padding).is_err());

        let mut oversized = vec![1];
        oversized.extend_from_slice(&((MAX_HEARTBEAT_PAYLOAD + 1) as u16).to_be_bytes());
        oversized.extend_from_slice(&vec![0; MAX_HEARTBEAT_PAYLOAD + 1]);
        oversized.extend_from_slice(&[0; MIN_HEARTBEAT_PADDING]);
        assert!(parse_heartbeat(&oversized).is_err());

        let mut unknown_type = vec![3, 0, 0];
        unknown_type.extend_from_slice(&[0; MIN_HEARTBEAT_PADDING]);
        assert!(parse_heartbeat(&unknown_type).is_err());
    }

    #[test]
    fn authenticated_heartbeat_fixture_is_mac_bound_to_its_record_type() {
        let plaintext = {
            let mut value = vec![2, 0, 1, 7];
            value.extend_from_slice(&[0; MIN_HEARTBEAT_PADDING]);
            value
        };
        let mut sender = RecordCipher::new([11; 20], [13; 16]);
        let mut receiver = RecordCipher::new([11; 20], [13; 16]);
        let ciphertext = sender.encrypt(HEARTBEAT, &plaintext).unwrap();
        let decoded = receiver.decrypt(HEARTBEAT, &ciphertext).unwrap();
        assert_eq!(
            parse_heartbeat(&decoded).unwrap(),
            HeartbeatMessage::Response(&[7])
        );

        let mut wrong_type_receiver = RecordCipher::new([11; 20], [13; 16]);
        assert!(
            wrong_type_receiver
                .decrypt(APPLICATION_DATA, &ciphertext)
                .is_err()
        );
    }

    #[test]
    fn authenticated_stream_answers_heartbeat_before_returning_application_data() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let client_socket = TcpStream::connect(address).unwrap();
        let (mut server_socket, _) = listener.accept().unwrap();

        let server = std::thread::spawn(move || {
            let payload = b"bounded-probe";
            let mut heartbeat = vec![1, 0, payload.len() as u8];
            heartbeat.extend_from_slice(payload);
            heartbeat.extend_from_slice(&[0x44; MIN_HEARTBEAT_PADDING]);
            let mut outbound = RecordCipher::new([17; 20], [19; 16]);
            let encrypted = outbound.encrypt(HEARTBEAT, &heartbeat).unwrap();
            write_record(&mut server_socket, HEARTBEAT, &encrypted).unwrap();
            let encrypted = outbound
                .encrypt(APPLICATION_DATA, b"tunneled-packet")
                .unwrap();
            write_record(&mut server_socket, APPLICATION_DATA, &encrypted).unwrap();

            let (content_type, encrypted) = read_record(&mut server_socket).unwrap();
            assert_eq!(content_type, HEARTBEAT);
            let mut inbound = RecordCipher::new([23; 20], [29; 16]);
            let plaintext = inbound.decrypt(HEARTBEAT, &encrypted).unwrap();
            assert_eq!(
                parse_heartbeat(&plaintext).unwrap(),
                HeartbeatMessage::Response(payload)
            );
            assert_eq!(plaintext.len(), 3 + payload.len() + MIN_HEARTBEAT_PADDING);
        });

        let mut client = SpecialTls11Stream {
            stream: client_socket,
            client_cipher: RecordCipher::new([23; 20], [29; 16]),
            server_cipher: RecordCipher::new([17; 20], [19; 16]),
        };
        assert_eq!(
            client.read_application_data(128).unwrap().as_slice(),
            b"tunneled-packet"
        );
        server.join().unwrap();
    }

    #[test]
    fn authenticated_stream_can_clear_setup_write_timeout() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let client_socket = TcpStream::connect(address).unwrap();
        let (_server_socket, _) = listener.accept().unwrap();
        client_socket
            .set_write_timeout(Some(Duration::from_secs(7)))
            .unwrap();

        let client = SpecialTls11Stream {
            stream: client_socket,
            client_cipher: RecordCipher::new([23; 20], [29; 16]),
            server_cipher: RecordCipher::new([17; 20], [19; 16]),
        };
        assert_eq!(
            client.stream.write_timeout().unwrap(),
            Some(Duration::from_secs(7))
        );
        client.set_write_timeout(None).unwrap();
        assert_eq!(client.stream.write_timeout().unwrap(), None);
    }
}
