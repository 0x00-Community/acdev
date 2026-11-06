use std::fs::{File, OpenOptions, TryLockError};
use std::io::{Seek, SeekFrom, Write};
use std::path::Path;

pub use std::io::Error;

#[derive(Debug)]
pub struct LockFile {
    file: File,
    locked: bool,
}

impl LockFile {
    pub fn open<P: AsRef<Path> + ?Sized>(path: &P) -> Result<Self, Error> {
        let file = OpenOptions::new().read(true).write(true).create(true).truncate(false).open(path.as_ref())?;
        Ok(Self { file, locked: false })
    }

    pub fn lock(&mut self) -> Result<(), Error> {
        assert!(!self.locked, "Cannot lock if already owning a lock");
        self.file.lock()?;
        self.locked = true;
        Ok(())
    }

    pub fn lock_with_pid(&mut self) -> Result<(), Error> {
        self.lock()?;
        self.write_pid()
    }

    pub fn try_lock(&mut self) -> Result<bool, Error> {
        assert!(!self.locked, "Cannot lock if already owning a lock");
        match self.file.try_lock() {
            Ok(()) => {
                self.locked = true;
                Ok(true)
            }
            Err(TryLockError::WouldBlock) => Ok(false),
            Err(TryLockError::Error(error)) => Err(error),
        }
    }

    pub fn try_lock_with_pid(&mut self) -> Result<bool, Error> {
        if !self.try_lock()? {
            return Ok(false);
        }
        self.write_pid().map(|()| true)
    }

    pub fn owns_lock(&self) -> bool {
        self.locked
    }

    pub fn unlock(&mut self) -> Result<(), Error> {
        assert!(self.locked, "Attempted to unlock already locked lockfile");
        self.locked = false;
        self.file.unlock()?;
        self.file.set_len(0)
    }

    fn write_pid(&mut self) -> Result<(), Error> {
        let written = self.file.set_len(0).and_then(|()| self.file.seek(SeekFrom::Start(0))).and_then(|_| writeln!(self.file, "{}", std::process::id()));
        if written.is_err() {
            let _ = self.unlock();
        }
        written
    }
}

impl Drop for LockFile {
    fn drop(&mut self) {
        if self.locked {
            let _ = self.unlock();
        }
    }
}
