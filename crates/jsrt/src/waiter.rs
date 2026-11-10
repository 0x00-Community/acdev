use std::io;

use ntex_io_uring::{IoUring, opcode, types::Fd};

use crate::{Events, Isolate, abi};

const WAIT: u64 = 1;
const KICK: u64 = 2;

pub struct Waiter {
    ring: IoUring,
}

impl Waiter {
    pub fn new() -> io::Result<Self> {
        Ok(Waiter { ring: IoUring::new(8)? })
    }

    pub fn kick_and_wait(&mut self, iso: &Isolate, kick: bool) -> io::Result<Events> {
        let fd = Fd(iso.raw_fd());
        {
            let sq = self.ring.submission();
            unsafe {
                if kick {
                    sq.push(|e| {
                        opcode::UringCmd16::new(e, fd, abi::CMD_KICK).user_data(KICK);
                    })
                    .map_err(|_| io::Error::from(io::ErrorKind::WouldBlock))?;
                }
                sq.push(|e| {
                    opcode::UringCmd16::new(e, fd, abi::CMD_WAIT).user_data(WAIT);
                })
                .map_err(|_| io::Error::from(io::ErrorKind::WouldBlock))?;
            }
        }
        loop {
            self.ring.submit_and_wait(1)?;
            for cqe in self.ring.completion() {
                match (cqe.user_data(), cqe.result()) {
                    (WAIT, res) if res >= 0 => return Ok(Events::from_bits(res as u32)),
                    (_, res) if res < 0 => return Err(io::Error::from_raw_os_error(-res)),
                    _ => {}
                }
            }
        }
    }

    pub fn kick(&mut self, iso: &Isolate) -> io::Result<()> {
        let fd = Fd(iso.raw_fd());
        unsafe {
            self.ring
                .submission()
                .push(|e| {
                    opcode::UringCmd16::new(e, fd, abi::CMD_KICK).user_data(KICK);
                })
                .map_err(|_| io::Error::from(io::ErrorKind::WouldBlock))?;
        }
        self.ring.submit()?;
        Ok(())
    }
}
