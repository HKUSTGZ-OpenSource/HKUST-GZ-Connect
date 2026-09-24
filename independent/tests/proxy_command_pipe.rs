//! Real child-process pipes: memory writers cannot detect stdout buffering.

use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::net::TcpListener;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

struct ChildGuard(Child);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn connected_helper() -> (ChildGuard, std::net::TcpStream) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let path = std::env::temp_dir().join(format!(
        "ec-proxy-pipe-{}-{}",
        std::process::id(),
        listener.local_addr().unwrap().port()
    ));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(&path).unwrap();
    writeln!(
        file,
        "{}\nfixture-user\nfixture-password",
        listener.local_addr().unwrap()
    )
    .unwrap();
    drop(file);
    let child = ChildGuard(
        Command::new(env!("CARGO_BIN_EXE_ec-proxy-command"))
            .args(["--credential-file"])
            .arg(&path)
            .args(["--", "fixture.invalid", "22"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    listener.set_nonblocking(true).unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let mut peer = loop {
        match listener.accept() {
            Ok((peer, _)) => break peer,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                assert!(
                    std::time::Instant::now() < deadline,
                    "helper did not connect"
                );
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(error) => panic!("fixture accept: {error}"),
        }
    };
    fs::remove_file(path).unwrap();
    peer.set_nonblocking(false).unwrap();
    peer.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    peer.set_write_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut greeting = [0; 4];
    peer.read_exact(&mut greeting).unwrap();
    assert_eq!(greeting, [5, 2, 0, 2]);
    peer.write_all(&[5, 0]).unwrap();
    let mut request = [0; 22];
    peer.read_exact(&mut request).unwrap();
    assert_eq!(&request[..5], &[5, 1, 0, 3, 15]);
    peer.write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 22]).unwrap();
    (child, peer)
}

fn expect_clean_exit(child: &mut ChildGuard) {
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            assert!(status.success());
            let mut diagnostics = Vec::new();
            child
                .0
                .stderr
                .take()
                .unwrap()
                .read_to_end(&mut diagnostics)
                .unwrap();
            assert!(
                diagnostics.is_empty(),
                "successful relay must have no diagnostics"
            );
            break;
        }
        assert!(std::time::Instant::now() < deadline, "helper did not exit");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn downstream_binary_data_is_visible_before_newline_or_eof() {
    let (mut child, mut peer) = connected_helper();
    let mut stdout = child.0.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        let mut bytes = [0; 4];
        let result = stdout.read_exact(&mut bytes).map(|()| bytes);
        let _ = tx.send(result);
    });
    // Keep stdin and the peer open: neither EOF nor a newline may flush this payload.
    peer.write_all(&[0, 255, 1, 128]).unwrap();
    let result = rx.recv_timeout(Duration::from_secs(2));
    drop(peer);
    drop(child);
    reader.join().unwrap();
    assert_eq!(
        result.expect("binary data was buffered until EOF").unwrap(),
        [0, 255, 1, 128]
    );
}

#[test]
fn stdin_eof_half_closes_upload_and_preserves_response() {
    let (mut child, mut peer) = connected_helper();
    let payload = [0, 255, 128, 1];
    let mut stdin = child.0.stdin.take().unwrap();
    stdin.write_all(&payload).unwrap();
    drop(stdin);
    let mut received = Vec::new();
    peer.read_to_end(&mut received).unwrap();
    assert_eq!(received, payload);
    peer.write_all(&payload).unwrap();
    drop(peer);
    expect_clean_exit(&mut child);
    let mut response = Vec::new();
    child
        .0
        .stdout
        .take()
        .unwrap()
        .read_to_end(&mut response)
        .unwrap();
    assert_eq!(response, payload);
}

#[test]
fn remote_eof_exits_with_caller_stdin_still_open() {
    let (mut child, peer) = connected_helper();
    let _stdin = child.0.stdin.take().unwrap();
    drop(peer);
    expect_clean_exit(&mut child);
    let mut response = Vec::new();
    child
        .0
        .stdout
        .take()
        .unwrap()
        .read_to_end(&mut response)
        .unwrap();
    assert!(response.is_empty());
}
