# Provenance and licensing

This repository publishes the ZeroKnows local gateway and new model-router work from the owner's local model lab. It contains JavaScript/PowerShell application source and tests; it does not contain llama.cpp, model weights, drivers, client application binaries, or downloaded model engines. A small third-party retrieval subset is described below.

The local lab referenced [staccDOTsol/zero](https://github.com/staccDOTsol/zero). That repository did not declare a license in its GitHub metadata when this release was prepared. No blanket license grant or relicensing of that project is asserted here. Public visibility alone is not an open-source license. Rights remain with their respective authors until a license is explicitly supplied.

The optional llama.cpp runtime is distributed separately by its authors under its own license. Model weights and vision projectors retain their respective licenses. Install and use those dependencies separately; this repository neither redistributes them nor changes their terms.

## Vendored leCore subset

`vendor/lecore` contains the reviewed BM25, chunking and deterministic top-k subset from [leCore](https://github.com/anoversizedmoosewithsocks/lecore), pinned to commit `45dfab5608d7bfc96df987a1b42b3dbe6ce2fb8b`, used under its MIT license (copyright 2026 AnOversizedMooseWithSocks). The exact license and source hashes/local extraction changes are included in [vendor/lecore/LICENSE](vendor/lecore/LICENSE) and [vendor/lecore/PROVENANCE.md](vendor/lecore/PROVENANCE.md). This does not relicense the rest of this repository. The full engine, bootstrap/install scripts and services are not included.
