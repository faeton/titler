"""ROCm smoke test: device visibility, arch, matmul throughput GPU vs CPU."""
import os, time, torch

print("torch", torch.__version__, "hip", torch.version.hip)
print("cuda.is_available", torch.cuda.is_available())
if torch.cuda.is_available():
    p = torch.cuda.get_device_properties(0)
    print("device", p.name, getattr(p, "gcnArchName", "?"), f"{p.total_memory/2**30:.1f} GiB")
    print("arch list", torch.cuda.get_arch_list())


def bench(dev, dtype, n=4096, it=10):
    a = torch.randn(n, n, device=dev, dtype=dtype); b = torch.randn(n, n, device=dev, dtype=dtype)
    (a @ b); torch.cuda.synchronize() if dev == "cuda" else None
    t = time.perf_counter()
    for _ in range(it):
        c = a @ b
    torch.cuda.synchronize() if dev == "cuda" else None
    dt = (time.perf_counter() - t) / it
    return 2 * n**3 / dt / 1e12


torch.set_num_threads(8)
print(f"cpu fp32 matmul: {bench('cpu', torch.float32, it=3):.2f} TFLOPS (8 threads)")
if torch.cuda.is_available():
    for dt in (torch.float32, torch.float16, torch.bfloat16):
        print(f"gpu {dt} matmul: {bench('cuda', dt):.2f} TFLOPS")
    # conv (MIOpen) sanity
    x = torch.randn(4, 64, 16000, device="cuda", dtype=torch.float16)
    conv = torch.nn.Conv1d(64, 64, 5, padding=2).cuda().half()
    t = time.perf_counter(); y = conv(x); torch.cuda.synchronize()
    print(f"conv1d first call {time.perf_counter()-t:.2f}s (MIOpen find)", y.shape)
    print("max mem allocated MiB", torch.cuda.max_memory_allocated() // 2**20)
