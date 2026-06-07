/**
 * auto-inject.ts — KISS/DRY auto-injection block for TUI-side agent feedback.
 *
 * After any turn that edits files, this block is prepended to the next system
 * prompt so the agent self-checks before proceeding. It is NOT an LLM prompt
 * fragment — it's a TUI-side message exempt from the `.md`-only constraint.
 */

/**
 * Builds the KISS/DRY quick-check block for the auto-injector.
 */
export function buildAutoInjectBlock(edits: {
	files: ReadonlyArray<{ path: string; language: string | null }>;
}): string {
	const fileList = edits.files.map((f) => f.path).join(", ");
	return `\n\n## KISS/DRY Quick Check

You edited: ${fileList}. Before proceeding, briefly verify:

- [ ] **KISS**: Is the new code as simple as the problem allows? No unnecessary layers or clever one-liners? No speculative features?
- [ ] **DRY**: Is knowledge represented once? No copy-pasted logic or scattered conditionals?
- [ ] **Names**: Do variables/functions reveal intent, not mechanism? (No 'temp', 'data', 'result' without context)
- [ ] **Size**: Are functions focused on one thing? Any function worth splitting?
- [ ] **Comments**: Do they explain WHY, not WHAT?
- [ ] **Edge cases**: Are null, empty, and boundary values handled?
- [ ] **Security**: Is user input validated at boundaries? No raw SQL concatenation?
- [ ] **Resilience**: Are errors handled specifically, not swallowed? Are async failures caught?
- [ ] **Architecture**: Does the change follow existing patterns? Is the interface small and the behavior rich (deep module)?

Fix any quick wins, then continue.`;
}
