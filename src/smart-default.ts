import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type SmartDefaultTarget = {
	readonly ref: string;
	readonly label: string;
};

export async function hasUncommittedChanges(
	pi: ExtensionAPI,
): Promise<boolean> {
	const result = await pi.exec("git", ["status", "--porcelain"]);
	return result.code === 0 && result.stdout.trim().length > 0;
}

export async function getCurrentBranch(
	pi: ExtensionAPI,
): Promise<string | null> {
	const result = await pi.exec("git", ["branch", "--show-current"]);
	if (result.code === 0 && result.stdout.trim()) {
		return result.stdout.trim();
	}
	return null;
}

export async function getDefaultBranch(pi: ExtensionAPI): Promise<string> {
	const result = await pi.exec("git", [
		"symbolic-ref",
		"refs/remotes/origin/HEAD",
		"--short",
	]);
	if (result.code === 0 && result.stdout.trim()) {
		return result.stdout.trim().replace("origin/", "");
	}
	const branches = await pi.exec("git", [
		"branch",
		"--format=%(refname:short)",
	]);
	if (branches.code === 0) {
		const list = branches.stdout
			.trim()
			.split("\n")
			.filter((b) => b.trim());
		if (list.includes("main")) return "main";
		if (list.includes("master")) return "master";
	}
	return "main";
}

export async function resolveSmartDefault(
	pi: ExtensionAPI,
): Promise<SmartDefaultTarget> {
	if (await hasUncommittedChanges(pi)) {
		return { ref: "HEAD", label: "uncommitted changes" };
	}
	const current = await getCurrentBranch(pi);
	const defaultBranch = await getDefaultBranch(pi);
	if (current && current !== defaultBranch) {
		return {
			ref: defaultBranch,
			label: `branch diff against ${defaultBranch}`,
		};
	}
	return { ref: "HEAD", label: "local changes" };
}
