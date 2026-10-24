#!/bin/bash
# One ollama generation (gemma4:12b, 400 tokens, keep_alive 2m so it unloads soon after the test).
curl -s http://127.0.0.1:11434/api/generate -d '{"model":"gemma4:12b","prompt":"Write a detailed 600-word story about a lighthouse keeper.","stream":false,"keep_alive":"2m","options":{"num_predict":400,"temperature":0}}' \
 | python3 -c 'import json,sys;d=json.load(sys.stdin);print("ollama eval_count=%d tok/s=%.1f load=%.1fs total=%.1fs"%(d["eval_count"],d["eval_count"]/(d["eval_duration"]/1e9),d.get("load_duration",0)/1e9,d["total_duration"]/1e9))'
