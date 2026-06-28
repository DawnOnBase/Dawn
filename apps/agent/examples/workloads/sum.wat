;; Dawn sample workload — a real, deterministic WASI compute job.
;;
;; Reads all of stdin, sums the bytes, and writes one byte: (sum & 0xff).
;; A genuine input-dependent computation (not an echo), so the signed proof's
;; outputHash actually attests to work done. Build a Job Package from it with:
;;
;;   dawn-agent pack apps/agent/examples/workloads/sum.wat job.djp input.bin
;;
;; then host job.djp at a fetchable URL and use it as a job's inputRef.
(module
  (import "wasi_snapshot_preview1" "fd_read"
    (func $fd_read (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (memory (export "memory") 2)
  (func (export "_start")
    (local $nread i32) (local $i i32) (local $sum i32)
    ;; read stdin into [64..), iovec{base,len} at [0], nread written to [8]
    (i32.store (i32.const 0) (i32.const 64))
    (i32.store (i32.const 4) (i32.const 4096))
    (drop (call $fd_read (i32.const 0) (i32.const 0) (i32.const 1) (i32.const 8)))
    (local.set $nread (i32.load (i32.const 8)))
    ;; sum the bytes
    (block $done
      (loop $loop
        (br_if $done (i32.ge_u (local.get $i) (local.get $nread)))
        (local.set $sum
          (i32.add (local.get $sum)
            (i32.load8_u (i32.add (local.get $i) (i32.const 64)))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop)))
    ;; write one byte: sum & 0xff, from [16], iovec at [0]
    (i32.store8 (i32.const 16) (i32.and (local.get $sum) (i32.const 0xff)))
    (i32.store (i32.const 0) (i32.const 16))
    (i32.store (i32.const 4) (i32.const 1))
    (drop (call $fd_write (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 8)))))
