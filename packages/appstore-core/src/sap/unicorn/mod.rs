pub mod artifact;
pub mod library;
pub mod patch;
#[cfg(target_os = "windows")]
pub mod windows;
use crate::client::AppleClient;
use crate::error::ClientError;
use libloading::Library;
use std::ffi::{CStr, c_char, c_int, c_void};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::Path;
use std::time::Duration;
const ARCH_X86: c_int = 4;
const MODE_64: c_int = 8;
const PROT_ALL: u32 = 7;
const HOOK_CODE: c_int = 1 << 2;
pub mod reg {
    pub const RAX: i32 = 35;
    pub const RCX: i32 = 38;
    pub const RDI: i32 = 39;
    pub const RDX: i32 = 40;
    pub const RIP: i32 = 41;
    pub const RSI: i32 = 43;
    pub const RSP: i32 = 44;
    pub const R8: i32 = 106;
    pub const R9: i32 = 107;
}
type Handle = *mut c_void;
type HookHandle = usize;
struct Api {
    version: unsafe extern "C" fn(*mut u32, *mut u32) -> u32,
    open: unsafe extern "C" fn(c_int, c_int, *mut Handle) -> c_int,
    close: unsafe extern "C" fn(Handle) -> c_int,
    strerror: unsafe extern "C" fn(c_int) -> *const c_char,
    mem_map: unsafe extern "C" fn(Handle, u64, usize, u32) -> c_int,
    mem_unmap: unsafe extern "C" fn(Handle, u64, usize) -> c_int,
    mem_read: unsafe extern "C" fn(Handle, u64, *mut c_void, usize) -> c_int,
    mem_write: unsafe extern "C" fn(Handle, u64, *const c_void, usize) -> c_int,
    reg_read: unsafe extern "C" fn(Handle, c_int, *mut c_void) -> c_int,
    reg_write: unsafe extern "C" fn(Handle, c_int, *const c_void) -> c_int,
    emu_start: unsafe extern "C" fn(Handle, u64, u64, u64, usize) -> c_int,
    emu_stop: unsafe extern "C" fn(Handle) -> c_int,
    hook_add: unsafe extern "C" fn(
        Handle,
        *mut HookHandle,
        c_int,
        *mut c_void,
        *mut c_void,
        u64,
        u64,
    ) -> c_int,
    hook_del: unsafe extern "C" fn(Handle, HookHandle) -> c_int,
}
#[derive(Clone, Copy)]
pub struct Guest<'a> {
    api: &'a Api,
    handle: Handle,
}
impl Guest<'_> {
    pub fn mem_map(&self, address: u64, size: u64) -> Result<(), ClientError> {
        self.check(unsafe { (self.api.mem_map)(self.handle, address, size as usize, PROT_ALL) })
    }
    pub fn mem_unmap(&self, address: u64, size: u64) -> Result<(), ClientError> {
        self.check(unsafe { (self.api.mem_unmap)(self.handle, address, size as usize) })
    }
    pub fn mem_write(&self, address: u64, data: &[u8]) -> Result<(), ClientError> {
        if data.is_empty() {
            return Ok(());
        }
        self.check(unsafe {
            (self.api.mem_write)(self.handle, address, data.as_ptr().cast(), data.len())
        })
    }
    pub fn mem_read(&self, address: u64, size: usize) -> Result<Vec<u8>, ClientError> {
        let mut data = vec![0u8; size];
        self.mem_read_into(address, &mut data)?;
        Ok(data)
    }
    pub fn mem_read_into(&self, address: u64, data: &mut [u8]) -> Result<(), ClientError> {
        if data.is_empty() {
            return Ok(());
        }
        self.check(unsafe {
            (self.api.mem_read)(self.handle, address, data.as_mut_ptr().cast(), data.len())
        })
    }
    pub fn reg_read(&self, register: i32) -> Result<u64, ClientError> {
        let mut value = 0u64;
        self.check(unsafe { (self.api.reg_read)(self.handle, register, (&raw mut value).cast()) })?;
        Ok(value)
    }
    pub fn reg_write(&self, register: i32, value: u64) -> Result<(), ClientError> {
        self.check(unsafe {
            (self.api.reg_write)(self.handle, register, (&raw const value).cast())
        })
    }
    pub fn stop(&self) -> Result<(), ClientError> {
        self.check(unsafe { (self.api.emu_stop)(self.handle) })
    }
    fn check(&self, code: c_int) -> Result<(), ClientError> {
        if code == 0 {
            return Ok(());
        }
        let message = unsafe { CStr::from_ptr((self.api.strerror)(code)) }
            .to_string_lossy()
            .into_owned();
        Err(ClientError::Sap(format!("unicorn error {code}: {message}")))
    }
}
type CodeHook = Box<dyn FnMut(Guest<'_>, u64, u32) -> Result<(), ClientError>>;
struct HookData {
    callback: CodeHook,
    api: *const Api,
    handle: Handle,
    fault: Option<ClientError>,
}
struct HookSlot {
    data: Box<HookData>,
    handle: HookHandle,
}
pub struct Engine {
    api: Box<Api>,
    handle: Handle,
    hooks: Vec<HookSlot>,
    _library: Library,
    _dependencies: Vec<Library>,
}
impl Engine {
    pub async fn open(client: &AppleClient, cache_dir: &Path) -> Result<Self, ClientError> {
        let paths = library::ensure(client, cache_dir).await?;
        let (dependencies, library) = unsafe { library::open(&paths) }?;
        let api = unsafe {
            Box::new(Api {
                version: symbol(&library, b"uc_version\0")?,
                open: symbol(&library, b"uc_open\0")?,
                close: symbol(&library, b"uc_close\0")?,
                strerror: symbol(&library, b"uc_strerror\0")?,
                mem_map: symbol(&library, b"uc_mem_map\0")?,
                mem_unmap: symbol(&library, b"uc_mem_unmap\0")?,
                mem_read: symbol(&library, b"uc_mem_read\0")?,
                mem_write: symbol(&library, b"uc_mem_write\0")?,
                reg_read: symbol(&library, b"uc_reg_read\0")?,
                reg_write: symbol(&library, b"uc_reg_write\0")?,
                emu_start: symbol(&library, b"uc_emu_start\0")?,
                emu_stop: symbol(&library, b"uc_emu_stop\0")?,
                hook_add: symbol(&library, b"uc_hook_add\0")?,
                hook_del: symbol(&library, b"uc_hook_del\0")?,
            })
        };
        let mut major = 0u32;
        let mut minor = 0u32;
        unsafe { (api.version)(&raw mut major, &raw mut minor) };
        if (major, minor) != (2, 1) {
            return Err(ClientError::Sap(format!(
                "unsupported Unicorn API version {major}.{minor}"
            )));
        }
        let mut handle: Handle = std::ptr::null_mut();
        let code = unsafe { (api.open)(ARCH_X86, MODE_64, &raw mut handle) };
        if code != 0 || handle.is_null() {
            return Err(ClientError::Sap(format!(
                "create x86-64 emulator: unicorn error {code}"
            )));
        }
        Ok(Self {
            api,
            handle,
            hooks: Vec::new(),
            _library: library,
            _dependencies: dependencies,
        })
    }
    pub fn guest(&self) -> Guest<'_> {
        Guest {
            api: &self.api,
            handle: self.handle,
        }
    }
    pub fn add_code_hook(
        &mut self,
        begin: u64,
        end: u64,
        callback: impl FnMut(Guest<'_>, u64, u32) -> Result<(), ClientError> + 'static,
    ) -> Result<(), ClientError> {
        let mut data = Box::new(HookData {
            callback: Box::new(callback),
            api: &raw const *self.api,
            handle: self.handle,
            fault: None,
        });
        let mut hook_handle: HookHandle = 0;
        let user_data: *mut c_void = (&raw mut *data).cast();
        let code = unsafe {
            (self.api.hook_add)(
                self.handle,
                &raw mut hook_handle,
                HOOK_CODE,
                code_hook_trampoline as *mut c_void,
                user_data,
                begin,
                end,
            )
        };
        self.guest().check(code)?;
        self.hooks.push(HookSlot {
            data,
            handle: hook_handle,
        });
        Ok(())
    }
    pub fn start(
        &mut self,
        begin: u64,
        end: u64,
        timeout: Duration,
        instruction_limit: usize,
    ) -> Result<(), ClientError> {
        let microseconds = u64::try_from(timeout.as_micros())
            .unwrap_or(u64::MAX)
            .max(1);
        self.clear_faults();
        let code = unsafe {
            (self.api.emu_start)(self.handle, begin, end, microseconds, instruction_limit)
        };
        if let Some(fault) = self.take_fault() {
            return Err(fault);
        }
        self.guest().check(code)
    }
    fn clear_faults(&mut self) {
        for slot in &mut self.hooks {
            slot.data.fault = None;
        }
    }
    fn take_fault(&mut self) -> Option<ClientError> {
        self.hooks
            .iter_mut()
            .find_map(|slot| slot.data.fault.take())
    }
}
impl Drop for Engine {
    fn drop(&mut self) {
        for slot in &self.hooks {
            unsafe { (self.api.hook_del)(self.handle, slot.handle) };
        }
        unsafe { (self.api.close)(self.handle) };
    }
}
unsafe extern "C" fn code_hook_trampoline(
    _engine: Handle,
    address: u64,
    size: u32,
    user_data: *mut c_void,
) {
    let data = user_data.cast::<HookData>();
    let data = unsafe { &mut *data };
    if data.fault.is_some() {
        return;
    }
    let guest = Guest {
        api: unsafe { &*data.api },
        handle: data.handle,
    };
    let result = catch_unwind(AssertUnwindSafe(|| (data.callback)(guest, address, size)));
    let fault = match result {
        Ok(Ok(())) => return,
        Ok(Err(e)) => e,
        Err(_) => ClientError::Sap(format!("guest hook panicked at {address:#x}")),
    };
    data.fault = Some(fault);
    let _ = guest.stop();
}
unsafe fn symbol<T: Copy>(library: &Library, name: &[u8]) -> Result<T, ClientError> {
    let symbol: libloading::Symbol<T> = unsafe { library.get(name) }.map_err(|e| {
        ClientError::Sap(format!(
            "Unicorn library is missing {}: {e}",
            String::from_utf8_lossy(&name[..name.len() - 1])
        ))
    })?;
    Ok(*symbol)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn test_client() -> AppleClient {
        crate::client::AppleClient::for_tests()
    }
    fn cache() -> std::path::PathBuf {
        std::env::temp_dir().join("dkrypt-appstore-unicorn-test")
    }
    async fn engine() -> Engine {
        Engine::open(&test_client(), &cache())
            .await
            .expect("open engine")
    }
    const CODE: u64 = 0x1000;
    const RETURN: u64 = 0x2000;
    #[tokio::test]
    #[ignore = "requires network access to files.pythonhosted.org"]
    async fn live_executes_x86_64_and_returns_the_result() {
        let mut engine = engine().await;
        let guest = engine.guest();
        guest.mem_map(CODE, 0x1000).unwrap();
        guest
            .mem_write(CODE, &[0x48, 0x89, 0xF8, 0x48, 0x01, 0xF0, 0xC3])
            .unwrap();
        guest.reg_write(reg::RDI, 40).unwrap();
        guest.reg_write(reg::RSI, 2).unwrap();
        engine
            .start(CODE, CODE + 6, Duration::from_secs(5), 1000)
            .unwrap();
        assert_eq!(engine.guest().reg_read(reg::RAX).unwrap(), 42);
    }
    #[tokio::test]
    #[ignore = "requires network access to files.pythonhosted.org"]
    async fn live_hook_can_service_a_guest_call() {
        let mut engine = engine().await;
        {
            let guest = engine.guest();
            guest.mem_map(CODE, 0x1000).unwrap();
            guest.mem_map(RETURN, 0x1000).unwrap();
            guest.mem_write(RETURN, &[0xC3]).unwrap();
            let offset = (RETURN as i64 - (CODE as i64 + 5)) as i32;
            guest.mem_write(CODE, &[0xE9]).unwrap();
            guest.mem_write(CODE + 1, &offset.to_le_bytes()).unwrap();
        }
        engine
            .add_code_hook(RETURN, RETURN, |guest, _, _| {
                guest.reg_write(reg::RAX, 0xD00D)?;
                guest.stop()
            })
            .unwrap();
        engine.start(CODE, 0, Duration::from_secs(5), 1000).unwrap();
        assert_eq!(engine.guest().reg_read(reg::RAX).unwrap(), 0xD00D);
    }
    #[tokio::test]
    #[ignore = "requires network access to files.pythonhosted.org"]
    async fn live_hook_error_surfaces_from_start() {
        let mut engine = engine().await;
        let guest = engine.guest();
        guest.mem_map(CODE, 0x1000).unwrap();
        guest.mem_write(CODE, &[0x90, 0x90, 0xC3]).unwrap();
        engine
            .add_code_hook(CODE, CODE, |_, address, _| {
                Err(ClientError::Sap(format!("refused at {address:#x}")))
            })
            .unwrap();
        let error = engine
            .start(CODE, CODE + 2, Duration::from_secs(5), 1000)
            .unwrap_err()
            .to_string();
        assert!(error.contains("refused at 0x1000"), "{error}");
    }
}
