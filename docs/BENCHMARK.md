# Benchmark: LongMemEval head-to-head

The harness (`src/evaluation/longmemeval.ts`) runs two systems over the same
questions with the same model and the same judge, differing in exactly one
variable — the context each is given.

```
ARM A — flat window : the raw haystack, up to 115k tokens
ARM B — Lorex       : a retrieved pack sized at haystack / 46
```

## Scoring

Two stages, each blind to what would let it cheat:

1. **Answer** — generated from context alone; the gold answer is never in this
   prompt. The model may reply `NOT_IN_CONTEXT`.
2. **Grade** — candidate against gold, with the context withheld, so a verbose
   context cannot buy a YES.

Outcomes are classified five ways rather than correct/incorrect:

| Outcome | Meaning |
|---|---|
| `correct` | answerable question, answered right |
| `wrong_answer` | answerable question, answered wrong |
| `abstained_correctly` | unanswerable question, declined |
| `abstained_incorrectly` | answerable question, declined |
| `hallucinated` | unanswerable question, answered anyway |

Accuracy counts `correct + abstained_correctly`: knowing when to say nothing is
part of being right.

## Running

```bash
npm run bench:download    # fetch LongMemEval_s into data/
npm run bench:mock        # offline smoke test (mock backend)
npm run bench:slice       # 50 questions, live HydraDB + LLM judge
npm run bench:live -- --yes   # full 500
```

The run projects its LLM spend and asks before spending it, checkpoints after
every question (`--fresh` to restart), and streams the dataset rather than
loading it.

## Guardrails

- **Sampling is stratified.** The dataset is stored grouped by question type,
  so `--limit N` without stratification would report the easiest category as if
  it were the benchmark. `--no-stratify` opts out.
- **Offline runs withhold the head-to-head delta.** Lexical scoring asks
  whether a context *contains* the gold, and a 115k window always contains more
  than a small pack — that measures size, not quality. The comparison is
  emitted only under the LLM judge.

## Known limitation

Published numbers are produced against the mock backend. Running the full
benchmark against live HydraDB repeatedly was cost-prohibitive and hit rate
ceilings when driven by an agent; the real client is fully implemented and used
in normal operation, but large-scale evaluation ran offline through
`MockHydraDB`.

## Abstention threshold derivation

`MIN_LEXICAL_RELEVANCE = 0.25` is measured, not guessed. Running 48 stratified
questions with the gate disabled and recording relevance per question:

```
answerable    n=43  min 0.286  median 0.562  max 1.000
unanswerable  n=4   min 0.375  median 0.500  max 0.778

threshold   unanswerable caught   answerable lost
     0.25            0 / 4              1 / 44
     0.40            1 / 4              5 / 44
     0.60            3 / 4             23 / 44
```

The distributions overlap almost entirely — lexical overlap alone cannot
separate them, and every threshold that catches an unanswerable question costs
several answerable ones. 0.25 rejects out-of-domain questions at nearly no
cost and does not pretend to solve the in-domain case. Detecting a plausible
question whose answer is simply absent remains open; on the benchmark that gap
is partly covered by the answering model seeing that the answer is not in the
pack — a real, measured effect, but attributable to the model, not Lorex.
