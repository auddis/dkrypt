pub mod shims;
use crate::client::AppleClient;
use crate::error::ClientError;
use crate::sap::assets::Bundle;
use crate::sap::macho::{self, Image};
use crate::sap::unicorn::{Engine, Guest, reg};
use crate::sap::{SapMachine, unicorn};
use shims::{Shim, Shims};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
const RETURN_ADDRESS: u64 = 0x0000_0001_0000_0000;
const HLT: u8 = 0xF4;
const CORE_FP_BASE: u64 = 0x0000_1000_0000_0000;
const COMMERCE_BASE: u64 = 0x0000_1000_4000_0000;
const KIT_BASE: u64 = 0x0000_1000_8000_0000;
const STORE_AGENT_BASE: u64 = 0x0000_1000_C000_0000;
const STORE_AGENT_GLOBAL_INIT: u64 = STORE_AGENT_BASE + 0x0C5FC0;
const STORE_AGENT_KBSYNC_ENTRY: u64 = STORE_AGENT_BASE + 0x0C93C0;
const STORE_AGENT_SC_INFO_PATH: &[u8] = b"/Users/Shared/SC Info\0";
const STORE_AGENT_ZERO_RETURN_ALIASES: &[&str] = &[
    "_pthread_rwlock_rdlock",
    "_pthread_rwlock_rdlock$UNIX2003",
    "_pthread_mutex_init",
    "_pthread_mutex_destroy",
    "_pthread_rwlock_destroy",
];
const SCRATCH_BASE: u64 = 0x0000_3000_0000_0000;
const SCRATCH_SIZE: u64 = 32 << 20;
const STACK_BASE: u64 = 0x0000_5000_0000_0000;
const STACK_SIZE: u64 = 8 << 20;
const STACK_END: u64 = STACK_BASE + STACK_SIZE;
const PAGE_SIZE: u64 = 0x1000;
const MAX_OUTPUT: u64 = 16 << 20;
const CALL_TIMEOUT: Duration = Duration::from_secs(60);
const CALL_INSTRUCTION_LIMIT: usize = 0;
const CORE_EXPORTS: &[&str] = &[
    "_WIn9UJ86JKdV4dM",
    "_X46O5IeS",
    "_YlCJ3lg",
    "_dku592fbFAj",
    "_fdjkDSAFjklaf2s",
    "_lxpgvVMLd0S7uRl",
];
struct EntryPoints {
    initialize: u64,
    exchange: u64,
    sign: u64,
    teardown: u64,
    dispose: u64,
    store_agent_global_init: u64,
    store_agent_kbsync: u64,
}
struct Inner {
    engine: Engine,
    entry: EntryPoints,
    scratch_cursor: u64,
}
pub struct Machine {
    inner: Mutex<Inner>,
}
unsafe impl Send for Inner {}
impl Machine {
    pub async fn open(
        client: &AppleClient,
        cache_dir: &std::path::Path,
        bundle: &Bundle,
    ) -> Result<Self, ClientError> {
        let mut core_fp = Image::open("CoreFP", &bundle.core_fp)?;
        let mut commerce_core = Image::open("CommerceCore", &bundle.commerce_core)?;
        let mut commerce_kit = Image::open("CommerceKit", &bundle.commerce_kit)?;
        let mut store_agent = Image::open("StoreAgent", &bundle.store_agent)?;
        let mut exports = HashMap::new();
        let mut core_exports = HashMap::new();
        for name in CORE_EXPORTS {
            let address = core_fp.export(name, CORE_FP_BASE)?;
            exports.insert((*name).to_string(), address);
            core_exports.insert((*name).to_string(), address);
        }
        exports.insert(
            "_get_mac_address".to_string(),
            commerce_core.export("_get_mac_address", COMMERCE_BASE)?,
        );
        let entry = EntryPoints {
            initialize: commerce_kit.export("_cp2g1b9ro", KIT_BASE)?,
            exchange: commerce_kit.export("_Mib5yocT", KIT_BASE)?,
            sign: commerce_kit.export("_Fc3vhtJDvr", KIT_BASE)?,
            teardown: commerce_kit.export("_IPaI1oem5iL", KIT_BASE)?,
            dispose: commerce_kit.export("_jEHf8Xzsv8K", KIT_BASE)?,
            store_agent_global_init: STORE_AGENT_GLOBAL_INIT,
            store_agent_kbsync: STORE_AGENT_KBSYNC_ENTRY,
        };
        for (name, address) in &[
            ("_cp2g1b9ro", entry.initialize),
            ("_Mib5yocT", entry.exchange),
            ("_Fc3vhtJDvr", entry.sign),
            ("_IPaI1oem5iL", entry.teardown),
            ("_jEHf8Xzsv8K", entry.dispose),
        ] {
            exports.insert((*name).to_string(), *address);
        }
        let mut engine = Engine::open(client, cache_dir).await?;
        {
            let guest = engine.guest();
            for (address, size) in [
                (RETURN_ADDRESS, PAGE_SIZE),
                (SCRATCH_BASE, SCRATCH_SIZE),
                (shims::HEAP_BASE, shims::HEAP_SIZE),
                (STACK_BASE, STACK_SIZE),
            ] {
                guest.mem_map(address, size)?;
            }
            guest.mem_write(RETURN_ADDRESS, &[HLT])?;
        }
        let mut shims = Shims::new(&engine.guest(), core_exports, bundle.core_fp_icxs.clone())?;
        shims.add_aliases(
            STORE_AGENT_ZERO_RETURN_ALIASES,
            Shim::ReturnZero,
            &engine.guest(),
        )?;
        {
            let guest = engine.guest();
            for (image, base) in [
                (&mut core_fp, CORE_FP_BASE),
                (&mut commerce_core, COMMERCE_BASE),
                (&mut commerce_kit, KIT_BASE),
                (&mut store_agent, STORE_AGENT_BASE),
            ] {
                image.relocate(base, |name| match exports.get(name) {
                    Some(address) => Ok(*address),
                    None => shims.resolve(name, &guest),
                })?;
                image.load(&guest)?;
            }
        }
        let hook_shims = Arc::new(Mutex::new(shims));
        engine.add_code_hook(
            shims::SHIM_BASE,
            shims::SHIM_BASE + shims::SHIM_CODE_SIZE - 1,
            move |guest, address, _| {
                let mut shims = hook_shims
                    .lock()
                    .map_err(|_| ClientError::Sap("shim state is poisoned".into()))?;
                shims::dispatch(&mut shims, guest, address)
            },
        )?;
        Ok(Self {
            inner: Mutex::new(Inner {
                engine,
                entry,
                scratch_cursor: 0,
            }),
        })
    }
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Inner>, ClientError> {
        self.inner
            .lock()
            .map_err(|_| ClientError::Sap("SAP machine is poisoned".into()))
    }
    pub fn generate_kbsync(&self, hardware_id: &[u8], dsid: u64) -> Result<Vec<u8>, ClientError> {
        if dsid == 0 {
            return Err(ClientError::Sap(
                "kbsync requires a nonzero account DSID".into(),
            ));
        }
        let hardware = hardware_block(hardware_id)?;
        let mut inner = self.lock()?;
        inner.begin_call();
        let result = (|| {
            let context_field = inner.scratch(None, 4)?;
            let hardware_address = inner.scratch(Some(&hardware), hardware.len() as u64)?;
            let path_address = inner.scratch(
                Some(STORE_AGENT_SC_INFO_PATH),
                STORE_AGENT_SC_INFO_PATH.len() as u64,
            )?;
            let global_init = inner.entry.store_agent_global_init;
            let status = inner.invoke(
                global_init,
                &[0, hardware_address, path_address, context_field],
            )?;
            if status as i32 != 0 {
                return Err(ClientError::Sap(format!(
                    "StoreAgent global initialization returned {}",
                    status as i32
                )));
            }
            let global_context = shims::read_u32(&inner.engine.guest(), context_field)?;
            if global_context == 0 {
                return Err(ClientError::Sap(
                    "StoreAgent global initialization returned a null context".into(),
                ));
            }
            inner.begin_call();
            let pointer_field = inner.scratch(None, 8)?;
            let length_field = inner.scratch(None, 8)?;
            let kbsync_entry = inner.entry.store_agent_kbsync;
            let status = inner.invoke(
                kbsync_entry,
                [
                    u64::from(global_context),
                    dsid,
                    0,
                    1,
                    pointer_field,
                    length_field,
                ]
                .as_slice(),
            )?;
            let output = inner.consume_output(pointer_field, length_field);
            if status as i32 != 0 {
                return match output {
                    Ok(_) => Err(ClientError::Sap(format!(
                        "StoreAgent kbsync returned {}",
                        status as i32
                    ))),
                    Err(error) => Err(ClientError::Sap(format!(
                        "StoreAgent kbsync returned {} and output cleanup failed: {error}",
                        status as i32
                    ))),
                };
            }
            let output = output?;
            if output.is_empty() {
                return Err(ClientError::Sap(
                    "StoreAgent kbsync returned an empty buffer".into(),
                ));
            }
            Ok(output)
        })();
        inner.clear_scratch();
        result
    }
}
impl Inner {
    fn invoke(&mut self, function: u64, arguments: &[u64]) -> Result<u64, ClientError> {
        if function == 0 {
            return Err(ClientError::Sap("guest entry point is unavailable".into()));
        }
        const REGISTERS: [i32; 6] = [reg::RDI, reg::RSI, reg::RDX, reg::RCX, reg::R8, reg::R9];
        {
            let guest = self.engine.guest();
            for (index, register) in REGISTERS.iter().enumerate() {
                guest.reg_write(*register, arguments.get(index).copied().unwrap_or(0))?;
            }
            let spilled = arguments.len().saturating_sub(REGISTERS.len());
            let mut stack = STACK_END - (spilled as u64 + 1) * 8;
            if stack % 16 != 8 {
                stack -= 8;
            }
            shims::write_u64(&guest, stack, RETURN_ADDRESS)?;
            for index in 0..spilled {
                shims::write_u64(
                    &guest,
                    stack + 8 + index as u64 * 8,
                    arguments[REGISTERS.len() + index],
                )?;
            }
            guest.reg_write(reg::RSP, stack)?;
        }
        self.engine.start(
            function,
            RETURN_ADDRESS,
            CALL_TIMEOUT,
            CALL_INSTRUCTION_LIMIT,
        )?;
        let guest = self.engine.guest();
        let instruction = guest.reg_read(reg::RIP)?;
        if instruction != RETURN_ADDRESS {
            return Err(ClientError::Sap(format!(
                "guest stopped unexpectedly at {instruction:#x}"
            )));
        }
        guest.reg_read(reg::RAX)
    }
    fn begin_call(&mut self) {
        self.scratch_cursor = 0;
    }
    fn scratch(&mut self, data: Option<&[u8]>, size: u64) -> Result<u64, ClientError> {
        let reserved = size.max(1).next_multiple_of(16);
        if self.scratch_cursor > SCRATCH_SIZE || reserved > SCRATCH_SIZE - self.scratch_cursor {
            return Err(ClientError::Sap("guest scratch space exhausted".into()));
        }
        let address = SCRATCH_BASE + self.scratch_cursor;
        self.scratch_cursor += reserved;
        let guest = self.engine.guest();
        match data {
            Some(data) if !data.is_empty() => {
                if data.len() as u64 > size {
                    return Err(ClientError::Sap("scratch data exceeds reservation".into()));
                }
                guest.mem_write(address, data)?;
            }
            _ if size != 0 => guest.mem_write(address, &vec![0u8; size as usize])?,
            _ => {}
        }
        Ok(address)
    }
    fn clear_scratch(&mut self) {
        if self.scratch_cursor != 0 {
            let _ = self
                .engine
                .guest()
                .mem_write(SCRATCH_BASE, &vec![0u8; self.scratch_cursor as usize]);
        }
        self.scratch_cursor = 0;
    }
    fn consume_output(
        &mut self,
        pointer_field: u64,
        length_field: u64,
    ) -> Result<Vec<u8>, ClientError> {
        let (pointer, length) = {
            let guest = self.engine.guest();
            (
                shims::read_u64(&guest, pointer_field)?,
                shims::read_u64(&guest, length_field)?,
            )
        };
        let output = if length > MAX_OUTPUT {
            Err(ClientError::Sap(format!(
                "guest output is {length} bytes, maximum is {MAX_OUTPUT}"
            )))
        } else if length == 0 {
            Ok(Vec::new())
        } else if pointer == 0 {
            Err(ClientError::Sap(
                "guest returned a null output pointer".into(),
            ))
        } else {
            self.engine.guest().mem_read(pointer, length as usize)
        };
        if pointer != 0 {
            let dispose = self.entry.dispose;
            let status = self.invoke(dispose, &[pointer])?;
            if status as i32 != 0 {
                return Err(ClientError::Sap(format!(
                    "guest storage disposal returned {}",
                    status as i32
                )));
            }
        }
        output
    }
}
impl SapMachine for Machine {
    fn initialize(&self, hardware_id: &[u8]) -> Result<u64, ClientError> {
        let block = hardware_block(hardware_id)?;
        let mut inner = self.lock()?;
        inner.begin_call();
        let result = (|| {
            let context_field = inner.scratch(None, 8)?;
            let hardware = inner.scratch(Some(&block), block.len() as u64)?;
            let initialize = inner.entry.initialize;
            let status = inner.invoke(initialize, &[context_field, hardware])?;
            if status as i32 != 0 {
                return Err(ClientError::Sap(format!(
                    "SAP initialization returned {}",
                    status as i32
                )));
            }
            let context = shims::read_u64(&inner.engine.guest(), context_field)?;
            if context == 0 {
                return Err(ClientError::Sap(
                    "SAP initialization returned a null context".into(),
                ));
            }
            Ok(context)
        })();
        inner.clear_scratch();
        result
    }
    fn exchange(
        &self,
        version: u32,
        hardware_id: &[u8],
        context: u64,
        input: &[u8],
    ) -> Result<(Vec<u8>, i32), ClientError> {
        let block = hardware_block(hardware_id)?;
        let mut inner = self.lock()?;
        inner.begin_call();
        let result = (|| {
            let hardware = inner.scratch(Some(&block), block.len() as u64)?;
            let input_address = inner.scratch(Some(input), input.len() as u64)?;
            let output_field = inner.scratch(None, 8)?;
            let length_field = inner.scratch(None, 8)?;
            let state_field = inner.scratch(None, 4)?;
            let exchange = inner.entry.exchange;
            let status = inner.invoke(
                exchange,
                &[
                    u64::from(version),
                    hardware,
                    context,
                    input_address,
                    input.len() as u64,
                    output_field,
                    length_field,
                    state_field,
                ],
            )?;
            if status as i32 != 0 {
                return Err(ClientError::Sap(format!(
                    "SAP exchange returned {}",
                    status as i32
                )));
            }
            let output = inner.consume_output(output_field, length_field)?;
            let state = shims::read_u32(&inner.engine.guest(), state_field)? as i32;
            Ok((output, state))
        })();
        inner.clear_scratch();
        result
    }
    fn sign(&self, context: u64, input: &[u8]) -> Result<Vec<u8>, ClientError> {
        let mut inner = self.lock()?;
        inner.begin_call();
        let result = (|| {
            let input_address = inner.scratch(Some(input), input.len() as u64)?;
            let output_field = inner.scratch(None, 8)?;
            let length_field = inner.scratch(None, 8)?;
            let sign = inner.entry.sign;
            let status = inner.invoke(
                sign,
                &[
                    context,
                    input_address,
                    input.len() as u64,
                    output_field,
                    length_field,
                ],
            )?;
            if status as i32 != 0 {
                return Err(ClientError::Sap(format!(
                    "SAP signing returned {}",
                    status as i32
                )));
            }
            inner.consume_output(output_field, length_field)
        })();
        inner.clear_scratch();
        result
    }
    fn teardown(&self, context: u64) -> Result<(), ClientError> {
        let mut inner = self.lock()?;
        let teardown = inner.entry.teardown;
        let status = inner.invoke(teardown, &[context])?;
        if status as i32 != 0 {
            return Err(ClientError::Sap(format!(
                "SAP teardown returned {}",
                status as i32
            )));
        }
        Ok(())
    }
}
fn hardware_block(hardware_id: &[u8]) -> Result<[u8; 24], ClientError> {
    if hardware_id.is_empty() || hardware_id.len() > 20 {
        return Err(ClientError::Sap(format!(
            "hardware ID must be 1-20 bytes, got {}",
            hardware_id.len()
        )));
    }
    let mut block = [0u8; 24];
    block[0..4].copy_from_slice(&(hardware_id.len() as u32).to_le_bytes());
    block[4..4 + hardware_id.len()].copy_from_slice(hardware_id);
    Ok(block)
}
impl macho::Memory for Guest<'_> {
    fn map(&self, address: u64, size: u64) -> Result<(), ClientError> {
        unicorn::Guest::mem_map(self, address, size)
    }
    fn write(&self, address: u64, data: &[u8]) -> Result<(), ClientError> {
        unicorn::Guest::mem_write(self, address, data)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hardware_block_is_length_prefixed() {
        let block = hardware_block(&[0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF]).unwrap();
        assert_eq!(&block[0..4], &6u32.to_le_bytes());
        assert_eq!(&block[4..10], &[0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF]);
        assert_eq!(&block[10..], &[0u8; 14]);
    }
    #[test]
    fn hardware_block_rejects_unusable_identifiers() {
        assert!(hardware_block(&[]).is_err());
        assert!(hardware_block(&[0u8; 21]).is_err());
        assert!(hardware_block(&[0u8; 20]).is_ok());
    }
    #[test]
    fn the_stack_is_aligned_for_the_call() {
        for spilled in 0..8u64 {
            let mut stack = STACK_END - (spilled + 1) * 8;
            if stack % 16 != 8 {
                stack -= 8;
            }
            assert_eq!(stack % 16, 8, "spilled={spilled}");
        }
    }
    #[tokio::test]
    #[ignore = "downloads verified Apple SAP assets and Unicorn, then runs StoreAgent locally"]
    async fn live_store_agent_generates_account_bound_kbsync() {
        let client = AppleClient::for_tests();
        let cache_dir = client.cache_dir().to_path_buf();
        let bundle = crate::sap::assets::load(&client, &cache_dir.join("apple-assets"))
            .await
            .expect("load verified Apple assets");
        let machine = Machine::open(&client, &cache_dir, &bundle)
            .await
            .expect("open SAP and StoreAgent runtime");
        let kbsync = machine
            .generate_kbsync(&[0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF], 123456789)
            .expect("generate account-bound kbsync");
        assert!(!kbsync.is_empty());
        assert!(kbsync.len() <= MAX_OUTPUT as usize);
    }
}
