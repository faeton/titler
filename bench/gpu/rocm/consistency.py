"""Run the same fp16 GEMM chain N times and compare to the first result (detects silent corruption
while another GPU client, e.g. Ollama/Vulkan, is active). Also times each iteration."""
import sys, time, torch
torch.manual_seed(0)
n = int(sys.argv[1]) if len(sys.argv) > 1 else 200
a = torch.randn(2048, 2048, device="cuda", dtype=torch.float16) / 45
ws = [torch.randn(2048, 2048, device="cuda", dtype=torch.float16) / 45 for _ in range(8)]
def chain():
    x = a
    for w in ws:
        x = torch.tanh(x @ w)
    return x
ref = chain().clone(); torch.cuda.synchronize()
bad = 0; worst = 0.0; slow = 0
for i in range(n):
    t = time.perf_counter(); y = chain(); torch.cuda.synchronize(); dt = time.perf_counter() - t
    d = (y - ref).abs().max().item()
    if d != 0: bad += 1; worst = max(worst, d)
    if dt > 0.5: slow += 1; print(f"iter {i}: {dt:.2f}s stall", flush=True)
    time.sleep(0.1)
print(f"iters={n} mismatching={bad} worst_abs_diff={worst} stalls>0.5s={slow}")
