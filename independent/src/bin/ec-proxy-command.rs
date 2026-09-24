//! Credential-aware SOCKS5 `ProxyCommand` transport for SSH and similar tools.
//!
//! The helper deliberately keeps its command line free of proxy credentials.
//! It reads a short, owner-private credential file, negotiates either the
//! compatibility or strict-authentication SOCKS5 frontend, and then becomes a
//! raw stdin/stdout transport.

use std::ffi::OsString;
use std::fmt::{Display, Formatter};
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, Ipv6Addr, Shutdown, SocketAddr, SocketAddrV4, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;
use zeroize::Zeroizing;

const SOCKS_VERSION: u8 = 5;
const NO_AUTHENTICATION: u8 = 0;
const USERNAME_PASSWORD_AUTHENTICATION: u8 = 2;
const NO_ACCEPTABLE_METHODS: u8 = 0xff;
const RFC1929_VERSION: u8 = 1;
const CONNECT_COMMAND: u8 = 1;
const ADDRESS_IPV4: u8 = 1;
const ADDRESS_DOMAIN: u8 = 3;
const ADDRESS_IPV6: u8 = 4;
const MAX_FIELD_BYTES: usize = 255;
const MAX_CREDENTIAL_FILE_BYTES: usize = 2 * 1024;
const MIN_PROXY_PORT: u16 = 1025;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CommandError {
    Usage,
    UnsafeCredentialFile,
    InvalidCredentialFile,
    InvalidDestination,
    ProxyUnavailable,
    ProxyNegotiationFailed,
    ProxyAuthenticationFailed,
    ProxyConnectionFailed,
    RelayFailed,
}

impl Display for CommandError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        let message = match self {
            Self::Usage => {
                "usage: ec-proxy-command [--profile-id <id>] --credential-file <file> -- <host> <port>"
            }
            Self::UnsafeCredentialFile => "proxy credential file is unavailable or unsafe",
            Self::InvalidCredentialFile => "proxy credential file has an invalid format",
            Self::InvalidDestination => "proxy destination is invalid or unsupported",
            Self::ProxyUnavailable => "local proxy is unavailable",
            Self::ProxyNegotiationFailed => "local proxy negotiation failed",
            Self::ProxyAuthenticationFailed => "local proxy authentication failed",
            Self::ProxyConnectionFailed => "local proxy could not connect to the destination",
            Self::RelayFailed => "proxy stream relay failed",
        };
        formatter.write_str(message)
    }
}

type Result<T> = std::result::Result<T, CommandError>;

struct CommandArguments {
    expected_profile_id: Option<String>,
    credential_path: PathBuf,
    destination: Destination,
}

struct ProxyCredentials {
    profile_id: Option<String>,
    endpoint: SocketAddrV4,
    username: Zeroizing<Vec<u8>>,
    password: Zeroizing<Vec<u8>>,
}

enum DestinationHost {
    Ipv4(Ipv4Addr),
    Domain(String),
}

struct Destination {
    host: DestinationHost,
    port: u16,
}

fn parse_arguments(arguments: &[OsString]) -> Result<CommandArguments> {
    let (expected_profile_id, credential_index, host_index, port_index) = if arguments.len() == 5
        && arguments[0] == "--credential-file"
        && arguments[2] == "--"
        && !arguments[1].is_empty()
    {
        (None, 1, 3, 4)
    } else if arguments.len() == 7
        && arguments[0] == "--profile-id"
        && arguments[2] == "--credential-file"
        && arguments[4] == "--"
        && !arguments[3].is_empty()
    {
        let profile_id = arguments[1]
            .to_str()
            .filter(|value| valid_profile_id(value));
        (
            Some(profile_id.ok_or(CommandError::Usage)?.to_owned()),
            3,
            5,
            6,
        )
    } else {
        return Err(CommandError::Usage);
    };
    let host = arguments[host_index]
        .to_str()
        .ok_or(CommandError::InvalidDestination)?;
    let port = arguments[port_index]
        .to_str()
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|port| *port != 0)
        .ok_or(CommandError::InvalidDestination)?;
    Ok(CommandArguments {
        expected_profile_id,
        credential_path: PathBuf::from(&arguments[credential_index]),
        destination: Destination::parse(host, port)?,
    })
}

