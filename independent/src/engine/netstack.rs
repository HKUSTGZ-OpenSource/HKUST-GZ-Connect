use crate::engine::data_plane::{DataPlaneShutdown, EasyConnectDataPlane};
use crate::{Error, ErrorKind, Result};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;
use ts_netstack_smoltcp::netcore::{Channel, HasChannel, NetstackControl};
use ts_netstack_smoltcp::netsock::{CreateSocket, TcpStream, UdpSocket};
use ts_netstack_smoltcp::{WakingPipe, piped};

const FIRST_EPHEMERAL_PORT: u16 = 49_152;
const LAST_EPHEMERAL_PORT: u16 = 65_535;
const TCP_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const SHUTDOWN_POLL_INTERVAL: Duration = Duration::from_millis(10);

enum NetstackTransportShutdown {
    DataPlane(DataPlaneShutdown),
    #[cfg(feature = "engine-lifecycle-fixture")]
    LifecycleFixture(LifecycleFixtureShutdown),
}

impl NetstackTransportShutdown {
    fn shutdown(&self) -> Result<()> {
        match self {
            Self::DataPlane(shutdown) => shutdown.shutdown(),
            #[cfg(feature = "engine-lifecycle-fixture")]
            Self::LifecycleFixture(shutdown) => shutdown.shutdown(),
        }
    }
}

#[cfg(feature = "engine-lifecycle-fixture")]
struct LifecycleFixtureShutdown {
    wake_receiver: Mutex<Option<std::sync::mpsc::Sender<()>>>,
}

#[cfg(feature = "engine-lifecycle-fixture")]
impl LifecycleFixtureShutdown {
    fn shutdown(&self) -> Result<()> {
        self.wake_receiver
            .lock()
            .map_err(|_| shutdown_error("lifecycle fixture shutdown state is unavailable"))?
            .take();
        Ok(())
    }
}

pub struct VirtualNetstack {
    channel: Channel,
    assigned_address: Ipv4Addr,
    next_ephemeral_port: AtomicU16,
    healthy: Arc<AtomicBool>,
    transport_shutdown: NetstackTransportShutdown,
    runner: Mutex<Option<tokio::task::JoinHandle<()>>>,
    bridges: Mutex<Option<[JoinHandle<()>; 2]>>,
    shutdown_requested: Arc<AtomicBool>,
    shutdown_started: AtomicBool,
    shutdown_complete: AtomicBool,
}

impl VirtualNetstack {
    /// Starts the userspace stack over an established data plane.
    ///
    /// Must be called from inside a Tokio runtime: the stack is driven by an
    /// event-driven runner spawned onto it.
    pub fn start(data_plane: EasyConnectDataPlane, mtu: usize) -> Result<Self> {
        let assigned_address = data_plane.assigned_address();
        let data_plane_shutdown = data_plane.shutdown_handle()?;
        let (lease, mut sender, mut receiver) = data_plane.split();
        Self::start_from_packet_io(
            assigned_address,
            NetstackTransportShutdown::DataPlane(data_plane_shutdown),
            lease,
            move |packet| sender.send_ipv4(packet),
            move || receiver.receive_ipv4(),
            mtu,
        )
    }

