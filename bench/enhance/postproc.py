#!/usr/bin/env python3
"""Post-process raw enhancement outputs (runs in envs/enh-metrics).

For every runs/enhance/raw/<variant>/<clip>.wav:
  * measure latency vs original (cross-correlation), compensate, trim/pad to the
    exact original sample count -> aligned/<variant>/<clip>.48k.wav (+ .16k.wav mono)
  * DNSMOS P.835 (SIG/BAK/OVRL) on the whole clip, loudness-normalised 16 kHz mono
  * phase agreement with the original (does mixing back the original cause comb/doubling?)
  * faster-whisper ASR, char diff vs the original's transcript, WER vs refs if present
  * loudness-matched listening files + noisiest-10s excerpt
Writes runs/enhance/results.json and listen/index.html.
"""
import json, os, sys, glob, random, html, time
import numpy as np, soundfile as sf
from scipy.signal import resample_poly, stft
import pyloudnorm as pyln

B = os.environ.get("B", "/mnt/flash/home/faeton/work/titler/bench")
R = f"{B}/runs/enhance"
SAMPLES = f"{B}/samples/audio"
CLIPS = ["video-34238", "video-34442", "video-34585"]
MAXLAG_S = 1.0
EXC_LEN = 10.0
ASR_MODEL = os.environ.get("ASR_MODEL", "small")
ONLY = os.environ.get("ONLY")
# identical-after-alignment or no-op variants are kept in the table but not on the listening page
LISTEN_EXCLUDE = {"dfn3-nocomp", "dsp-afftdn20"}  # comma list of variants to (re)process


def mono(x):
    return x if x.ndim == 1 else x.mean(axis=1)