fn valid_profile_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && bytes.first().is_some_and(u8::is_ascii_alphanumeric)
        && bytes.last().is_some_and(u8::is_ascii_alphanumeric)
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
}

impl Destination {
    fn parse(host: &str, port: u16) -> Result<Self> {
        if port == 0 || host.is_empty() {
            return Err(CommandError::InvalidDestination);
        }
        if let Ok(address) = host.parse::<Ipv4Addr>() {
            return Ok(Self {
                host: DestinationHost::Ipv4(address),
                port,
            });
        }
        if host.parse::<Ipv6Addr>().is_ok() {
            return Err(CommandError::InvalidDestination);
        }
        let encoded = host.as_bytes();
        if encoded.is_empty()
            || encoded.len() > MAX_FIELD_BYTES
            || host.chars().any(|character| {
                character.is_control()
                    || character.is_whitespace()
                    || matches!(character, '/' | '\\' | '@' | '[' | ']' | ':')
            })
        {
            return Err(CommandError::InvalidDestination);
        }
        Ok(Self {
            host: DestinationHost::Domain(host.to_owned()),
            port,
        })
    }

    fn encode_request(&self) -> Vec<u8> {
        let mut request = Vec::with_capacity(MAX_FIELD_BYTES + 7);
        request.extend_from_slice(&[SOCKS_VERSION, CONNECT_COMMAND, 0]);
        match &self.host {
            DestinationHost::Ipv4(address) => {
                request.push(ADDRESS_IPV4);
                request.extend_from_slice(&address.octets());
            }
            DestinationHost::Domain(host) => {
                request.push(ADDRESS_DOMAIN);
                request.push(host.len() as u8);
                request.extend_from_slice(host.as_bytes());
            }
        }
        request.extend_from_slice(&self.port.to_be_bytes());
        request
    }
}

fn parse_credential_payload(payload: &[u8]) -> Result<ProxyCredentials> {
    if payload.is_empty() || payload.len() > MAX_CREDENTIAL_FILE_BYTES {
        return Err(CommandError::InvalidCredentialFile);
    }
    let payload = payload.strip_suffix(b"\n").unwrap_or(payload);
    let lines = payload.split(|byte| *byte == b'\n').collect::<Vec<_>>();
    let (profile_id, offset) = match lines.len() {
        3 => (None, 0),
        4 => {
            let value = std::str::from_utf8(normalized_ascii_line(lines[0])?)
                .ok()
                .filter(|value| valid_profile_id(value))
                .ok_or(CommandError::InvalidCredentialFile)?;
            (Some(value.to_owned()), 1)
        }
        _ => return Err(CommandError::InvalidCredentialFile),
    };
    let endpoint = normalized_ascii_line(lines[offset])?;
    let username = normalized_ascii_line(lines[offset + 1])?;
    let password = normalized_ascii_line(lines[offset + 2])?;

    let endpoint = std::str::from_utf8(endpoint)
        .ok()
        .and_then(|value| value.parse::<SocketAddrV4>().ok())
        .filter(|value| *value.ip() == Ipv4Addr::LOCALHOST && value.port() >= MIN_PROXY_PORT)
        .ok_or(CommandError::InvalidCredentialFile)?;

    Ok(ProxyCredentials {
        profile_id,
        endpoint,
        username: Zeroizing::new(username.to_vec()),
        password: Zeroizing::new(password.to_vec()),
    })
}

fn normalized_ascii_line(line: &[u8]) -> Result<&[u8]> {
    let line = line.strip_suffix(b"\r").unwrap_or(line);
    if line.is_empty()
        || line.len() > MAX_FIELD_BYTES
        || !line
            .iter()
            .all(|byte| byte.is_ascii() && !byte.is_ascii_control())
    {
        return Err(CommandError::InvalidCredentialFile);
    }
    Ok(line)
}

