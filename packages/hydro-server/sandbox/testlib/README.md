# testlib

Vendored without modification from https://github.com/MikeMirzayanov/testlib at commit
`1e4e8a24c79c6bad3becbdb5a332ffc352b7d5dd`. The upstream MIT license is in `LICENSE`.

The sandbox compiles generators, validators and optional special judges with
GCC 15.2, `-O2`, `-I/opt/testlib`, and each source's selected `-std` flag.
The default is `-std=c++17`; C++26 selects experimental `-std=c++2c`.
Generators use `registerGen(argc, argv, 1)`;
all command arguments, including the seed, are saved in `project.json`.
