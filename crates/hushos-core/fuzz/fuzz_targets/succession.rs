#![no_main]

libfuzzer_sys::fuzz_target!(|data: &[u8]| hushos_core_fuzz::check("succession", data));