#[cfg(unix)]
fn open_credential_file(path: &Path) -> Result<File> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

    let path_metadata =
        std::fs::symlink_metadata(path).map_err(|_| CommandError::UnsafeCredentialFile)?;
    if path_metadata.file_type().is_symlink() {
        return Err(CommandError::UnsafeCredentialFile);
    }

    let file = OpenOptions::new()
        .read(true)
        // The metadata check gives a clear fail-closed decision, while
        // O_NOFOLLOW closes the replacement race between that check and open.
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|_| CommandError::UnsafeCredentialFile)?;
    let metadata = file
        .metadata()
        .map_err(|_| CommandError::UnsafeCredentialFile)?;
    if !metadata.file_type().is_file()
        || metadata.nlink() != 1
        || metadata.mode() & 0o077 != 0
        || metadata.len() > MAX_CREDENTIAL_FILE_BYTES as u64
    {
        return Err(CommandError::UnsafeCredentialFile);
    }
    Ok(file)
}

#[cfg(not(unix))]
fn open_credential_file(path: &Path) -> Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .open(path)
        .map_err(|_| CommandError::UnsafeCredentialFile)?;
    let metadata = file
        .metadata()
        .map_err(|_| CommandError::UnsafeCredentialFile)?;
    if !metadata.is_file() || metadata.len() > MAX_CREDENTIAL_FILE_BYTES as u64 {
        return Err(CommandError::UnsafeCredentialFile);
    }
    Ok(file)
}

fn read_credentials(path: &Path, expected_profile_id: Option<&str>) -> Result<ProxyCredentials> {
    let mut file = open_credential_file(path)?;
    let mut payload = Zeroizing::new(Vec::with_capacity(256));
    Read::by_ref(&mut file)
        .take((MAX_CREDENTIAL_FILE_BYTES + 1) as u64)
        .read_to_end(&mut payload)
        .map_err(|_| CommandError::UnsafeCredentialFile)?;
    if payload.len() > MAX_CREDENTIAL_FILE_BYTES {
        return Err(CommandError::UnsafeCredentialFile);
    }
    let credentials = parse_credential_payload(payload.as_slice())?;
    if expected_profile_id.is_some() && credentials.profile_id.as_deref() != expected_profile_id {
        return Err(CommandError::InvalidCredentialFile);
    }
    Ok(credentials)
}

fn establish_proxy_tunnel(
    credentials: &ProxyCredentials,
    destination: &Destination,
) -> Result<TcpStream> {
    let endpoint = SocketAddr::V4(credentials.endpoint);
    let mut stream = TcpStream::connect_timeout(&endpoint, HANDSHAKE_TIMEOUT)
        .map_err(|_| CommandError::ProxyUnavailable)?;
    stream
        .set_read_timeout(Some(HANDSHAKE_TIMEOUT))
        .and_then(|_| stream.set_write_timeout(Some(HANDSHAKE_TIMEOUT)))
        .map_err(|_| CommandError::ProxyUnavailable)?;
    negotiate_authentication(&mut stream, credentials)?;
    request_connection(&mut stream, destination)?;
    stream
        .set_read_timeout(None)
        .and_then(|_| stream.set_write_timeout(None))
        .and_then(|_| stream.set_nodelay(true))
        .map_err(|_| CommandError::RelayFailed)?;
    Ok(stream)
}

fn negotiate_authentication(stream: &mut TcpStream, credentials: &ProxyCredentials) -> Result<()> {
    stream
        .write_all(&[
            SOCKS_VERSION,
            2,
            NO_AUTHENTICATION,
            USERNAME_PASSWORD_AUTHENTICATION,
        ])
        .map_err(|_| CommandError::ProxyNegotiationFailed)?;
    let mut response = [0_u8; 2];
    stream
        .read_exact(&mut response)
        .map_err(|_| CommandError::ProxyNegotiationFailed)?;
    if response[0] != SOCKS_VERSION {
        return Err(CommandError::ProxyNegotiationFailed);
    }
    match response[1] {
        NO_AUTHENTICATION => Ok(()),
        USERNAME_PASSWORD_AUTHENTICATION => authenticate_rfc1929(stream, credentials),
        NO_ACCEPTABLE_METHODS => Err(CommandError::ProxyAuthenticationFailed),
        _ => Err(CommandError::ProxyNegotiationFailed),
    }
}

