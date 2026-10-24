use crate::error::ClientError;
use std::ffi::c_void;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use windows_sys::Win32::System::Memory::{
    MEM_COMMIT, MEM_RELEASE, MEM_RESERVE, PAGE_EXECUTE_READ, PAGE_EXECUTE_READWRITE,
    PAGE_PROTECTION_FLAGS, PAGE_READWRITE, VirtualFree, VirtualProtect,
};
use windows_sys::Win32::System::Threading::GetCurrentProcess;
const DOS_MAGIC: u16 = 0x5A4D;
const PE_SIGNATURE: u32 = 0x0000_4550;
const PE32_PLUS_MAGIC: u16 = 0x020B;
const LFANEW_OFFSET: usize = 0x3C;
const OPTIONAL_HEADER_OFFSET: usize = 24;
const SIZE_OF_IMAGE_OFFSET: usize = 56;
const DATA_DIRECTORY_OFFSET: usize = 112;
const IMPORT_DIRECTORY_INDEX: usize = 1;
const IMPORT_DESCRIPTOR_SIZE: usize = 20;
const ORDINAL_FLAG: u64 = 1 << 63;
type VirtualAllocFn =
    unsafe extern "system" fn(*mut c_void, usize, u32, PAGE_PROTECTION_FLAGS) -> *mut c_void;
