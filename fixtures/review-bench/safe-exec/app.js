import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function validRepoName(name) {
	return /^[A-Za-z0-9._-]+$/.test(name);
}

export function repoProbe(repoName) {
	if (!validRepoName(repoName)) throw new Error("invalid repo name");
	return execFileAsync(process.execPath, ["--version"], {
		cwd: `repos/${repoName}`,
		encoding: "utf8",
	});
}

export function publicUser(user) {
	return { id: user.id, name: user.name };
}
