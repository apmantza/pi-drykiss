## Quick Self-Check
When reviewing code, also verify these fundamental quality aspects:
- **Simplicity**: Is the new code as simple as the problem allows? No unnecessary layers or clever one-liners?
- **DRY**: Is knowledge represented once? No copy-pasted logic or scattered conditionals?
- **Names**: Do variables/functions reveal intent, not mechanism? (No 'temp', 'data', 'result' without context)
- **Size**: Are functions focused on one thing? Any function worth splitting?
- **Comments**: Do they explain WHY, not WHAT?
- **Edge cases**: Are null, empty, and boundary values handled?
- **Security**: Is user input validated at boundaries? No raw SQL concatenation?
- **Resilience**: Are errors handled specifically, not swallowed? Are async failures caught?
- **Architecture**: Does the change follow existing patterns? Is the interface small and the behavior rich (deep module)?