    fn start_from_packet_io<L, S, R, P>(
        assigned_address: Ipv4Addr,
        transport_shutdown: NetstackTransportShutdown,
        lease: L,
        mut send_ipv4: S,
        mut receive_ipv4: R,
        mtu: usize,
    ) -> Result<Self>
    where
        L: Send + 'static,
        S: FnMut(&[u8]) -> Result<()> + Send + 'static,
        R: FnMut() -> Result<P> + Send + 'static,
        P: AsRef<[u8]> + Send + 'static,
    {
        let config = ts_netstack_smoltcp::netcore::Config {
            command_channel_capacity: Some(256),
            mtu,
            loopback: false,
            udp_buffer_size: 64 * 1024,
            udp_message_count: 128,
            tcp_buffer_size: 256 * 1024,
            tcp_keep_alive_interval: Some(Duration::from_secs(60)),
            tcp_timeout: Some(Duration::from_secs(120)),
            tcp_listen_backlog: 128,
            raw_buffer_size: 64 * 1024,
            raw_message_count: 128,
        };
        let (stack, pipe) = piped(config);
        let channel = stack.command_channel();
        // The event-driven runner wakes on device readiness. The threaded runner
        // only wakes on a command or its poll timer, so every packet arriving from
        // the tunnel waits out the poll interval before the stack processes it —
        // measured at ~4.6ms per round trip with a 2ms interval against ~0.09ms
        // here (see tests/poll_latency_probe.rs). That delay applies to every
        // round trip of every connection the campus browser makes.
        let runner = stack.spawn_tokio();
        if channel
            .set_ips_blocking([IpAddr::V4(assigned_address)])
            .is_err()
        {
            runner.abort();
            let _ = transport_shutdown.shutdown();
            return Err(Error(
                "cannot assign the VPN address to the userspace stack".into(),
            ));
        }

        let WakingPipe { mut rx, tx } = pipe;
        let healthy = Arc::new(AtomicBool::new(true));
        let shutdown_requested = Arc::new(AtomicBool::new(false));
        let receive_health = Arc::clone(&healthy);
        let receive_shutdown = Arc::clone(&shutdown_requested);
        let receive_bridge = std::thread::spawn(move || {
            let _lease = lease;
            loop {
                match receive_ipv4() {
                    Ok(packet) => tx.send(packet.as_ref()),
                    Err(error) => {
                        // The gateway closed or reset the data plane. Record the
                        // underlying cause so tunnel drops are diagnosable from
                        // engine.log instead of a bare "disconnected" line.
                        if !receive_shutdown.load(Ordering::Acquire) {
                            eprintln!("VPN data plane receive failed: {error}");
                        }
                        break;
                    }
                }
            }
            receive_health.store(false, Ordering::Release);
        });
        let send_health = Arc::clone(&healthy);
        let send_shutdown = Arc::clone(&shutdown_requested);
        let send_bridge = std::thread::spawn(move || {
            while let Some(packet) = rx.recv() {
                if let Err(error) = send_ipv4(&packet) {
                    if !send_shutdown.load(Ordering::Acquire) {
                        eprintln!("VPN data plane send failed: {error}");
                    }
                    break;
                }
            }
            // `None` means the userspace stack runner dropped its pipe. That is
            // just as terminal as a gateway write failure: leaving the flag true
            // would keep the engine in Connected with a live local listener but
            // no component capable of producing outbound packets.
            send_health.store(false, Ordering::Release);
        });

        Ok(Self {
            channel,
            assigned_address,
            next_ephemeral_port: AtomicU16::new(FIRST_EPHEMERAL_PORT),
            healthy,
            transport_shutdown,
            runner: Mutex::new(Some(runner)),
            bridges: Mutex::new(Some([receive_bridge, send_bridge])),
            shutdown_requested,
            shutdown_started: AtomicBool::new(false),
            shutdown_complete: AtomicBool::new(false),
        })
    }

    /// Starts the real userspace netstack/bridge owner over a channel-backed,
    /// non-routing packet transport. This constructor exists only in the
    /// explicitly feature-gated ec-engine lifecycle regression; it performs no
    /// Gateway or vendor protocol I/O and cannot forward packets off-host.
    #[cfg(feature = "engine-lifecycle-fixture")]
    pub fn start_lifecycle_fixture(assigned_address: Ipv4Addr, mtu: usize) -> Result<Self> {
        let (wake_receiver, receiver_wake) = std::sync::mpsc::channel::<()>();
        Self::start_from_packet_io(
            assigned_address,
            NetstackTransportShutdown::LifecycleFixture(LifecycleFixtureShutdown {
                wake_receiver: Mutex::new(Some(wake_receiver)),
            }),
            (),
            |_packet| Ok(()),
            move || -> Result<Vec<u8>> {
                let _ = receiver_wake.recv();
                Err(shutdown_error("lifecycle fixture packet receiver stopped"))
            },
            mtu,
        )
    }

    #[cfg(feature = "engine-lifecycle-fixture")]
    pub fn lifecycle_fixture_shutdown_complete(&self) -> bool {
        self.shutdown_complete.load(Ordering::Acquire)
    }

    pub fn assigned_address(&self) -> Ipv4Addr {
        self.assigned_address
    }

    pub fn is_healthy(&self) -> bool {
        self.healthy.load(Ordering::Acquire)
    }