fn authenticate_rfc1929(stream: &mut TcpStream, credentials: &ProxyCredentials) -> Result<()> {
    let mut request = Zeroizing::new(Vec::with_capacity(
        credentials.username.len() + credentials.password.len() + 3,
    ));
    request.extend_from_slice(&[RFC1929_VERSION, credentials.username.len() as u8]);
    request.extend_from_slice(credentials.username.as_slice());
    request.push(credentials.password.len() as u8);
    request.extend_from_slice(credentials.password.as_slice());
    stream
        .write_all(request.as_slice())
        .map_err(|_| CommandError::ProxyAuthenticationFailed)?;
    let mut response = Zeroizing::new([0_u8; 2]);
    stream
        .read_exact(response.as_mut_slice())
        .map_err(|_| CommandError::ProxyAuthenticationFailed)?;
    if response.as_slice() != [RFC1929_VERSION, 0] {
        return Err(CommandError::ProxyAuthenticationFailed);
    }
    Ok(())
}

fn request_connection(stream: &mut TcpStream, destination: &Destination) -> Result<()> {
    stream
        .write_all(&destination.encode_request())
        .map_err(|_| CommandError::ProxyConnectionFailed)?;
    let mut header = [0_u8; 4];
    stream
        .read_exact(&mut header)
        .map_err(|_| CommandError::ProxyConnectionFailed)?;
    if header[0] != SOCKS_VERSION || header[2] != 0 {
        return Err(CommandError::ProxyNegotiationFailed);
    }
    consume_reply_address(stream, header[3])?;
    if header[1] != 0 {
        return Err(CommandError::ProxyConnectionFailed);
    }
    Ok(())
}

fn consume_reply_address(stream: &mut TcpStream, address_type: u8) -> Result<()> {
    let address_bytes = match address_type {
        ADDRESS_IPV4 => 4,
        ADDRESS_IPV6 => 16,
        ADDRESS_DOMAIN => {
            let mut length = [0_u8; 1];
            stream
                .read_exact(&mut length)
                .map_err(|_| CommandError::ProxyConnectionFailed)?;
            usize::from(length[0])
        }
        _ => return Err(CommandError::ProxyNegotiationFailed),
    };
    let mut ignored = vec![0_u8; address_bytes + 2];
    stream
        .read_exact(&mut ignored)
        .map_err(|_| CommandError::ProxyConnectionFailed)?;
    Ok(())
}

fn relay_streams<R, W>(stream: TcpStream, mut input: R, output: &mut W) -> Result<()>
where
    R: Read + Send + 'static,
    W: Write,
{
    let mut upload = stream.try_clone().map_err(|_| CommandError::RelayFailed)?;
    let mut download = stream;
    let (upload_result_tx, upload_result_rx) = mpsc::sync_channel(1);
    std::thread::Builder::new()
        .name("ec-proxy-upload".into())
        .spawn(move || {
            let succeeded = io::copy(&mut input, &mut upload).is_ok();
            if succeeded {
                let _ = upload.shutdown(Shutdown::Write);
                let _ = upload_result_tx.send(true);
            } else {
                // Publish the failure before waking the download side so it
                // cannot mistake the resulting EOF for a clean remote close.
                let _ = upload_result_tx.send(false);
                let _ = upload.shutdown(Shutdown::Both);
            }
        })
        .map_err(|_| CommandError::RelayFailed)?;

    // Stdout is line-buffered even when used as a ProxyCommand pipe. Binary
    // protocols must make progress without waiting for a newline or remote EOF.
    let downloaded = (|| -> io::Result<()> {
        let mut buffer = [0_u8; 16 * 1024];
        loop {
            let count = match download.read(&mut buffer) {
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                result => result?,
            };
            if count == 0 {
                return output.flush();
            }
            output.write_all(&buffer[..count])?;
            output.flush()?;
        }
    })()
    .is_ok();
    if !downloaded {
        let _ = download.shutdown(Shutdown::Both);
        return Err(CommandError::RelayFailed);
    }
    if matches!(upload_result_rx.try_recv(), Ok(false)) {
        return Err(CommandError::RelayFailed);
    }
    Ok(())
}

