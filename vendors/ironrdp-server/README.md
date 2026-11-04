# IronRDP Server

Extendable skeleton for implementing custom RDP servers.

acde: it runs on [ntex](https://ntex.rs/) (connections are ntex `Io`, TLS is OpenSSL) instead of the Tokio runtime.

---

The server currently supports:

**Security**
 - Enhanced RDP Security with TLS External Security Protocols (TLS 1.2 and TLS 1.3)

**Input**
 - FastPath input events
 - x224 input events and disconnect

**Codecs**
 - bitmap display updates with RDP 6.0 compression

---

Custom logic for your RDP server can be added by implementing these traits:
 - `RdpServerInputHandler` - callbacks used when the server receives input events from a client
 - `RdpServerDisplay`      - notifies the server of display updates

This crate is part of the [IronRDP] project.

## Echo RTT probes (feature `echo`)

Enable the `echo` feature to use the ECHO dynamic virtual channel (`MS-RDPEECO`) and measure round-trip time.

```rust
use ironrdp_server::RdpServer;

# async fn demo(mut server: RdpServer) -> anyhow::Result<()> {
// Grab and clone the shared handle before moving the server into a task.
let echo = server.echo_handle().clone();

// acde: the server is not Send; run it as a task on the current thread's ntex runtime.
let server_task = ironrdp_server::ntex::rt::spawn(async move { server.run().await });

{
	echo.send_request(b"ping".to_vec())?;

	for measurement in echo.take_measurements() {
		println!(
			"echo payload size={} rtt={:?}",
			measurement.payload.len(),
			measurement.round_trip_time
		);
	}
}

server_task.await.map_err(|_| anyhow::anyhow!("server task failed"))??;
# Ok(()) }
```

`send_request` queues a probe via the server event loop. If no client has opened the ECHO channel yet, the request is dropped.

[IronRDP]: https://github.com/Devolutions/IronRDP
