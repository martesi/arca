---
name: nix-container-troubleshooting
description: >-
  Fixes for two container failures whose error messages point at the wrong cause - cargo
  failing with "failed to create directory ~/.cargo/registry" or permission denied on
  $HOME, and a binary that exists but fails to execute with "No such file or directory".
  Use when a build or binary fails for reasons that make no sense given the filesystem.
---

# Container failures that lie about their cause

## `$HOME` is not writable

Symptoms — cargo is the usual victim, but anything that caches under `$HOME` hits it:

```
error: failed to create directory `/home/<user>/.cargo/registry/cache/...`
Caused by: Permission denied (os error 13)
```

`mkdir ~/.cargo` fails too. `$HOME` exists but is not writable; only explicitly mounted
paths are. The repo working directory is writable.

Point the tool's cache into the repo:

```sh
export CARGO_HOME="$PWD/target/.cargo-home"
```

`target/` is already gitignored and lives on the mounted repo, so the crate cache survives
container restarts — which anything under `$HOME` does not. Expect the first build after
this to be a cold download of the whole dependency tree.

Check `test -w "$HOME"` before assuming a tool is misconfigured. The same fix shape applies
to other `$HOME`-cachers via their own env vars.

## A binary that exists but won't execute

```sh
$ ./target/release/app
bash: ./target/release/app: No such file or directory
$ ls -la ./target/release/app
-rwxr-xr-x 1 user users 16644680 ... ./target/release/app
```

The file is right there. The missing thing is its **ELF interpreter**: the binary was linked
against a glibc in the nix store that has since been garbage-collected, and `execve` reports
the missing interpreter as ENOENT on the binary itself. `ldd` repeats the same misleading
error, so it does not help.

Read the `INTERP` program header to see the path it actually wants, then check whether it
exists. `readelf` is not usually on `PATH` here:

```sh
nix shell nixpkgs#binutils --command readelf -l ./target/release/app | grep -A1 INTERP
```

Fix by running anything in that project under `nix develop` — evaluating the shell
re-realises the glibc path into the store, after which the existing binary runs unchanged.
No rebuild is needed, though a rebuild also works.

Suspect this whenever prebuilt artifacts predate a store GC or a container image change.
