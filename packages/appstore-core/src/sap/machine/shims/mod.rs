pub mod memory;
pub mod platform;
use crate::error::ClientError;
use crate::sap::unicorn::{Guest, reg};
use std::collections::HashMap;
pub const SHIM_BASE: u64 = 0x0000_2000_0000_0000;
pub const SHIM_CODE_SIZE: u64 = 0x0008_0000;
pub const SHIM_SIZE: u64 = 0x0010_0000;
const SLOT_SIZE: u64 = 16;
const RET: u8 = 0xC3;
pub const HEAP_BASE: u64 = 0x0000_4000_0000_0000;
pub const HEAP_SIZE: u64 = 64 << 20;
pub const PAGE_SIZE: u64 = 0x1000;
pub const MAX_TRANSFER: u64 = 64 << 20;
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Shim {
    Malloc,
    MallocGoodSize,
    MallocSize,
    Calloc,
    Realloc,
    Free,
    Memmove,
    Memset,
    Bzero,
    MemcpyChk,
    MemsetChk,
    Memcmp,
    Strcmp,
    Strncmp,
    Strlen,
    ReturnZero,
    ReturnFakeHandle,
    ReturnUint32Max,
    ReturnMinusOne,
    CfStringCreate,
    CfStringGetCString,
    IoIteratorNext,
    IoRegistryEntryGetParentEntry,
    IoServiceGetMatchingServices,
    CompareAndSwap32,
    ErrorPointer,
    Abort,
    Arc4Random,
    Dlopen,
    Dlsym,
    Gettimeofday,
    ObjcMsgSend,
    Open,
    PthreadOnce,
    Read,
    Sysctlbyname,
    Unsupported(String),
}
#[derive(Debug, Clone, Copy)]
pub struct Allocation {
    pub size: u64,
    pub reserved: u64,
}
#[derive(Debug, Clone, Copy)]
pub struct FreeBlock {
    pub address: u64,
    pub size: u64,
}
pub struct Shims {
    entries: HashMap<u64, Shim>,
    symbols: HashMap<String, u64>,
    code_cursor: u64,
    data_cursor: u64,
    pub allocations: HashMap<u64, Allocation>,
    pub free_blocks: Vec<FreeBlock>,
    pub heap_cursor: u64,
    pub errno: u64,
    pub icxs: Vec<u8>,
    pub icxs_offset: usize,
    pub iterator: u32,
    pub core_exports: HashMap<String, u64>,
}
impl Shims {
    pub fn new(
        guest: &Guest<'_>,
        core_exports: HashMap<String, u64>,
        icxs: Vec<u8>,
    ) -> Result<Self, ClientError> {
        guest.mem_map(SHIM_BASE, SHIM_SIZE)?;
        let mut shims = Self {
            entries: HashMap::new(),
            symbols: HashMap::new(),
            code_cursor: SHIM_BASE,
            data_cursor: SHIM_BASE + SHIM_CODE_SIZE,
            allocations: HashMap::new(),
            free_blocks: Vec::new(),
            heap_cursor: 0,
            errno: 0,
            icxs,
            icxs_offset: 0,
            iterator: 0,
            core_exports,
        };
        memory::register(&mut shims, guest)?;
        platform::register(&mut shims, guest)?;
        Ok(shims)
    }
    pub fn resolve(&mut self, name: &str, guest: &Guest<'_>) -> Result<u64, ClientError> {
        if let Some(address) = self.symbols.get(name) {
            return Ok(*address);
        }
        self.add_function(name, Shim::Unsupported(name.to_string()), guest)
    }
    pub fn add_aliases(
        &mut self,
        names: &[&str],
        shim: Shim,
        guest: &Guest<'_>,
    ) -> Result<(), ClientError> {
        for name in names {
            self.add_function(name, shim.clone(), guest)?;
        }
        Ok(())
    }
    pub fn add_function(
        &mut self,
        name: &str,
        shim: Shim,
        guest: &Guest<'_>,
    ) -> Result<u64, ClientError> {
        if let Some(address) = self.symbols.get(name) {
            return Ok(*address);
        }
        if self.code_cursor + SLOT_SIZE > SHIM_BASE + SHIM_CODE_SIZE {
            return Err(ClientError::Sap("guest stub area is full".into()));
        }
        let address = self.code_cursor;
        self.code_cursor += SLOT_SIZE;
        guest.mem_write(address, &[RET])?;
        self.entries.insert(address, shim);
        self.symbols.insert(name.to_string(), address);
        Ok(address)
    }
    pub fn add_data(
        &mut self,
        name: &str,
        data: &[u8],
        guest: &Guest<'_>,
    ) -> Result<u64, ClientError> {
        if let Some(address) = self.symbols.get(name) {
            return Ok(*address);
        }
        self.data_cursor = self.data_cursor.next_multiple_of(8);
        if self.data_cursor + data.len() as u64 > SHIM_BASE + SHIM_SIZE {
            return Err(ClientError::Sap("guest data area is full".into()));
        }
        let address = self.data_cursor;
        self.data_cursor += (data.len() as u64).max(8);
        guest.mem_write(address, data)?;
        self.symbols.insert(name.to_string(), address);
        Ok(address)
    }
}
pub fn dispatch(shims: &mut Shims, guest: Guest<'_>, address: u64) -> Result<(), ClientError> {
    let Some(shim) = shims.entries.get(&address).cloned() else {
        return Err(ClientError::Sap(format!(
            "guest entered unknown stub {address:#x}"
        )));
    };
    memory::handle(shims, &guest, &shim)
        .or_else(|| platform::handle(shims, &guest, &shim))
        .unwrap_or_else(|| {
            Err(ClientError::Sap(match &shim {
                Shim::Unsupported(name) => format!("guest called unsupported import {name}"),
                other => format!("no handler for {other:?}"),
            }))
        })
}
pub fn argument(guest: &Guest<'_>, index: usize) -> Result<u64, ClientError> {
    const REGISTERS: [i32; 6] = [reg::RDI, reg::RSI, reg::RDX, reg::RCX, reg::R8, reg::R9];
    if let Some(register) = REGISTERS.get(index) {
        return guest.reg_read(*register);
    }
    let stack = guest.reg_read(reg::RSP)?;
    let slot = stack + 8 + (index - REGISTERS.len()) as u64 * 8;
    read_u64(guest, slot)
}
pub fn set_result(guest: &Guest<'_>, value: u64) -> Result<(), ClientError> {
    guest.reg_write(reg::RAX, value)
}
pub fn read_u32(guest: &Guest<'_>, address: u64) -> Result<u32, ClientError> {
    let data = guest.mem_read(address, 4)?;
    Ok(u32::from_le_bytes(data.try_into().unwrap()))
}
pub fn write_u32(guest: &Guest<'_>, address: u64, value: u32) -> Result<(), ClientError> {
    guest.mem_write(address, &value.to_le_bytes())
}
pub fn read_u64(guest: &Guest<'_>, address: u64) -> Result<u64, ClientError> {
    let data = guest.mem_read(address, 8)?;
    Ok(u64::from_le_bytes(data.try_into().unwrap()))
}
pub fn write_u64(guest: &Guest<'_>, address: u64, value: u64) -> Result<(), ClientError> {
    guest.mem_write(address, &value.to_le_bytes())
}
pub fn read_c_string(guest: &Guest<'_>, address: u64) -> Result<String, ClientError> {
    const MAX: usize = 4096;
    let mut out = Vec::new();
    let mut cursor = address;
    while out.len() < MAX {
        let chunk = (PAGE_SIZE - cursor % PAGE_SIZE).min((MAX - out.len()) as u64);
        let data = guest.mem_read(cursor, chunk as usize)?;
        if let Some(end) = data.iter().position(|&b| b == 0) {
            out.extend_from_slice(&data[..end]);
            return Ok(String::from_utf8_lossy(&out).into_owned());
        }
        out.extend_from_slice(&data);
        cursor += chunk;
    }
    Err(ClientError::Sap(format!(
        "guest string at {address:#x} exceeds {MAX} bytes"
    )))
}
pub fn checked_size(value: u64) -> Result<usize, ClientError> {
    if value > MAX_TRANSFER {
        return Err(ClientError::Sap(format!(
            "guest transfer size {value} exceeds {MAX_TRANSFER}"
        )));
    }
    Ok(value as usize)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stack_arguments_skip_the_return_address() {
        const REGISTER_COUNT: usize = 6;
        let stack = 0x500u64;
        assert_eq!(
            stack + 8 + (REGISTER_COUNT - REGISTER_COUNT) as u64 * 8,
            0x508
        );
        assert_eq!(stack + 8 + (7 - REGISTER_COUNT) as u64 * 8, 0x510);
    }
    #[test]
    fn transfer_sizes_are_bounded() {
        assert_eq!(checked_size(0).unwrap(), 0);
        assert_eq!(checked_size(MAX_TRANSFER).unwrap(), MAX_TRANSFER as usize);
        assert!(checked_size(MAX_TRANSFER + 1).is_err());
    }
}
