# Linux update stubs

The Linux and Omarchy desktop is retired; its last snapshot is in the archived baney75/baneyspaces.

These files are not the desktop. A `polycarp update` from before the retirement, run on Linux, builds
its own plan: it builds the `baneyspaces-linux` package and runs `scripts/build-engine.sh` and
`omarchy/install.sh` in a clean copy of this tree, then installs the new `polycarp` command and hands off
to it. These stubs let those steps pass, so the new command gets installed and says the desktop is
retired. Each one builds or installs nothing.

`an_older_linux_update_plan_lands_on_this_tree` in `cli/tests/cli.rs` replays those steps. Remove the
stubs, and that test, once no Linux machine runs a `polycarp` from before the retirement.
