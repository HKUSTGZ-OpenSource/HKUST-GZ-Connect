use std::collections::BTreeSet;
use std::process::Command;

fn normal_dependencies(laboratory: bool) -> BTreeSet<String> {
    let mut command = Command::new(env!("CARGO"));
    command.current_dir(env!("CARGO_MANIFEST_DIR")).args([
        "tree",
        "--locked",
        "--offline",
        "--no-default-features",
        "--edges",
        "normal",
        "--prefix",
        "none",
    ]);
    if laboratory {
        command.args(["--features", "compatibility-lab"]);
    }
    let output = command
        .output()
        .expect("Cargo dependency graph must be available");
    assert!(output.status.success(), "Cargo dependency graph failed");
    String::from_utf8(output.stdout)
        .expect("Cargo tree must be UTF-8")
        .lines()
        .filter_map(|line| line.split_whitespace().next().map(str::to_owned))
        .collect()
}

#[test]
fn laboratory_dependencies_require_explicit_opt_in() {
    let production = normal_dependencies(false);
    let laboratory = normal_dependencies(true);
    for dependency in ["flate2", "iced-x86", "object", "tar", "xz2", "zstd"] {
        assert!(
            !production.contains(dependency),
            "production acquired {dependency}"
        );
        assert!(
            laboratory.contains(dependency),
            "laboratory lost {dependency}"
        );
    }
}