def rs(x, sr_from, sr_to):
    if sr_from == sr_to:
        return x
    g = np.gcd(sr_from, sr_to)
    return resample_poly(x, sr_to // g, sr_from // g, axis=0).astype(np.float32)


def xcorr_lag(ref, sig, sr, maxlag_s=MAXLAG_S):
    """Lag (samples) such that sig[n] ~ ref[n - lag]; positive = output delayed."""
    n = len(ref) + len(sig)
    nfft = 1 << (n - 1).bit_length()
    R_ = np.fft.rfft(ref, nfft)
    S_ = np.fft.rfft(sig, nfft)
    # PHAT-weighted (GCC-PHAT) is robust when the output has different spectrum
    cc_plain = np.fft.irfft(S_ * np.conj(R_), nfft)
    W = S_ * np.conj(R_)
    cc_phat = np.fft.irfft(W / (np.abs(W) + 1e-12), nfft)
    m = int(maxlag_s * sr)
    res = {}
    for name, cc in (("plain", cc_plain), ("phat", cc_phat)):
        cand = np.concatenate([cc[-m:], cc[: m + 1]])
        lags = np.arange(-m, m + 1)
        i = int(np.argmax(np.abs(cand)))
        res[name] = (int(lags[i]), float(np.sign(cand[i])),
                     float(np.abs(cand[i]) / (np.sort(np.abs(cand))[-50] + 1e-12)))
    return res


def shift_fit(x, lag, n):
    """Remove `lag` samples of delay and fit to n samples (pad with zeros)."""
    if lag > 0:
        x = x[lag:]
    elif lag < 0:
        pad = np.zeros((-lag,) + x.shape[1:], x.dtype)
        x = np.concatenate([pad, x])
    if len(x) >= n:
        return x[:n]
    pad = np.zeros((n - len(x),) + x.shape[1:], x.dtype)
    return np.concatenate([x, pad])


def phase_agreement(ref, sig, sr):
    """Magnitude-weighted mean cos(phase diff) between output and original in
    200-4000 Hz. 1.0 = output is a real positive mask of the original (mixing the
    original back in is artefact-free); low = new/rotated phase (comb/doubling risk)."""
    f, _, X = stft(ref, sr, nperseg=1024, noverlap=768)
    _, _, Y = stft(sig, sr, nperseg=1024, noverlap=768)
    band = (f >= 200) & (f <= 4000)
    X, Y = X[band], Y[band]
    w = np.abs(Y)
    c = np.real(Y * np.conj(X)) / (np.abs(X) * np.abs(Y) + 1e-12)
    return float((c * w).sum() / (w.sum() + 1e-12))


_meter16 = pyln.Meter(16000)


def norm_lufs(x, sr, target):
    m = _meter16 if sr == 16000 else pyln.Meter(sr)
    l = m.integrated_loudness(x)
    if not np.isfinite(l):
        return x, l
    return (x * 10 ** ((target - l) / 20)).astype(np.float32), l


_dnsmos = None


def dnsmos(x16):
    global _dnsmos
    if _dnsmos is None:
        import onnxruntime as ort
        _IS = ort.InferenceSession

        def _capped(path, sess_options=None, **kw):  # cap ORT at 8 threads
            so = sess_options or ort.SessionOptions()
            so.intra_op_num_threads = 8
            so.inter_op_num_threads = 1
            return _IS(path, sess_options=so, **kw)
        ort.InferenceSession = _capped
        from speechmos import dnsmos as d
        _dnsmos = d
    x, _ = norm_lufs(x16, 16000, -23.0)
    x = np.clip(x, -1, 1)
    r = _dnsmos.run(x, sr=16000)
    return {"sig": float(r["sig_mos"]), "bak": float(r["bak_mos"]), "ovrl": float(r["ovrl_mos"])}


def dnsmos_windows(x16, win=EXC_LEN, hop=1.0):
    out = []
    n = int(win * 16000)
    for s in np.arange(0, max(len(x16) / 16000 - win, 0) + 1e-9, hop):
        seg = x16[int(s * 16000): int(s * 16000) + n]
        if len(seg) < n:
            break
        out.append((float(s), dnsmos(seg)))
    return out


_whisper = None


def transcribe(x16):
    global _whisper
    if _whisper is None:
        from faster_whisper import WhisperModel
        _whisper = WhisperModel(ASR_MODEL, device="cpu", compute_type="int8", cpu_threads=8)
    segs, info = _whisper.transcribe(x16, language=None, beam_size=5, vad_filter=False,
                                     condition_on_previous_text=False)
    text = " ".join(s.text.strip() for s in segs)
    return {"text": text, "lang": info.language, "lang_p": float(info.language_probability)}


def norm_text(t):
    import re
    t = t.lower().replace("ё", "е")
    t = re.sub(r"[^\w\s]", " ", t)
    return " ".join(t.split())


def cer(a, b):
    import jiwer
    a, b = norm_text(a), norm_text(b)
    if not a:
        return None
    return float(jiwer.cer(a, b))


def wer(a, b):
    import jiwer
    a, b = norm_text(a), norm_text(b)
    if not a:
        return None
    return float(jiwer.wer(a, b))


def find_ref(clip):
    for suf in (".txt", ".draft.txt"):
        p = f"{B}/refs/{clip}{suf}"
        if os.path.exists(p):
            return p
    return None


def load_ref(path):
    """Drop '#' lines and <mm:ss> markers; [a|b|c] -> a (majority) as in bench/asr drafts."""
    import re
    lines = [l for l in open(path, encoding="utf-8") if not l.lstrip().startswith("#")]
    t = " ".join(lines)
    t = re.sub(r"<[^>]*>", " ", t)
    t = re.sub(r"\[([^\]|]*)(\|[^\]]*)?\]", lambda m: m.group(1), t)
    return t


def write_listen(x48, path, gain_db):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    y = x48 * 10 ** (gain_db / 20)
    sf.write(path, np.clip(y, -1, 1), 48000, subtype="PCM_16")


def main():
    res_path = f"{R}/results.json"
    results = json.load(open(res_path)) if os.path.exists(res_path) else {}
    only = set(ONLY.split(",")) if ONLY else None
    variants = sorted(d for d in os.listdir(f"{R}/raw") if os.path.isdir(f"{R}/raw/{d}"))
    origs = {}
    for c in CLIPS:
        x48, sr = sf.read(f"{SAMPLES}/{c}.48k.wav", dtype="float32", always_2d=True)
        x16, _ = sf.read(f"{SAMPLES}/{c}.16k.wav", dtype="float32")
        origs[c] = (x48, x16)

    # --- original baseline ------------------------------------------------
    base = results.setdefault("original", {})
    for c in CLIPS:
        if c in base and "asr" in base[c]:
            continue
        x48, x16 = origs[c]
        e = {"lag_ms": 0.0, "len_ok": True, "len_diff": 0, "phase": 1.0}
        e["dnsmos"] = dnsmos(x16)
        e["win"] = dnsmos_windows(x16)
        t = time.perf_counter()
        e["asr"] = transcribe(x16)
        e["asr"]["time_s"] = time.perf_counter() - t
        base[c] = e
        json.dump(results, open(res_path, "w"), indent=1, ensure_ascii=False)

    # noisiest excerpt per clip: lowest DNSMOS BAK window of the original
    excerpts = {}
    for c in CLIPS:
        win = base[c]["win"]
        s, _ = min(win, key=lambda w: (w[1]["bak"], w[1]["ovrl"]))
        excerpts[c] = s
    results["_excerpts"] = excerpts

    for v in variants:
        if only and v not in only:
            continue
        for c in CLIPS:
            p = f"{R}/raw/{v}/{c}.wav"
            if not os.path.exists(p):
                continue
            x48, x16o = origs[c]
            y, sr = sf.read(p, dtype="float32", always_2d=True)
            meta_p = f"{R}/raw/{v}/{c}.json"
            meta = json.load(open(meta_p)) if os.path.exists(meta_p) else {}
            ref = mono(x48) if sr == 48000 else (x16o if sr == 16000 else rs(mono(x48), 48000, sr))
            ym = mono(y)
            lagr = xcorr_lag(ref, ym, sr)
            lag, sign, peak = lagr["phat"]
            e = {"sr": sr, "ch": y.shape[1], "raw_len": len(y), "in_len": len(ref),
                 "len_diff": len(y) - len(ref), "lag_samples": lag,
                 "lag_ms": 1000 * lag / sr, "lag_plain_ms": 1000 * lagr["plain"][0] / sr,
                 "polarity": sign, "lag_peak_ratio": peak, "timing": meta}
            ya = shift_fit(y, lag, len(ref))
            # verify
            e["residual_lag_samples"] = xcorr_lag(ref, mono(ya), sr, 0.05)["phat"][0]
            e["phase"] = phase_agreement(ref, mono(ya), sr)
            # 48k aligned (stereo kept if output is stereo; mono duplicated)
            y48 = rs(ya, sr, 48000)
            y48 = shift_fit(y48, 0, len(x48))
            if y48.shape[1] == 1:
                y48 = np.repeat(y48, 2, axis=1)
            y16 = rs(mono(ya), sr, 16000) if sr != 16000 else mono(ya)
            y16 = shift_fit(y16, 0, len(x16o))
            e["len_ok"] = (len(y48) == len(x48)) and (len(y16) == len(x16o))
            os.makedirs(f"{R}/aligned/{v}", exist_ok=True)
            sf.write(f"{R}/aligned/{v}/{c}.48k.wav", y48, 48000, subtype="FLOAT")
            sf.write(f"{R}/aligned/{v}/{c}.16k.wav", y16, 16000, subtype="FLOAT")
            e["dnsmos"] = dnsmos(y16)
            s0 = excerpts[c]
            e["dnsmos_excerpt"] = dnsmos(y16[int(s0 * 16000): int((s0 + EXC_LEN) * 16000)])
            e["asr"] = transcribe(y16)
            e["asr_cer_vs_orig"] = cer(base[c]["asr"]["text"], e["asr"]["text"])
            results.setdefault(v, {})[c] = e
            json.dump(results, open(res_path, "w"), indent=1, ensure_ascii=False)
            print(f"{v:28s} {c} lag={e['lag_ms']:+.2f}ms dlen={e['len_diff']} phase={e['phase']:.2f} "
                  f"dnsmos={e['dnsmos']} cer={e['asr_cer_vs_orig']}", flush=True)

    # base excerpt dnsmos
    for c in CLIPS:
        s0 = excerpts[c]
        base[c]["dnsmos_excerpt"] = dnsmos(origs[c][1][int(s0 * 16000): int((s0 + EXC_LEN) * 16000)])

    # WER vs references, if available
    for c in CLIPS:
        rp = find_ref(c)
        if not rp:
            continue
        ref_txt = load_ref(rp)
        for v, d in results.items():
            if v.startswith("_") or c not in d or "asr" not in d[c]:
                continue
            d[c]["wer_vs_ref"] = wer(ref_txt, d[c]["asr"]["text"])
            d[c]["cer_vs_ref"] = cer(ref_txt, d[c]["asr"]["text"])
            d[c]["ref_file"] = os.path.basename(rp)
    json.dump(results, open(res_path, "w"), indent=1, ensure_ascii=False)
    make_listen(results, excerpts, origs)


def make_listen(results, excerpts, origs):
    L = f"{R}/listen"
    meter = pyln.Meter(48000)
    page = {}
    variants = ["original"] + sorted(v for v in results if not v.startswith("_") and v != "original"
                                     and v not in LISTEN_EXCLUDE)
    for c in CLIPS:
        items = []
        for v in variants:
            if c not in results.get(v, {}):
                continue
            x = origs[c][0] if v == "original" else sf.read(f"{R}/aligned/{v}/{c}.48k.wav", dtype="float32", always_2d=True)[0]
            l = meter.integrated_loudness(x)
            s0 = excerpts[c]
            ex = x[int(s0 * 48000): int((s0 + EXC_LEN) * 48000)]
            lex = meter.integrated_loudness(ex)
            items.append((v, x, l, ex, lex))
        # common target so that nothing clips (>-1 dBFS peak) after gain
        def tgt(pairs):
            t = -16.0
            for x, l in pairs:
                if np.isfinite(l):
                    pk = 20 * np.log10(np.abs(x).max() + 1e-12)
                    need = -1.0 - (pk - l)
                    if need >= -30.0:   # ignore pathological spikes (arnndn blow-ups); those get clipped
                        t = min(t, need)
            return max(t, -26.0)
        tf = tgt([(i[1], i[2]) for i in items])
        te = tgt([(i[3], i[4]) for i in items])
        page[c] = {"target_full": tf, "target_excerpt": te, "excerpt_start": excerpts[c], "variants": []}
        for v, x, l, ex, lex in items:
            write_listen(x, f"{L}/{c}/{v}.wav", tf - l if np.isfinite(l) else 0)
            write_listen(ex, f"{L}/{c}/excerpt/{v}.wav", te - lex if np.isfinite(lex) else 0)
            page[c]["variants"].append(v)
    json.dump(page, open(f"{L}/listen.json", "w"), indent=1)
    write_html(page, results)


def write_html(page, results):
    rnd = random.Random(42)
    clips_js = {}
    for c, d in page.items():
        vs = list(d["variants"])
        rnd.shuffle(vs)
        letters = [chr(65 + i) if i < 26 else "Z" + str(i) for i in range(len(vs))]
        clips_js[c] = {"excerpt_start": d["excerpt_start"],
                       "targets": [d["target_full"], d["target_excerpt"]],
                       "items": [{"letter": L_, "name": v,
                                  "ovrl": results.get(v, {}).get(c, {}).get("dnsmos", {}).get("ovrl")}
                                 for L_, v in zip(letters, vs)]}
    tpl = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "listen_template.html")).read()
    out = tpl.replace("/*DATA*/null", json.dumps(clips_js))
    open(f"{R}/listen/index.html", "w").write(out)
    print("wrote", f"{R}/listen/index.html")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "listen":
        results = json.load(open(f"{R}/results.json"))
        x = {c: (sf.read(f"{SAMPLES}/{c}.48k.wav", dtype="float32", always_2d=True)[0],
                 sf.read(f"{SAMPLES}/{c}.16k.wav", dtype="float32")[0]) for c in CLIPS}
        make_listen(results, results["_excerpts"], x)
    elif len(sys.argv) > 1 and sys.argv[1] == "html":
        results = json.load(open(f"{R}/results.json"))
        page = json.load(open(f"{R}/listen/listen.json"))
        write_html(page, results)
    else:
        main()
