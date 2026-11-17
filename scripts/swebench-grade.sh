#!/usr/bin/env bash
# Grade every predictions-<agent>.jsonl of one benchmark folder with the official SWE-bench harness.
#   scripts/swebench-grade.sh benchmarks/swebench/<run>
# Writes <run>/results-<agent>.json and <run>/RESULTS.md. Instances are graded in batches of 10 with
# the Docker images removed in between, so a CI runner's disk is enough.
set -uo pipefail
dir="$1"
run=$(basename "$dir")
dataset=$(python -c "import json,os,sys;f=os.path.join(sys.argv[1],'meta.json');print(json.load(open(f)).get('dataset','SWE-bench/SWE-bench_Verified') if os.path.exists(f) else 'SWE-bench/SWE-bench_Verified')" "$dir")
for preds in "$dir"/predictions-*.jsonl; do
  [ -e "$preds" ] || continue
  agent=$(basename "$preds" .jsonl); agent=${agent#predictions-}
  id="$run-$agent"
  echo "::group::$id ($dataset)"
  python -c "
import json, sys
ids = [json.loads(l)['instance_id'] for l in open(sys.argv[1]) if l.strip()]
for i in range(0, len(ids), 10): print(' '.join(ids[i:i + 10]))" "$preds" > /tmp/batches.txt
  while read -r batch; do
    # shellcheck disable=SC2086
    python -m swebench.harness.run_evaluation --dataset_name "$dataset" --predictions_path "$preds" \
      --instance_ids $batch --max_workers 2 --run_id "$id" --timeout 1800 || echo "::warning::harness error in a batch of $id"
    docker system prune -af >/dev/null 2>&1 || true
  done < /tmp/batches.txt
  # one report over every batch of this run
  python -m swebench.harness.run_evaluation --dataset_name "$dataset" --predictions_path "$preds" --run_id "$id" --rewrite_reports True || true
  # 4.x writes <model>.<run_id>.json in the working directory, 5.x logs/evaluation/<run_id>/results.json
  report=$(ls -t ./*."$id".json "logs/evaluation/$id/results.json" 2>/dev/null | head -1)
  if [ -n "$report" ]; then cp "$report" "$dir/results-$agent.json"; else echo "::warning::no report for $id"; fi
  echo "::endgroup::"
done
node scripts/swebench-summary.mjs "$dir"
