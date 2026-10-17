#![no_main]

use hushos_core_fuzz::structured::History;

// A fixture history changed by up to sixteen operations (structured::Op): signed parts dropped,
// repeated, reordered, borrowed from other cases or flipped; pins, cache, keys and join marks swapped.
libfuzzer_sys::fuzz_target!(|history: History| {
    hushos_core_fuzz::check("accept", history.input().to_string().as_bytes());
});
