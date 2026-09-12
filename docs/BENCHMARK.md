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

## Full 500-question run via OpenRouter (free tier)

Free-tier reality (OpenRouter, verified Aug 2026): `:free` models are capped
at **20 requests/min** and **50 requests/day** — or **1,000/day** once you've
ever purchased $10 in credits (one-time, permanent). A 500-question run makes
~500–1,000 calls, so a single free provider WILL die. Two mitigations:

1. **Failover chain** — set several providers; the harness rotates on 429s:

```bash
# .env — all three are used; order = preference
GEMINI_API_KEY=...                            # free, ~1.5k req/day
GROQ_API_KEY=...                              # free
LOREX_LLM_BASE_URL=https://openrouter.ai/api/v1
LOREX_LLM_API_KEY=sk-or-...
LOREX_EVAL_MODEL=openrouter/free              # OpenRouter's auto-router
```

2. **Buy $10 of OpenRouter credit once** to lift the daily cap to 1,000
   requests/day, then keep using `:free` models.

Useful current `:free` IDs (roster shifts monthly — verify on
openrouter.ai/collections/free-models):

| Model | Why |
|---|---|
| `stealth/ox-alpha` | **Recommended.** Free, 1M ctx, strong reasoner with tool support |
| `openrouter/free` | Auto-router: picks whichever free model is available |
| `openai/gpt-oss-120b:free` | General reasoning |
| `z-ai/glm-4.5-air:free` | Lightweight chat/reasoning |

Avoid stale blog lists naming DeepSeek/Gemini/Mistral `:free` IDs — those were
removed from OpenRouter.

```bash
npm run bench:live -- --yes --no-baseline --synth   # resumable via checkpoints
```

Notes for hitting a high score honestly:

- **Use `--synth`.** The default arm judges the raw pack; `--synth` generates
  a grounded, citation-checked answer from the pack first — the same
  retrieve → answer → judge protocol published systems use. This is the
  single biggest accuracy lever.
- **Free models are rate-limited.** Prefer `google/gemini-2.5-flash` or any
  current `:free` variant; the harness checkpoints after every question, so
  re-run without `--fresh` to resume after throttling.
- **Do not tune against abstention questions.** They are ~5% of the set;
  over-eager verification trades hallucination points for
  `abstained_incorrectly`.
- Reference point: EverOS reports **~82–83% on LongMemEval-S** with GPT-4.1-mini
  as the answer model; Mem0 reports ~49%. An 85% claim needs the synth arm,
  a strong answer model, and both arms on the same judge.
- Quote results only from a `--live` run with an LLM judge (`mode: "live"`,
  `judge.method: "llm-two-stage"` in the report JSON).
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
