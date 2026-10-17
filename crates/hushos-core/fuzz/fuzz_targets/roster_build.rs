#![no_main]

use arbitrary::Unstructured;

// A roster drawn mostly from well-formed fields (structured::roster), so the encoder's later checks run.
libfuzzer_sys::fuzz_target!(|data: &[u8]| {
    if let Ok(roster) = hushos_core_fuzz::structured::roster(&mut Unstructured::new(data)) {
        hushos_core_fuzz::check("roster_build", roster.to_string().as_bytes());
    }
});
