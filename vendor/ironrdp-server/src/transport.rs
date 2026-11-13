//! acde: the ntex side of the server, in place of ironrdp-tokio and tokio's listener.
//!
//! Connections are ntex [`Io`] objects (io_uring or polling, whichever runtime the application starts),
//! TLS is ntex-tls's OpenSSL filter. ntex has no listener of its own outside ntex-server (which runs its own
//! worker threads), so a small thread accepts and hands the sockets over; the server itself stays on the
//! thread that runs [`RdpServer::run`](crate::RdpServer::run).

use core::net::SocketAddr;
use core::pin::Pin;
use core::time::Duration;
use std::io;
use std::net::{Shutdown, TcpListener, TcpStream};
use std::rc::Rc;

use bytes::BytesMut;
use ironrdp_async::{Framed, FramedRead, FramedWrite, NetworkClient, StreamWrapper};
use ironrdp_connector::ConnectorResult;
use ironrdp_connector::sspi::generator::NetworkRequest;
use ntex::io::{Filter, Io, Layer};
use ntex::service::Pipeline;
use ntex::tls::openssl::SslFilter;
use openssl::ssl::SslAcceptor;
use tracing::warn;

/// An ntex connection as ironrdp-async's stream. The two halves of a split share the same `Io`: its methods
/// take `&self`, reads and writes do not block each other.
pub(crate) struct NtexStream<F> {
    inner: Rc<Io<F>>,
}

pub(crate) type NtexFramed<F> = Framed<NtexStream<F>>;

impl<F> StreamWrapper for NtexStream<F> {
    type InnerStream = Rc<Io<F>>;

    fn from_inner(stream: Self::InnerStream) -> Self {
        Self { inner: stream }
    }

    fn into_inner(self) -> Self::InnerStream {
        self.inner
    }

    fn get_inner(&self) -> &Self::InnerStream {
        &self.inner
    }

    fn get_inner_mut(&mut self) -> &mut Self::InnerStream {
        &mut self.inner
    }
}

impl<F> FramedRead for NtexStream<F> {
    type ReadFut<'read>
        = Pin<Box<dyn Future<Output = io::Result<usize>> + 'read>>
    where
        Self: 'read;

    /// Cancel safe: bytes move from the connection's read buffer into `buf` only after the wait.
    fn read<'a>(&'a mut self, buf: &'a mut BytesMut) -> Self::ReadFut<'a> {
        Box::pin(async move {
            loop {
                // Always taken (even when empty): it also clears the connection's read readiness, so the wait
                // below does not return at once for input that was already handed over.
                let len = self.inner.with_read_dst(|src| {
                    let len = src.len();
                    buf.extend_from_slice(src);
                    src.clear();
                    len
                });
                if len > 0 {
                    return Ok(len);
                }
                if self.inner.read_more().await?.is_none() {
                    return Ok(0);
                }
            }
        })
    }
}

impl<F> FramedWrite for NtexStream<F> {
    type WriteAllFut<'write>
        = Pin<Box<dyn Future<Output = io::Result<()>> + 'write>>
    where
        Self: 'write;

    fn write_all<'a>(&'a mut self, buf: &'a [u8]) -> Self::WriteAllFut<'a> {
        Box::pin(async move {
            self.inner.encode_slice(buf)?;
            self.inner.flush(true).await
        })
    }
}

/// A reader and a writer over the same connection; the reader keeps what was read ahead.
pub(crate) fn split_ntex_framed<F>(framed: NtexFramed<F>) -> (NtexFramed<F>, NtexFramed<F>) {
    let (io, leftover) = framed.into_inner();
    let reader = NtexFramed::new_with_leftover(Rc::clone(&io), leftover);
    (reader, NtexFramed::new(io))
}

pub(crate) fn unsplit_ntex_framed<F>(reader: NtexFramed<F>, writer: NtexFramed<F>) -> NtexFramed<F> {
    let (io, leftover) = reader.into_inner();
    drop(writer.into_inner_no_leftover());
    NtexFramed::new_with_leftover(io, leftover)
}

/// Takes the connection back from a framed stream that has no other half left (after `accept_begin`).
pub(crate) fn into_io<F>(io: Rc<Io<F>>) -> io::Result<Io<F>> {
    Rc::try_unwrap(io).map_err(|_| io::Error::other("connection still shared"))
}

/// The server side of the TLS handshake (ntex-tls's OpenSSL filter, its default 5 s handshake timeout).
pub(crate) async fn accept_tls<F: Filter>(io: Io<F>, acceptor: &SslAcceptor) -> io::Result<Io<Layer<SslFilter, F>>> {
    Pipeline::new((), ntex::tls::openssl::SslAcceptor::new(acceptor.clone()))
        .call(io)
        .await
}

/// The network client CredSSP gets: NTLM never asks for one, Kerberos (KDC requests) is not supported.
pub(crate) struct NoNetworkClient;

impl NetworkClient for NoNetworkClient {
    fn send(&mut self, _network_request: &NetworkRequest) -> impl Future<Output = ConnectorResult<Vec<u8>>> {
        core::future::ready(Err(ironrdp_connector::general_err!(
            "network requests (Kerberos KDC) are not supported"
        )))
    }
}

/// Accepted TCP connections, from a thread blocked in `accept`.
pub(crate) struct Incoming {
    connections: async_channel::Receiver<(TcpStream, SocketAddr)>,
    listener: TcpListener,
}

impl Incoming {
    pub(crate) fn start(listener: TcpListener) -> io::Result<Self> {
        // One accepted connection waits here while the server runs another; the rest stay in the backlog.
        let (sender, connections) = async_channel::bounded(1);
        let accepting = listener.try_clone()?;
        std::thread::Builder::new()
            .name("ironrdp-accept".to_owned())
            .spawn(move || accept_loop(&accepting, &sender))?;
        Ok(Self { connections, listener })
    }

    /// The next connection; None once the accept thread is gone.
    pub(crate) async fn accept(&self) -> Option<(TcpStream, SocketAddr)> {
        self.connections.recv().await.ok()
    }
}

impl Drop for Incoming {
    fn drop(&mut self) {
        self.connections.close();
        // Wakes the thread from `accept` (on Linux); it sees the closed channel and ends.
        if let Err(error) = socket2::SockRef::from(&self.listener).shutdown(Shutdown::Read) {
            tracing::debug!(%error, "Failed to shut the listener down");
        }
    }
}

fn accept_loop(listener: &TcpListener, sender: &async_channel::Sender<(TcpStream, SocketAddr)>) {
    loop {
        match listener.accept() {
            Ok(connection) => {
                if sender.send_blocking(connection).is_err() {
                    return;
                }
            }
            Err(_) if sender.is_closed() => return,
            Err(error) => {
                warn!(%error, "Failed to accept a connection");
                // e.g. out of file descriptors: do not spin
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    }
}
