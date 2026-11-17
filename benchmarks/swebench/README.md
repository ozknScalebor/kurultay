# SWE-bench runs

Each folder is one comparison. Put the predictions the agents produced offline here and push –
the `swebench` workflow grades them with the official harness and commits `results-*.json` and
`RESULTS.md`; the table is also added to the latest release's notes.

```
benchmarks/swebench/<run>/
  meta.json                     optional: {"dataset": "SWE-bench/SWE-bench_Verified", "note": "50 instances, seed 42"}
  predictions-<agent>.jsonl     kurultay swebench run / collect
  runs-<agent>.jsonl            optional: time and requests per instance (check it holds nothing internal)
```

Dataset names: `SWE-bench/SWE-bench_Verified`, `SWE-bench/SWE-bench_Lite`, `SWE-bench/SWE-bench_Multilingual`.
