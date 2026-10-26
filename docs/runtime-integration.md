# Runtime provenance

Source identity and runtime artifact identity are separate records. A successful source build does not select replacement distribution bytes.

## Source records

testing/runtime-source.json identifies the checked-in runtime inputs and pinned upstream dependencies. testing/source-provenance.json records their source history. The source verifier checks hashes, sizes, executable modes, unexpected files and generated outputs.

The baseline source came from revision f5862293f19eeaf1bc9d8fee77a44b3c488adca4 with testing/patches/regressions-20261022.patch. That patch records changes already present in runtime/. Do not apply it again. Building requires no external project checkout.

`testing/public-source.json` records the public source derivation against the original locked source. It keeps the original patch hash and names the sanitized patch. Sanitation replaces a machine-specific acceptance-pack pathname with the optional `MCWEB_ACCEPTANCE_PACK` setting. It also replaces private local-playtest lab paths with portable defaults. The original base manifests remain for comparison. Do not describe the derived patch as byte-identical to its base.

Historical records do not prove the behavior of later server or source changes. After an intentional runtime source or README edit, run `node tools/update-public-source.mjs` and review the derived file list and hashes. Verify against the files and artifact that actually ship.

## Runtime records

artifacts/runtime.tar.gz contains the reviewed browser JVM, project adapters and support libraries for the public distribution. artifacts/runtime.json records the exact archive and file identities. The Docker build rejects mismatches.

`testing/release.json` and the artifact-specific records in `testing/` keep the runtime's selected build provenance and checksums. The selected runtime uses the Linux library selection. A build on a different host or with a different dependency selection can produce a different bundle.

The normal Docker install verifies and uses the included artifact. It does not rebuild the JVM. A source rebuild writes runtime/dist/wasmjvm and must pass a separate review before replacing the distribution archive.

## Corresponding source and notices

The /notices/ downloads include upstream license texts, Java and Naga dependency inventories, runtime checksums and a corresponding-source archive. The source manifest identifies the archive checksum, upstream source revisions and custom patches. These downloads require no player session.

Source packaging must exclude account files, player data, private deployment configuration, generated caches and game files. Its inventory must include the custom runtime source, build scripts, dependency pins and required license texts. Verify the actual archive and published manifest as part of a release.

The Docker image and source archive have different purposes. The image contains the reviewed runtime needed to run the launcher. The corresponding-source archive provides the source and build instructions required to identify and rebuild that runtime.

## Evidence limits

Node tests, archive checks, and container health do not prove live authenticated gameplay, physical-device controls, displayed frame rate, or memory reclamation. Record browser, GPU, and account checks separately. Report JVM-produced frames separately from displayed frames.