    /// Stops the data-plane sockets, Tokio runner and both blocking bridges in a
    /// deterministic order. The deadline covers task cancellation and thread
    /// joins; no gateway logout should begin until this method returns.
    pub async fn shutdown(&self, timeout: Duration) -> Result<()> {
        if timeout.is_zero() {
            return Err(shutdown_error("netstack shutdown timeout must be nonzero"));
        }
        if self.shutdown_complete.load(Ordering::Acquire) {
            return Ok(());
        }
        if self.shutdown_started.swap(true, Ordering::AcqRel) {
            return Err(shutdown_error("netstack shutdown is already in progress"));
        }

        self.shutdown_requested.store(true, Ordering::Release);
        self.healthy.store(false, Ordering::Release);
        let socket_result = self.transport_shutdown.shutdown();
        let deadline = tokio::time::Instant::now() + timeout;

        let runner = self
            .runner
            .lock()
            .map(|mut runner| runner.take())
            .map_err(|_| shutdown_error("userspace netstack runner state is unavailable"));
        let runner_result = match runner {
            Ok(Some(mut runner)) => {
                runner.abort();
                match tokio::time::timeout_at(deadline, &mut runner).await {
                    Ok(Ok(())) => Ok(()),
                    Ok(Err(error)) if error.is_cancelled() => Ok(()),
                    Ok(Err(_)) => Err(shutdown_error("userspace netstack runner failed")),
                    Err(_) => Err(shutdown_error("userspace netstack runner did not stop")),
                }
            }
            Ok(None) => Ok(()),
            Err(error) => Err(error),
        };

        let bridges = self
            .bridges
            .lock()
            .map(|mut bridges| bridges.take())
            .map_err(|_| shutdown_error("data-plane bridge state is unavailable"));
        let bridge_result = match bridges {
            Ok(Some(bridges)) => join_bridges_before(bridges, deadline).await,
            Ok(None) => Ok(()),
            Err(error) => Err(error),
        };

        if socket_result.is_ok() && runner_result.is_ok() && bridge_result.is_ok() {
            self.shutdown_complete.store(true, Ordering::Release);
            Ok(())
        } else {
            Err(shutdown_error("userspace netstack shutdown was incomplete"))
        }
    }

    pub async fn connect_tcp(&self, remote: SocketAddr) -> Result<TcpStream> {
        if !self.is_healthy() {
            return Err(Error("VPN data plane is unavailable".into()));
        }
        if !remote.is_ipv4() || remote.port() == 0 {
            return Err(Error(
                "userspace TCP currently requires a valid IPv4 endpoint".into(),
            ));
        }
        let local = SocketAddr::new(
            IpAddr::V4(self.assigned_address),
            self.allocate_ephemeral_port(),
        );
        tokio::time::timeout(TCP_CONNECT_TIMEOUT, self.channel.tcp_connect(local, remote))
            .await
            .map_err(|_| Error("userspace TCP connection timed out".into()))?
            .map_err(|_| Error("userspace TCP connection failed".into()))
    }

    pub async fn bind_udp(&self) -> Result<UdpSocket> {
        if !self.is_healthy() {
            return Err(Error("VPN data plane is unavailable".into()));
        }
        let local = SocketAddr::new(
            IpAddr::V4(self.assigned_address),
            self.allocate_ephemeral_port(),
        );
        self.channel
            .udp_bind(local)
            .await
            .map_err(|_| Error("userspace UDP bind failed".into()))
    }

    fn allocate_ephemeral_port(&self) -> u16 {
        loop {
            let current = self.next_ephemeral_port.load(Ordering::Relaxed);
            let next = if current == LAST_EPHEMERAL_PORT {
                FIRST_EPHEMERAL_PORT
            } else {
                current + 1
            };
            if self
                .next_ephemeral_port
                .compare_exchange_weak(current, next, Ordering::Relaxed, Ordering::Relaxed)
                .is_ok()
            {
                return current;
            }
        }
    }
}

impl Drop for VirtualNetstack {
    fn drop(&mut self) {
        self.shutdown_requested.store(true, Ordering::Release);
        self.healthy.store(false, Ordering::Release);
        let _ = self.transport_shutdown.shutdown();
        if let Ok(mut runner) = self.runner.try_lock()
            && let Some(runner) = runner.take()
        {
            runner.abort();
        }
        // Socket shutdown and runner cancellation wake both bridges. Drop never
        // waits: normal process assembly must call `shutdown()` for proof of a
        // bounded join before the Gateway session is logged out.
    }
}

async fn join_bridges_before(
    bridges: [JoinHandle<()>; 2],
    deadline: tokio::time::Instant,
) -> Result<()> {
    while bridges.iter().any(|bridge| !bridge.is_finished()) {
        if tokio::time::Instant::now() >= deadline {
            return Err(shutdown_error("data-plane bridge threads did not stop"));
        }
        tokio::time::sleep(SHUTDOWN_POLL_INTERVAL).await;
    }
    let mut failed = false;
    for bridge in bridges {
        failed |= bridge.join().is_err();
    }
    if failed {
        Err(shutdown_error("data-plane bridge thread failed"))
    } else {
        Ok(())
    }
}

