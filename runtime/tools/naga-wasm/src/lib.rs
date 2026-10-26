//! GLSL (Vulkan-flavoured, #version 450) to WGSL, for the browser's GPU worker.
//!
//! The page translates the shaders in the player's own Minecraft jar at run
//! time (docs/SHADERS-PLAN.md), so MC-Web ships only this translator and its
//! glue, never shader text. A plain C ABI rather than wasm-bindgen: the GPU
//! worker is a classic script and instantiates the module synchronously.
//!
//!   ptr = alloc(n); write UTF-8 GLSL at ptr; status = translate(ptr, n, stage); dealloc(ptr, n)
//!   status 0: out_ptr/out_len hold WGSL; 1 parse, 2 validation, 3 write error: they hold the message
use naga::{back::wgsl, front::glsl, valid, ShaderStage};

static mut OUT: Vec<u8> = Vec::new();

#[no_mangle]
pub extern "C" fn alloc(n: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(n);
    let p = v.as_mut_ptr();
    core::mem::forget(v);
    p
}

#[no_mangle]
pub unsafe extern "C" fn dealloc(p: *mut u8, n: usize) {
    drop(Vec::from_raw_parts(p, 0, n));
}

#[no_mangle]
pub unsafe extern "C" fn out_ptr() -> *const u8 {
    (*core::ptr::addr_of!(OUT)).as_ptr()
}

#[no_mangle]
pub unsafe extern "C" fn out_len() -> usize {
    (*core::ptr::addr_of!(OUT)).len()
}

/// stage: 0 vertex, 1 fragment.
#[no_mangle]
pub unsafe extern "C" fn translate(p: *const u8, n: usize, stage: u32) -> u32 {
    let bytes = core::slice::from_raw_parts(p, n);
    let (code, text) = match core::str::from_utf8(bytes) {
        Err(e) => (1, format!("source is not UTF-8: {e}")),
        Ok(src) => {
            let st = if stage == 0 { ShaderStage::Vertex } else { ShaderStage::Fragment };
            match glsl::Frontend::default().parse(&glsl::Options::from(st), src) {
                Err(e) => (1, e.emit_to_string(src)),
                Ok(module) => match valid::Validator::new(valid::ValidationFlags::all(), valid::Capabilities::empty())
                    .validate(&module)
                {
                    Err(e) => (2, e.emit_to_string(src)),
                    Ok(info) => match wgsl::write_string(&module, &info, wgsl::WriterFlags::empty()) {
                        Ok(s) => (0, s),
                        Err(e) => (3, e.to_string()),
                    },
                },
            }
        }
    };
    *core::ptr::addr_of_mut!(OUT) = text.into_bytes();
    code
}
