# KISS Deterministic Rules — Analysis

> Notes on the rule system used by [`dsweet99/kiss`](https://github.com/dsweet99/kiss),
> the static-analysis tool that inspired several design choices in pi-drykiss.
> This document is a *description*, not an endorsement — every rule listed
> below is a property kiss can compute deterministically from a parse tree,
> and each one has different trade-offs when compared to pi-drykiss's
> LLM-driven review.

## Overview

`kiss` is a Rust CLI (`kiss-ai` on crates.io, version 0.4.8) that:

1. Parses Python files with **tree-sitter** (`tree-sitter 0.24`, `tree-sitter-python 0.23`).
2. Parses Rust files with **`syn`** (`syn 2` with the `full` feature).
3. Walks the resulting AST, computing a small set of per-function,
   per-class, per-file, and per-module metrics.
4. Compares each metric to a threshold (either from the bundled
   `kissconfig-default` or from a user-customized `.kissconfig`).
5. Emits a one-line `VIOLATION:<rule>:<path>:<line>:<symbol>: <diagnosis> <fix>` for every
   threshold breach.

The tool is **not** an LLM. It is a pure static analyzer with deterministic
output. The LLM integration is a side-channel: the user pastes the output of
`kiss rules` into their agent's context, and the agent iterates until
`kiss check` passes.

## Languages and Parsers

| Language | Parser | Why this parser |
|----------|--------|-----------------|
| Python   | [tree-sitter](https://tree-sitter.github.io/tree-sitter/) via `tree-sitter-python` | Robust against syntax errors, language-agnostic, fast incremental parsing. Tree-sitter's lossless CST gives `kind()` strings like `"if_statement"`, `"function_definition"`, etc. — the metric code matches on these string names. |
| Rust     | [`syn`](https://docs.rs/syn/) with the `full` feature | Idiomatic for Rust code. `syn` produces typed AST nodes (`syn::ItemFn`, `syn::ExprIf`, etc.) — the metric code destructures them. Tree-sitter would also work, but `syn` is the established Rust tooling. |

**The implementation pattern is the same in both languages:** an
AST walker visits each `function_definition` (Python) or `ItemFn` (Rust),
extracts the body, and runs a small set of count operations. The Python
walker is `walk_py_ast` in `src/py_metrics/walk.rs`; the Rust equivalent
is in `src/rust_fn_metrics/`.

### Example: counting statements (Python, `src/py_metrics/statements.rs`)

```rust
pub(super) fn count_statements(node: Node) -> usize {
    let mut cursor = node.walk();
    node.children(&mut cursor)
        .map(|c| {
            let stmt = usize::from(is_statement(c.kind()));
            if is_nested_scope_boundary(c.kind()) {
                stmt
            } else {
                stmt + count_statements(c)
            }
        })
        .sum()
}

pub(super) fn is_statement(kind: &str) -> bool {
    matches!(
        kind,
        "expression_statement"
            | "return_statement"
            | "if_statement"
            | "for_statement"
            | "while_statement"
            | "try_statement"
            // ... ~20 more node kinds
    )
}
```

This is a textbook tree-sitter walk: `Node::walk()` → `children()` → match
on `kind()`. No symbolic evaluation, no type inference, no dataflow.
Just "count the children of these kinds."

## The Rule Catalogue

There are roughly 35 deterministic rules across the two languages. They
fall into four families, each measuring a different code-quality
dimension.

### 1. Function-level complexity

These rules fire per function or method. The threshold is a single
number; the violation names the function and the line where it's
defined.

| Rule | What it counts | Default (Python) | Default (Rust) |
|------|----------------|------------------|----------------|
| `statements_per_function` | Number of statement nodes in the body (excludes imports and signatures) | 35 | 35 |
| `branches_per_function` | Count of `if`/`elif`/`case_clause` (Python) or `if` expressions (Rust) | 9 | 9 |
| `nested_function_depth` | Maximum nesting depth of closures/functions inside the body | 2 | 2 |
| `max_indentation` | Deepest block nesting (column-based) | 4 | 4 |
| `local_variables` | Distinct names assigned in the body | 15 | 16 |
| `returns_per_function` | Count of `return` statements | 5 | 5 |
| `return_values_per_function` | Maximum values in a single return | 3 | — |
| `statements_per_try_block` | Width of the largest `try` block | 3 | — |
| `boolean_parameters` | Number of `True/False` defaults (Python) or `bool` parameters (Rust) | 1 | 1 |
| `attributes_per_function` | Non-doc attributes (Rust only) | — | 1 |
| `decorators_per_function` | Python decorators (TOML key maps to `annotations_per_function`) | 5 | — |
| `calls_per_function` | Number of function/method call expressions | 20 | 20 (Rust: 45) |

**Source:** the function metric collectors in `src/py_metrics/` and
`src/rust_fn_metrics/`. The Rust side uses `syn::visit::Visit` to walk
each `ItemFn` body.

**What these rules are based on:** standard software-engineering
literature. `branches_per_function` is a proxy for McCabe's cyclomatic
complexity (1976). `statements_per_function` and
`nested_function_depth` are Fowler's "Long Function" and "Long Method"
smells (*Refactoring*, 2nd ed.). `returns_per_function` > 1 is the
"Multiple Return Points" smell. `statements_per_try_block` is the
"Swallowed Exception" smell in disguise — a wide `try` block obscures
which line actually raised.

### 2. Function signature

| Rule | What it counts | Default (Python) | Default (Rust) |
|------|----------------|------------------|----------------|
| `positional_args` | Number of non-keyword parameters | 3 | 4 (all non-self) |
| `keyword_only_args` | Number of `*`-separated keyword-only parameters | 3 | — |
| `arguments` | Total parameter count (Rust) | — | 4 |

**Source:** `src/py_metrics/parameters.rs` and `src/rust_fn_metrics/`.

**What these rules are based on:** Fowler's "Long Parameter List" smell
and the "Parameter Object" refactoring. Three positional args is
roughly the threshold where most humans start writing wrong call sites
in Python; four for Rust is slightly higher because Rust encourages
method chaining (which itself argues for *fewer* args per call, not
more — the threshold here is a compromise).

### 3. Class / type structure

| Rule | What it counts | Default (Python) | Default (Rust) |
|------|----------------|------------------|----------------|
| `methods_per_class` | Number of methods in a class (Python) or `impl` block (Rust) | 10 | 10 |
| `interface_types_per_file` | Number of `Protocol`/`ABC` (Python) or `trait` (Rust) definitions | 1 | 0 |
| `concrete_types_per_file` | Number of `class` (non-Protocol/ABC) or `struct`/`enum`/`union` (Rust) definitions | 1 | 4 |

**Source:** `src/py_metrics/`, `src/rust_counts/`.

**What these rules are based on:** Fowler's "God Class" smell
(`methods_per_class`), and the Interface Segregation Principle
(`interface_types_per_file` = how many small traits/Protocols a file
should ideally define). The Rust `concrete_types_per_file = 4` cap is
deliberately higher than Python's `1` because Rust's idiomatic
single-file modules often group several types together.

### 4. File- and module-level structure

| Rule | What it counts | Default (Python) | Default (Rust) |
|------|----------------|------------------|----------------|
| `statements_per_file` | Statements inside function/method bodies in the file | 200 | 250 |
| `lines_per_file` | Total source lines (including blanks and comments) | 300 | 400 |
| `functions_per_file` | Top-level function/method definitions | 10 | 23 |
| `imported_names_per_file` | Unique imported names (excludes `TYPE_CHECKING` in Python, `pub use` in Rust) | 30 | 50 |
| `cycle_size` | Maximum number of modules in a dependency cycle | 0 | 0 |
| `indirect_dependencies` | Modules reachable only transitively (total reachable − direct fan-out) | 10 | 10 |
| `dependency_depth` | Longest import chain | 3 | 3 |

**Source:** `src/py_metrics/file_stats.rs`, `src/rust_graph/` for the
graph metrics. The graph algorithms use `petgraph 0.7` (`Cycle` and
topological-sort visitors).

**What these rules are based on:** Robert Martin's *Clean Architecture*
— specifically the Acyclic Dependencies Principle (`cycle_size = 0`)
and the Stable Dependencies Principle (`dependency_depth`).
`imported_names_per_file` is a proxy for "Inappropriate Intimacy"
between modules: a file that imports 30+ names from elsewhere is
probably coupled to too many things.

### 5. Cross-cutting

Two rules don't fit the per-function / per-file taxonomy.

| Rule | What it counts | Default |
|------|----------------|---------|
| `test_coverage_threshold` | Static check: percent of functions/methods per file whose names appear in a test file | 90% |
| `min_similarity` | Min Jaccard similarity to report duplicate code (only fires when `duplication_enabled = true`) | 0.9 |
| `duplication_enabled` | Whether the duplication detector is on at all | `true` |
| `orphan_module_enabled` | Whether modules with zero fan-in are flagged | `true` |

**`test_coverage_threshold`** is a *static* heuristic — it parses test
file names and looks for the function name as a substring, then
divides matched-by-total. It is not real coverage. The 90% default is
a Doug Bloodworth / Emily Bache "good unit-test coverage" heuristic
that comes up often in TDD literature.

**`min_similarity`** powers a duplication detector. The algorithm is
not visible in the README, but the source tree has
`src/duplication/clustering.rs` and `src/duplication/extraction.rs`,
and there's a `src/minhash/` directory — strongly suggesting
**MinHash LSH** (or a similar shingling + locality-sensitive hashing
scheme) is used to find near-duplicate code blocks across files. The
0.9 threshold is tight: 90% Jaccard similarity before a duplicate is
flagged. pi-drykiss's bucketing uses a similar Jaccard scheme but
with a much lower threshold (0.25) because it's matching *finding
summaries* across reviews, not code blocks.

**`orphan_module_enabled`** powers a "find modules with no callers"
detector. An orphan module is dead code or a public API without
internal consumers; both are worth a look.

## Where the Thresholds Come From

Two sources, in priority order:

1. **`kissconfig-default`** at the repo root, with a `[python]` and
   `[rust]` section. These are kiss's hard-coded opinions.
2. **`.kissconfig`** in the user's repo, which overrides the defaults
   per-rule.

There is also a third path — `kiss clamp` — which **measures the user's
actual codebase** and clamps every threshold to the current
95th-percentile (or similar) of the repo's distribution. This is the
"give me a sensible starting point for an existing codebase" path. The
user can then manually tune from there.

The thresholds themselves are **not derived from any formal model.**
They are pragmatic: the README describes them as "the upper-bound of
the complexity of your codebase" and the values are tuned to flag
clear smells without generating noise on idiomatic code. Reading the
`kissconfig-default` next to the README, the philosophy is:

- **Strict on what humans get wrong easily** (`positional_args`,
  `boolean_parameters`).
- **Loose on what varies by domain** (`statements_per_function = 35`
  is generous; some teams want 20, others want 50).
- **Hard on architectural smells** (`cycle_size = 0` is non-negotiable;
  `dependency_depth < 3` is tight).

## What kiss *Can't* Detect

This is the part most relevant to pi-drykiss's design space. The
deterministic rules have a sharp ceiling:

| Class of bug | Detectable by `kiss`? | Detectable by an LLM? |
|--------------|----------------------|-----------------------|
| Function too long, too many args | ✅ (counted directly) | ✅ (also catchable) |
| Cyclic imports, deep fan-in | ✅ (graph walk) | ⚠️ (LLMs miss structural patterns) |
| Duplicated code blocks | ✅ (MinHash) | ⚠️ (LLMs paraphrase too well) |
| **Off-by-one in a boundary check** | ❌ | ✅ |
| **Wrong type guard (`typeof NaN === "number"`)** | ❌ | ✅ |
| **Race condition in async cleanup** | ❌ | ✅ |
| **Cache invalidation that's "correct by construction" but wrong in practice** | ❌ | ✅ |
| **Trust boundary violation (input crossing disk/wire without validation)** | ❌ | ✅ |
| **Resource leak (timer never cleared)** | ❌ | ✅ |
| **API contract drift between producer and consumer** | ❌ | ✅ |
| **Comments that contradict the code** | ❌ | ✅ |
| **Subtle logic errors in `if/else` chains** | ❌ | ✅ |

The left column is *exactly* what pi-drykiss's adversarial passes (in
deep mode) are designed to catch. The two tools are complementary:
`kiss` provides cheap, deterministic enforcement of structural
invariants; pi-drykiss provides expensive, semantic judgment about
correctness.

## The LLM Hookup: How kiss is Actually Used

This is the part of the design that inspired pi-drykiss's
`/drykiss-rules` proposal. From the README:

> You can help your LLM produce rule-following code by adding the
> output of `kiss rules` to its context before it starts coding.
> For example, you might put this in `.cursorrules` (or maybe
> `AGENTS.md`):
>
> ```
> FIRST STEP: After the user's first request, before doing anything
> else, call `kiss rules`
> ```

The `kiss rules` subcommand dumps a structured markdown list of every
rule, its threshold, and a one-line description of what it counts. The
user pastes this into their agent's context (a `.cursorrules` file, a
system-prompt section, etc.), and the agent now has the *same set of
checks* that `kiss check` will enforce, baked into its planning.

The workflow is:

```
┌──────────────┐
│ User prompt  │
└──────┬───────┘
       │
       ▼
┌──────────────────────────────────┐
│ LLM agent                      │
│ (with kiss rules in context)   │
│                                  │
│  1. Plan a change                │
│  2. Write the code                │
│  3. Run kiss check               │
│  4. If violations: refactor      │
│  5. Goto 3                       │
└──────┬───────────────────────────┘
       │ writes code
       ▼
┌──────────────┐
│ git commit   │
└──────────────┘
```

The pre-commit hook (`scripts/pre-commit-kiss.sh`) optionally enforces
that `kiss check` passes before allowing a commit.

## Implications for pi-drykiss

The `kiss` design surfaces three concrete borrowings for pi-drykiss:

1. **Compact violation format.** Kiss's one-line `VIOLATION:` format
   is dramatically more compact than pi-drykiss's JSON-shaped
   `ReviewResult`. For the agent's context budget, a compact text
   format (default) plus the structured JSON (for the widget and
   persistence) would be a net win.

2. **`/drykiss-rules` command.** A slash command that dumps the
   effective check criteria (lens `.md` files + active constraints +
   risk codes) as a ready-to-paste markdown block. This lets users
   ground their agent in pi-drykiss's review standards the same way
   `kiss rules` grounds the agent in kiss's.

3. **Static + semantic complementarity.** The two tools are not
   competitors — they cover different bug classes. A future
   integration could be: run `kiss check` first (cheap, fast,
   deterministic, blocks the commit on structural smells), then run
   `pi /drykiss` (expensive, LLM-based, catches semantic bugs the
   static analyzer can't see). The pre-commit hook is the natural
   place to chain them.

The rest of the `kiss` design — language-specific metric collectors,
the per-rule threshold file, the `clamp`/`shrink` workflows — is
intentionally out of scope for pi-drykiss, which is language-agnostic
and LLM-driven by design. Borrow the shape, not the substance.