fn shutdown_error(message: impl Into<String>) -> Error {
    Error::classified(ErrorKind::Lifecycle, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::net::{TcpListener, TcpStream};

    fn socket_pair() -> (TcpStream, TcpStream) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (server, _) = listener.accept().unwrap();
        (client, server)
    }

    #[test]
    fn ephemeral_ports_wrap_inside_iana_dynamic_range() {
        let port = AtomicU16::new(LAST_EPHEMERAL_PORT);
        let current = port.load(Ordering::Relaxed);
        let next = if current == LAST_EPHEMERAL_PORT {
            FIRST_EPHEMERAL_PORT
        } else {
            current + 1
        };
        assert_eq!(next, FIRST_EPHEMERAL_PORT);
    }

    #[tokio::test]
    async fn bounded_bridge_join_observes_both_thread_completions() {
        let (release_one, wait_one) = std::sync::mpsc::channel();
        let (release_two, wait_two) = std::sync::mpsc::channel();
        let first = std::thread::spawn(move || {
            let _ = wait_one.recv();
        });
        let second = std::thread::spawn(move || {
            let _ = wait_two.recv();
        });
        release_one.send(()).unwrap();
        release_two.send(()).unwrap();
        join_bridges_before(
            [first, second],
            tokio::time::Instant::now() + Duration::from_secs(1),
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn bounded_bridge_join_reports_a_deadline_instead_of_blocking() {
        let first = std::thread::spawn(|| std::thread::sleep(Duration::from_millis(40)));
        let second = std::thread::spawn(|| std::thread::sleep(Duration::from_millis(40)));
        let error = join_bridges_before(
            [first, second],
            tokio::time::Instant::now() + Duration::from_millis(5),
        )
        .await
        .unwrap_err();
        assert_eq!(error.kind(), ErrorKind::Lifecycle);
        // Detached fixture threads finish independently; production reaches
        // this path only after its sockets and runner have already been closed.
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    #[tokio::test]
    async fn normal_shutdown_closes_sockets_aborts_runner_and_joins_bridges() {
        let (lease, lease_peer) = socket_pair();
        let mut lease_reader = lease.try_clone().unwrap();
        let (sender, sender_peer) = socket_pair();
        let (receiver, receiver_peer) = socket_pair();
        let data_plane_shutdown =
            DataPlaneShutdown::from_tcp_streams_for_test(lease, sender, receiver);
        let _peers = [lease_peer, sender_peer, receiver_peer];

        let (stack, pipe) = piped(ts_netstack_smoltcp::netcore::Config::default());
        let channel = stack.command_channel();
        let runner = stack.spawn_tokio();
        let WakingPipe { mut rx, tx: _tx } = pipe;
        let receive_stopped = Arc::new(AtomicBool::new(false));
        let receive_result = Arc::clone(&receive_stopped);
        let receive_bridge = std::thread::spawn(move || {
            let mut byte = [0_u8; 1];
            let _ = lease_reader.read(&mut byte);
            receive_result.store(true, Ordering::Release);
        });
        let send_stopped = Arc::new(AtomicBool::new(false));
        let send_result = Arc::clone(&send_stopped);
        let send_bridge = std::thread::spawn(move || {
            while rx.recv().is_some() {}
            send_result.store(true, Ordering::Release);
        });
        let healthy = Arc::new(AtomicBool::new(true));
        let netstack = VirtualNetstack {
            channel,
            assigned_address: Ipv4Addr::new(10, 0, 0, 2),
            next_ephemeral_port: AtomicU16::new(FIRST_EPHEMERAL_PORT),
            healthy,
            transport_shutdown: NetstackTransportShutdown::DataPlane(data_plane_shutdown),
            runner: Mutex::new(Some(runner)),
            bridges: Mutex::new(Some([receive_bridge, send_bridge])),
            shutdown_requested: Arc::new(AtomicBool::new(false)),
            shutdown_started: AtomicBool::new(false),
            shutdown_complete: AtomicBool::new(false),
        };

        netstack.shutdown(Duration::from_secs(1)).await.unwrap();
        assert!(receive_stopped.load(Ordering::Acquire));
        assert!(send_stopped.load(Ordering::Acquire));
        assert!(!netstack.is_healthy());
        assert!(netstack.shutdown_complete.load(Ordering::Acquire));
        assert!(netstack.shutdown(Duration::from_secs(1)).await.is_ok());
    }
}
