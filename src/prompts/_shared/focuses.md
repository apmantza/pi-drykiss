# Per-Pass Focus Seeds

Each pass in the Bugbot deep-review pipeline gets a different "lens of
suspicion" so multiple passes don't collapse onto the same findings. The
seeds below are rotated round-robin across passes; combined with a small
temperature jitter, this diversifies the reasoning the same way Bugbot
randomizes its diff ordering.

## When to use these

These are passed as a "PASS FOCUS" block in the user prompt, after the
base diff and lens context. The pass system prompt tells the model to
"weight your attention here, but report any bug you see" — so the focus
steers the model's exploration but does not limit the kinds of bugs it
can surface.

## Focus seeds

1. **TRUST BOUNDARIES & INPUT VALIDATION.** Every value crossing an
   external, disk, wire, or user boundary; every decode/parse. Construct
   the edge inputs (null, undefined, NaN, Infinity, -0, empty, huge,
   negative, duplicate, out-of-order, unicode) and ask what breaks.
   Numeric-type guards that `NaN` or `Infinity` defeat. Missing auth
   checks on internal endpoints.

2. **CONTROL FLOW & BRANCHES.** Every new conditional, guard, early
   return, and switch — find the missed case, the inverted condition,
   the off-by-one. Audit any `if/else` against a truth table covering
   boundary values, not just the happy path.

3. **ASYNC LIFECYCLE & CONCURRENCY.** Await ordering, missing await,
   unhandled rejection, fire-and-forget, races, cancellation/abort
   handling, stale writes after unmount/navigation. Shared state
   without locks. Promise.all on mixed-resolve/reject sources.

4. **TYPES & INVARIANTS.** Type-narrowing escapes, unsafe casts, non-null
   assertions on absent values, non-exhaustive unions, and any
   comment/test claim that the code does not actually honor. Generic
   widening. Implicit any. Schema drift between a producer and its
   consumer.

5. **STATE & DATA INTEGRITY.** In-memory or UI mutation with no matching
   durable write (lost on reload), wrong id/key space in a lookup, a
   projection clobbering the source of truth, read-before-write
   ordering. Lost updates on optimistic concurrency. Cache invalidation
   gaps.

6. **ERROR HANDLING & SECURITY.** Swallowed/empty catches, leaked
   secrets, injection, path traversal / zip-slip, trusting unsanitized
   external data, missing validation before a side effect, error paths
   that leak stack traces or PII.

7. **RESOURCE & PERFORMANCE.** Unbounded loops/polls, N+1 IO, memory
   leaks, missing cleanup of timers/listeners/streams, growing data
   structures without bounds, large allocations on hot paths.

8. **CONTRACT & COMPATIBILITY.** Signature/shape drift, breaking
   changes to a wire/format contract, mismatched assumptions between a
   producer and its consumer, version negotiation gaps, deprecated
   paths that should be removed.
