// A stand-in tool for the handoff tests. Compiled by cli/tests/cli.rs, not part of the crate.
use std::io::Read;

fn main() {
    let mut args = std::env::args();
    println!("argv0:{}", args.next().unwrap_or_default());
    for a in args {
        println!("[{a}]");
    }
    let mut input = String::new();
    let _ = std::io::stdin().read_to_string(&mut input);
    println!("stdin:{input}");
    let code = std::env::var("STUB_EXIT").ok().and_then(|c| c.parse().ok()).unwrap_or(0);
    std::process::exit(code);
}
