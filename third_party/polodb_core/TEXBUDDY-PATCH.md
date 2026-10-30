# PoloDB 5.3.0 cache patch

Source: crates.io `polodb_core` 5.3.0, upstream commit
`0bc642db52a42585bc461f64cbe2e55f634efde1` in
<https://github.com/PoloDB/PoloDB/tree/0bc642db52a42585bc461f64cbe2e55f634efde1/src/polodb_core>.
License: Apache-2.0; upstream copyright headers retained.

The only source change is in `db/rocksdb_wrapper.rs`: explicitly configure the
existing 32 MiB RocksDB block cache as one shard. Large BSON document ranges and
source snapshots exceed an individual default shard's capacity, causing repeated
block reads/checksums during small queries. Catalex already serializes operations
per database, so cache sharding brings no useful concurrency here. Cache capacity,
synchronous commits, checksums, transaction behavior and data format are unchanged.

Public PoloDB Config does not expose RocksDB cache settings. Keep this patch
isolated, recheck it on dependency upgrades, and remove it if upstream exposes the
setting or fixes the behavior. This is not a new database API or storage format.

The unused 4.9 MiB upstream CSV dataset, generated Cargo.lock and registry marker
were omitted. Upstream source and tests are retained. See
`docs/testing/README.md` for app regression test commands.