fn run() -> Result<()> {
    let arguments = std::env::args_os().skip(1).collect::<Vec<_>>();
    let arguments = parse_arguments(&arguments)?;
    let credentials = read_credentials(
        &arguments.credential_path,
        arguments.expected_profile_id.as_deref(),
    )?;
    let stream = establish_proxy_tunnel(&credentials, &arguments.destination)?;
    let mut stdout = io::stdout().lock();
    relay_streams(stream, io::stdin(), &mut stdout)
}

fn main() {
    if let Err(error) = run() {
        let _ = writeln!(io::stderr().lock(), "ec-proxy-command: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::thread;

    fn test_credentials(endpoint: SocketAddrV4) -> ProxyCredentials {
        ProxyCredentials {
            profile_id: None,
            endpoint,
            username: Zeroizing::new(b"proxy-user".to_vec()),
            password: Zeroizing::new(b"proxy-pass".to_vec()),
        }
    }

    fn accept_with_timeout(listener: TcpListener) -> TcpStream {
        let (stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        stream
    }

    #[test]
    fn arguments_are_exact_and_ipv6_is_rejected() {
        let arguments = [
            "--credential-file",
            "/private/credential",
            "--",
            "campus.example",
            "22",
        ]
        .map(OsString::from);
        let parsed = parse_arguments(&arguments).unwrap();
        assert_eq!(parsed.destination.port, 22);
        assert!(matches!(
            parsed.destination.host,
            DestinationHost::Domain(_)
        ));
        assert_eq!(parsed.expected_profile_id, None);

        let profile_bound = [
            "--profile-id",
            "school-a",
            "--credential-file",
            "/private/credential",
            "--",
            "campus.example",
            "22",
        ]
        .map(OsString::from);
        let parsed = parse_arguments(&profile_bound).unwrap();
        assert_eq!(parsed.expected_profile_id.as_deref(), Some("school-a"));
        let invalid_profile = [
            "--profile-id",
            "School_A",
            "--credential-file",
            "/private/credential",
            "--",
            "campus.example",
            "22",
        ]
        .map(OsString::from);
        assert_eq!(
            parse_arguments(&invalid_profile).err(),
            Some(CommandError::Usage)
        );

        let ipv6 = [
            "--credential-file",
            "/private/credential",
            "--",
            "::1",
            "22",
        ]
        .map(OsString::from);
        assert_eq!(
            parse_arguments(&ipv6).err(),
            Some(CommandError::InvalidDestination)
        );
        assert_eq!(
            parse_arguments(&arguments[..4]).err(),
            Some(CommandError::Usage)
        );
    }

    #[test]
    fn credential_payload_accepts_legacy_or_profile_bound_private_fields() {
        let credentials =
            parse_credential_payload(b"127.0.0.1:6180\r\nproxy-user\r\nproxy-pass\r\n").unwrap();
        assert_eq!(credentials.profile_id, None);
        assert_eq!(credentials.endpoint.port(), 6180);
        assert_eq!(credentials.username.as_slice(), b"proxy-user");
        assert_eq!(credentials.password.as_slice(), b"proxy-pass");
        let profile =
            parse_credential_payload(b"school-a\n127.0.0.1:6180\nproxy-user\nproxy-pass\n")
                .unwrap();
        assert_eq!(profile.profile_id.as_deref(), Some("school-a"));

        for invalid in [
            b"127.0.0.1:1024\nuser\npass\n".as_slice(),
            b"0.0.0.0:6180\nuser\npass\n".as_slice(),
            b"127.0.0.1:6180\n\npass\n".as_slice(),
            b"127.0.0.1:6180\nuser\npass\nextra\n".as_slice(),
            b"School_A\n127.0.0.1:6180\nuser\npass\n".as_slice(),
            b"127.0.0.1:6180\nuser\np\0ass\n".as_slice(),
        ] {
            assert_eq!(
                parse_credential_payload(invalid).err(),
                Some(CommandError::InvalidCredentialFile)
            );
        }

        let maximum = format!(
            "127.0.0.1:65535\n{}\n{}\n",
            "u".repeat(255),
            "p".repeat(255)
        );
        assert!(parse_credential_payload(maximum.as_bytes()).is_ok());
        let oversized_field = format!("127.0.0.1:6180\n{}\npass\n", "u".repeat(256));
        assert_eq!(
            parse_credential_payload(oversized_field.as_bytes()).err(),
            Some(CommandError::InvalidCredentialFile)
        );
    }

    #[test]
    fn request_encoding_supports_ipv4_and_utf8_domain() {
        let ipv4 = Destination::parse("10.20.30.40", 443).unwrap();
        assert_eq!(ipv4.encode_request(), [5, 1, 0, 1, 10, 20, 30, 40, 1, 187]);
        let domain = Destination::parse("校内.example", 22).unwrap();
        let encoded = domain.encode_request();
        assert_eq!(&encoded[..5], &[5, 1, 0, 3, 14]);
        assert_eq!(&encoded[5..19], "校内.example".as_bytes());
        assert_eq!(&encoded[19..], &[0, 22]);
    }

    #[test]
    fn every_diagnostic_is_fixed_and_redacted() {
        let diagnostics = [
            CommandError::Usage,
            CommandError::UnsafeCredentialFile,
            CommandError::InvalidCredentialFile,
            CommandError::InvalidDestination,
            CommandError::ProxyUnavailable,
            CommandError::ProxyNegotiationFailed,
            CommandError::ProxyAuthenticationFailed,
            CommandError::ProxyConnectionFailed,
            CommandError::RelayFailed,
        ];
        for diagnostic in diagnostics {
            let rendered = diagnostic.to_string();
            assert!(!rendered.contains("campus.example"));
            assert!(!rendered.contains("proxy-pass"));
            assert!(!rendered.contains("/private/credential"));
        }
    }

    #[test]
    fn loopback_proxy_selects_rfc1929_and_receives_domain_connect() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let endpoint = match listener.local_addr().unwrap() {
            SocketAddr::V4(address) => address,
            SocketAddr::V6(_) => unreachable!(),
        };
        let server = thread::spawn(move || {
            let mut stream = accept_with_timeout(listener);
            let mut greeting = [0_u8; 4];
            stream.read_exact(&mut greeting).unwrap();
            assert_eq!(greeting, [5, 2, 0, 2]);
            stream.write_all(&[5, 2]).unwrap();

            let mut auth_header = [0_u8; 2];
            stream.read_exact(&mut auth_header).unwrap();
            assert_eq!(auth_header, [1, 10]);
            let mut username = [0_u8; 10];
            stream.read_exact(&mut username).unwrap();
            assert_eq!(&username, b"proxy-user");
            assert_eq!(read_byte(&mut stream), 10);
            let mut password = [0_u8; 10];
            stream.read_exact(&mut password).unwrap();
            assert_eq!(&password, b"proxy-pass");
            stream.write_all(&[1, 0]).unwrap();

            let mut request_header = [0_u8; 5];
            stream.read_exact(&mut request_header).unwrap();
            assert_eq!(request_header, [5, 1, 0, 3, 14]);
            let mut domain = [0_u8; 14];
            stream.read_exact(&mut domain).unwrap();
            assert_eq!(&domain, "校内.example".as_bytes());
            let mut port = [0_u8; 2];
            stream.read_exact(&mut port).unwrap();
            assert_eq!(u16::from_be_bytes(port), 22);
            stream
                .write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0x18, 0x24])
                .unwrap();
        });

        let credentials = test_credentials(endpoint);
        establish_proxy_tunnel(
            &credentials,
            &Destination::parse("校内.example", 22).unwrap(),
        )
        .unwrap();
        server.join().unwrap();
    }

    #[test]
    fn loopback_proxy_can_select_no_authentication_for_ipv4() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let endpoint = match listener.local_addr().unwrap() {
            SocketAddr::V4(address) => address,
            SocketAddr::V6(_) => unreachable!(),
        };
        let server = thread::spawn(move || {
            let mut stream = accept_with_timeout(listener);
            let mut greeting = [0_u8; 4];
            stream.read_exact(&mut greeting).unwrap();
            assert_eq!(greeting, [5, 2, 0, 2]);
            stream.write_all(&[5, 0]).unwrap();
            let mut request = [0_u8; 10];
            stream.read_exact(&mut request).unwrap();
            assert_eq!(request, [5, 1, 0, 1, 10, 20, 30, 40, 1, 187]);
            stream.write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 1]).unwrap();
        });

        let credentials = test_credentials(endpoint);
        establish_proxy_tunnel(
            &credentials,
            &Destination::parse("10.20.30.40", 443).unwrap(),
        )
        .unwrap();
        server.join().unwrap();
    }

    #[test]
    fn loopback_relay_copies_raw_bytes_in_both_directions() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let mut stream = accept_with_timeout(listener);
            let mut received = Vec::new();
            stream.read_to_end(&mut received).unwrap();
            assert_eq!(received, b"client payload\0\xff");
            stream.write_all(b"server payload\0\xfe").unwrap();
        });
        let stream = TcpStream::connect(address).unwrap();
        let mut output = Vec::new();
        relay_streams(
            stream,
            io::Cursor::new(b"client payload\0\xff".to_vec()),
            &mut output,
        )
        .unwrap();
        assert_eq!(output, b"server payload\0\xfe");
        server.join().unwrap();
    }

    fn read_byte(stream: &mut TcpStream) -> u8 {
        let mut byte = [0_u8; 1];
        stream.read_exact(&mut byte).unwrap();
        byte[0]
    }

    #[cfg(unix)]
    #[test]
    fn unix_credential_file_rejects_links_and_shared_permissions() {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt, symlink};
        use std::time::{SystemTime, UNIX_EPOCH};

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "ec-proxy-command-test-{}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir(&directory).unwrap();
        let credential = directory.join("credential");
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&credential)
            .unwrap();
        file.write_all(b"127.0.0.1:6180\nuser\npass\n").unwrap();
        drop(file);
        assert!(read_credentials(&credential, None).is_ok());
        std::fs::write(&credential, b"school-a\n127.0.0.1:6180\nuser\npass\n").unwrap();
        assert!(read_credentials(&credential, Some("school-a")).is_ok());
        assert_eq!(
            read_credentials(&credential, Some("school-b")).err(),
            Some(CommandError::InvalidCredentialFile)
        );
        std::fs::write(&credential, b"127.0.0.1:6180\nuser\npass\n").unwrap();
        assert_eq!(
            read_credentials(&credential, Some("school-a")).err(),
            Some(CommandError::InvalidCredentialFile)
        );

        std::fs::set_permissions(&credential, std::fs::Permissions::from_mode(0o640)).unwrap();
        assert_eq!(
            read_credentials(&credential, None).err(),
            Some(CommandError::UnsafeCredentialFile)
        );
        std::fs::set_permissions(&credential, std::fs::Permissions::from_mode(0o600)).unwrap();

        let link = directory.join("credential-link");
        symlink(&credential, &link).unwrap();
        assert_eq!(
            read_credentials(&link, None).err(),
            Some(CommandError::UnsafeCredentialFile)
        );

        let hard_link = directory.join("credential-hard-link");
        std::fs::hard_link(&credential, &hard_link).unwrap();
        assert_eq!(
            read_credentials(&credential, None).err(),
            Some(CommandError::UnsafeCredentialFile)
        );
        std::fs::remove_dir_all(&directory).unwrap();
    }
}