static ORIGINAL_VIRTUAL_ALLOC: AtomicUsize = AtomicUsize::new(0);
static AMD64_LONGJMP_ADDRESS: AtomicUsize = AtomicUsize::new(0);
static PREPARE: Mutex<()> = Mutex::new(());
#[cfg(target_arch = "x86_64")]
const AMD64_LONGJMP: &[u8] = &[
    0x89, 0xD0, 0x85, 0xC0, 0x75, 0x02, 0xFF, 0xC0, 0x0F, 0xAE, 0x51, 0x58, 0xD9, 0x69, 0x5C, 0xF3,
    0x0F, 0x6F, 0x71, 0x60, 0xF3, 0x0F, 0x6F, 0x79, 0x70, 0xF3, 0x44, 0x0F, 0x6F, 0x81, 0x80, 0x00,
    0x00, 0x00, 0xF3, 0x44, 0x0F, 0x6F, 0x89, 0x90, 0x00, 0x00, 0x00, 0xF3, 0x44, 0x0F, 0x6F, 0x91,
    0xA0, 0x00, 0x00, 0x00, 0xF3, 0x44, 0x0F, 0x6F, 0x99, 0xB0, 0x00, 0x00, 0x00, 0xF3, 0x44, 0x0F,
    0x6F, 0xA1, 0xC0, 0x00, 0x00, 0x00, 0xF3, 0x44, 0x0F, 0x6F, 0xA9, 0xD0, 0x00, 0x00, 0x00, 0xF3,
    0x44, 0x0F, 0x6F, 0xB1, 0xE0, 0x00, 0x00, 0x00, 0xF3, 0x44, 0x0F, 0x6F, 0xB9, 0xF0, 0x00, 0x00,
    0x00, 0x48, 0x8B, 0x59, 0x08, 0x48, 0x8B, 0x69, 0x18, 0x48, 0x8B, 0x71, 0x20, 0x48, 0x8B, 0x79,
    0x28, 0x4C, 0x8B, 0x61, 0x30, 0x4C, 0x8B, 0x69, 0x38, 0x4C, 0x8B, 0x71, 0x40, 0x4C, 0x8B, 0x79,
    0x48, 0x4C, 0x8B, 0x59, 0x50, 0x48, 0x8B, 0x61, 0x10, 0x41, 0xFF, 0xE3,
];
#[cfg(target_arch = "aarch64")]
const MINGW_LONGJMP_PATTERN: &[u8] = &[
    0x13, 0x50, 0x41, 0xA9, 0x15, 0x58, 0x42, 0xA9, 0x17, 0x60, 0x43, 0xA9, 0x19, 0x68, 0x44, 0xA9,
];
pub unsafe fn prepare(base: *const u8) -> Result<(), ClientError> {
    let _guard = PREPARE
        .lock()
        .map_err(|_| ClientError::Sap("Unicorn preparation is poisoned".into()))?;
    let image = unsafe { Image::parse(base) }?;
    unsafe { install_virtual_alloc_hook(&image) }?;
    unsafe { redirect_longjmp(&image) }
}
unsafe fn install_virtual_alloc_hook(image: &Image) -> Result<(), ClientError> {
    let slot = unsafe { image.find_import("kernel32.dll", "VirtualAlloc") }?;
    let current = unsafe { slot.read() };
    let hook = commit_virtual_alloc as VirtualAllocFn as usize;
    if current == hook {
        if ORIGINAL_VIRTUAL_ALLOC.load(Ordering::Acquire) == 0 {
            return Err(ClientError::Sap(
                "VirtualAlloc hook has no original function".into(),
            ));
        }
        return Ok(());
    }
    let known = ORIGINAL_VIRTUAL_ALLOC.load(Ordering::Acquire);
    if known != 0 && known != current {
        return Err(ClientError::Sap(
            "VirtualAlloc import changed unexpectedly".into(),
        ));
    }
    ORIGINAL_VIRTUAL_ALLOC.store(current, Ordering::Release);
    unsafe { replace_import(slot, hook) }
        .map_err(|e| ClientError::Sap(format!("replace VirtualAlloc import: {e}")))
}
unsafe extern "system" fn commit_virtual_alloc(
    address: *mut c_void,
    size: usize,
    mut allocation_type: u32,
    protection: PAGE_PROTECTION_FLAGS,
) -> *mut c_void {
    if allocation_type == MEM_RESERVE && protection == PAGE_EXECUTE_READWRITE {
        allocation_type |= MEM_COMMIT;
    }
    let original = ORIGINAL_VIRTUAL_ALLOC.load(Ordering::Acquire);
    if original == 0 {
        return std::ptr::null_mut();
    }
    let original: VirtualAllocFn = unsafe { std::mem::transmute(original) };
    unsafe { original(address, size, allocation_type, protection) }
}
#[cfg(target_arch = "x86_64")]
unsafe fn redirect_longjmp(image: &Image) -> Result<(), ClientError> {
    let slot = unsafe { image.find_import("msvcrt.dll", "longjmp") }?;
    let replacement = unsafe { allocate_amd64_longjmp() }?;
    unsafe { replace_import(slot, replacement) }
        .map_err(|e| ClientError::Sap(format!("replace longjmp import: {e}")))
}
#[cfg(target_arch = "aarch64")]
unsafe fn redirect_longjmp(image: &Image) -> Result<(), ClientError> {
    let slot = unsafe { image.find_import("api-ms-win-crt-private-l1-1-0.dll", "longjmp") }?;
    let replacement = unsafe { image.find_unique_pattern(MINGW_LONGJMP_PATTERN) }
        .map_err(|e| ClientError::Sap(format!("locate MinGW longjmp implementation: {e}")))?;
    unsafe { replace_import(slot, replacement) }
        .map_err(|e| ClientError::Sap(format!("replace longjmp import: {e}")))
}
#[cfg(target_arch = "x86_64")]
unsafe fn allocate_amd64_longjmp() -> Result<usize, ClientError> {
    let existing = AMD64_LONGJMP_ADDRESS.load(Ordering::Acquire);
    if existing != 0 {
        return Ok(existing);
    }
    let original = ORIGINAL_VIRTUAL_ALLOC.load(Ordering::Acquire);
    if original == 0 {
        return Err(ClientError::Sap(
            "cannot allocate longjmp before the VirtualAlloc hook is installed".into(),
        ));
    }
    let allocate: VirtualAllocFn = unsafe { std::mem::transmute(original) };
    let address = unsafe {
        allocate(
            std::ptr::null_mut(),
            AMD64_LONGJMP.len(),
            MEM_RESERVE | MEM_COMMIT,
            PAGE_READWRITE,
        )
    };
    if address.is_null() {
        return Err(ClientError::Sap("allocate compatible longjmp".into()));
    }
    let release = || unsafe { VirtualFree(address, 0, MEM_RELEASE) };
    unsafe {
        std::ptr::copy_nonoverlapping(
            AMD64_LONGJMP.as_ptr(),
            address.cast::<u8>(),
            AMD64_LONGJMP.len(),
        );
    }
    let mut previous: PAGE_PROTECTION_FLAGS = 0;
    if unsafe {
        VirtualProtect(
            address,
            AMD64_LONGJMP.len(),
            PAGE_EXECUTE_READ,
            &raw mut previous,
        )
    } == 0
    {
        release();
        return Err(ClientError::Sap(
            "make compatible longjmp executable".into(),
        ));
    }
    if unsafe {
        windows_sys::Win32::System::Diagnostics::Debug::FlushInstructionCache(
            GetCurrentProcess(),
            address,
            AMD64_LONGJMP.len(),
        )
    } == 0
    {
        release();
        return Err(ClientError::Sap(
            "flush compatible longjmp instructions".into(),
        ));
    }
    let address = address as usize;
    AMD64_LONGJMP_ADDRESS.store(address, Ordering::Release);
    Ok(address)
}
unsafe fn replace_import(slot: Slot, replacement: usize) -> Result<(), ClientError> {
    if unsafe { slot.read() } == replacement {
        return Ok(());
    }
    let address = slot.0.cast::<c_void>().cast_mut();
    let size = size_of::<usize>();
    let mut previous: PAGE_PROTECTION_FLAGS = 0;
    if unsafe { VirtualProtect(address, size, PAGE_READWRITE, &raw mut previous) } == 0 {
        return Err(ClientError::Sap("make import table writable".into()));
    }
    unsafe { slot.0.cast_mut().write(replacement) };
    let mut ignored: PAGE_PROTECTION_FLAGS = 0;
    if unsafe { VirtualProtect(address, size, previous, &raw mut ignored) } == 0 {
        return Err(ClientError::Sap("restore import table protection".into()));
    }
    Ok(())
}
#[derive(Debug, Clone, Copy)]
struct Slot(*const usize);
impl Slot {
    unsafe fn read(self) -> usize {
        unsafe { self.0.read() }
    }
}
struct Image {
    base: *const u8,
    size: usize,
    imports: usize,
}
impl Image {
    unsafe fn parse(base: *const u8) -> Result<Self, ClientError> {
        if unsafe { read_u16(base) } != DOS_MAGIC {
            return Err(ClientError::Sap("invalid DOS header".into()));
        }
        let nt = unsafe { base.add(read_u32(base.add(LFANEW_OFFSET)) as usize) };
        if unsafe { read_u32(nt) } != PE_SIGNATURE {
            return Err(ClientError::Sap("invalid PE header".into()));
        }
        let optional = unsafe { nt.add(OPTIONAL_HEADER_OFFSET) };
        if unsafe { read_u16(optional) } != PE32_PLUS_MAGIC {
            return Err(ClientError::Sap("Unicorn is not a 64-bit PE image".into()));
        }
        let size = unsafe { read_u32(optional.add(SIZE_OF_IMAGE_OFFSET)) } as usize;
        let import_rva =
            unsafe { read_u32(optional.add(DATA_DIRECTORY_OFFSET + IMPORT_DIRECTORY_INDEX * 8)) }
                as usize;
        if size == 0 || import_rva == 0 {
            return Err(ClientError::Sap("PE import directory is missing".into()));
        }
        let image = Self {
            base,
            size,
            imports: import_rva,
        };
        image.require_range(import_rva, IMPORT_DESCRIPTOR_SIZE)?;
        Ok(image)
    }
    unsafe fn find_import(&self, dll: &str, function: &str) -> Result<Slot, ClientError> {
        let mut descriptor = self.imports;
        loop {
            self.require_range(descriptor, IMPORT_DESCRIPTOR_SIZE)?;
            let name_rva = unsafe { read_u32(self.at(descriptor + 12)) } as usize;
            if name_rva == 0 {
                break;
            }
            if !unsafe { self.read_string(name_rva) }?.eq_ignore_ascii_case(dll) {
                descriptor += IMPORT_DESCRIPTOR_SIZE;
                continue;
            }
            let names = unsafe { read_u32(self.at(descriptor)) } as usize;
            let addresses = unsafe { read_u32(self.at(descriptor + 16)) } as usize;
            if names == 0 || addresses == 0 {
                break;
            }
            for index in 0.. {
                let name_slot = names + index * 8;
                let address_slot = addresses + index * 8;
                self.require_range(name_slot, 8)?;
                self.require_range(address_slot, 8)?;
                let entry = unsafe { read_u64(self.at(name_slot)) };
                if entry == 0 {
                    break;
                }
                if entry & ORDINAL_FLAG != 0 {
                    continue;
                }
                if unsafe { self.read_string(entry as usize + 2) }? == function {
                    return Ok(Slot(self.at(address_slot).cast::<usize>()));
                }
            }
            break;
        }
        Err(ClientError::Sap(format!(
            "{dll}!{function} import was not found"
        )))
    }
    #[cfg(target_arch = "aarch64")]
    unsafe fn find_unique_pattern(&self, pattern: &[u8]) -> Result<usize, ClientError> {
        let image = unsafe { std::slice::from_raw_parts(self.base, self.size) };
        let mut found = None;
        for (offset, window) in image.windows(pattern.len()).enumerate() {
            if window != pattern {
                continue;
            }
            if found.is_some() {
                return Err(ClientError::Sap("instruction pattern is not unique".into()));
            }
            found = Some(offset);
        }
        found
            .map(|offset| self.base as usize + offset)
            .ok_or_else(|| ClientError::Sap("instruction pattern was not found".into()))
    }
    fn at(&self, rva: usize) -> *const u8 {
        unsafe { self.base.add(rva) }
    }
    fn require_range(&self, rva: usize, size: usize) -> Result<(), ClientError> {
        if rva > self.size || size > self.size - rva {
            return Err(ClientError::Sap(
                "PE import table extends beyond the image".into(),
            ));
        }
        Ok(())
    }
    unsafe fn read_string(&self, rva: usize) -> Result<String, ClientError> {
        if rva >= self.size {
            return Err(ClientError::Sap(
                "PE string extends beyond the image".into(),
            ));
        }
        let data = unsafe { std::slice::from_raw_parts(self.at(rva), self.size - rva) };
        let end = data
            .iter()
            .position(|&byte| byte == 0)
            .ok_or_else(|| ClientError::Sap("PE string is not terminated".into()))?;
        Ok(String::from_utf8_lossy(&data[..end]).into_owned())
    }
}
unsafe fn read_u16(address: *const u8) -> u16 {
    unsafe { address.cast::<u16>().read_unaligned() }
}
unsafe fn read_u32(address: *const u8) -> u32 {
    unsafe { address.cast::<u32>().read_unaligned() }
}
unsafe fn read_u64(address: *const u8) -> u64 {
    unsafe { address.cast::<u64>().read_unaligned() }
}
#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    #[test]
    fn parses_a_real_loaded_image() {
        let base = unsafe { GetModuleHandleW(std::ptr::null()) };
        assert!(!base.is_null());
        let image = unsafe { Image::parse(base.cast()) }.expect("parse the running image");
        assert!(image.size > 0);
        assert!(image.imports > 0);
    }
    #[test]
    fn finds_a_known_import() {
        let base = unsafe { GetModuleHandleW(std::ptr::null()) };
        let image = unsafe { Image::parse(base.cast()) }.unwrap();
        let slot = unsafe { image.find_import("kernel32.dll", "GetProcAddress") }
            .expect("kernel32!GetProcAddress");
        assert_ne!(unsafe { slot.read() }, 0);
    }
    #[test]
    fn reports_an_absent_import_rather_than_misparsing() {
        let base = unsafe { GetModuleHandleW(std::ptr::null()) };
        let image = unsafe { Image::parse(base.cast()) }.unwrap();
        let error = unsafe { image.find_import("kernel32.dll", "NoSuchFunctionExists") }
            .unwrap_err()
            .to_string();
        assert!(error.contains("import was not found"), "{error}");
    }
    #[test]
    fn rejects_something_that_is_not_a_pe_image() {
        let data = [0u8; 64];
        assert!(unsafe { Image::parse(data.as_ptr()) }.is_err());
    }
    #[test]
    fn bounds_are_checked_against_the_declared_size() {
        let image = Image {
            base: std::ptr::null(),
            size: 100,
            imports: 0,
        };
        assert!(image.require_range(0, 100).is_ok());
        assert!(image.require_range(92, 8).is_ok());
        assert!(image.require_range(92, 9).is_err());
        assert!(image.require_range(101, 0).is_err());
    }
}
