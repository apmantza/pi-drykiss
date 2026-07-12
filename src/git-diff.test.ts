import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	getChangedFiles,
	getFileDiff,
	getFileContent,
	getProjectIndex,
	getAllSourceFiles,
	redactSecrets,
} from "./git-diff.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	readFile,
	readdir,
	stat,
	lstat,
	realpath,
	open,
} from "node:fs/promises";

vi.mock("node:fs/promises", () => ({
	readFile: vi.fn(),
	readdir: vi.fn(),
	stat: vi.fn(),
	lstat: vi.fn(),
	realpath: vi.fn(),
	open: vi.fn(),
}));

function mockPi(stdout: string): ExtensionAPI {
	return {
		exec: vi
			.fn()
			.mockResolvedValue({ stdout, stderr: "", code: 0, killed: false }),
	} as unknown as ExtensionAPI;
}

describe("getChangedFiles", () => {
	it("returns explicit files when provided", async () => {
		const pi = mockPi("");
		const files = await getChangedFiles(pi, "/cwd", {
			files: ["src/foo.ts", "lib/bar.py"],
			ref: "HEAD",
			staged: false,
			all: false,
		});
		expect(files).toHaveLength(2);
		expect(files[0]).toMatchObject({
			path: "src/foo.ts",
			status: "modified",
			language: "TypeScript",
		});
		expect(files[1]).toMatchObject({
			path: "lib/bar.py",
			status: "modified",
			language: "Python",
		});
	});

	it("filters explicit files matching ignorePatterns", async () => {
		const pi = mockPi("");
		const files = await getChangedFiles(
			pi,
			"/cwd",
			{
				files: ["src/foo.ts", "src/foo.generated.ts", "lib/bar.py"],
				ref: "HEAD",
				staged: false,
				all: false,
			},
			["**/*.generated.ts"],
		);
		expect(files.map((f) => f.path)).toEqual(["src/foo.ts", "lib/bar.py"]);
	});

	it("rejects refs that look like git options", async () => {
		const pi = mockPi("");

		await expect(
			getChangedFiles(pi, "/cwd", {
				files: [],
				ref: "--output=/tmp/evil",
				staged: false,
				all: false,
			}),
		).rejects.toThrow("Invalid git ref");

		expect(pi.exec).not.toHaveBeenCalled();
	});

	it("filters git diff output matching ignorePatterns", async () => {
		const pi = mockPi("M\tsrc/index.ts\nA\tsrc/index.generated.ts\nD\told.js");
		const files = await getChangedFiles(
			pi,
			"/cwd",
			{
				files: [],
				ref: "HEAD",
				staged: false,
				all: false,
			},
			["**/*.generated.ts"],
		);
		expect(files.map((f) => f.path)).toEqual(["src/index.ts", "old.js"]);
	});

	it("filters all-source files matching ignorePatterns", async () => {
		vi.mocked(readdir).mockResolvedValue([
			{
				name: "foo.ts",
				isDirectory: () => false,
				isFile: () => true,
				isSymbolicLink: () => false,
			},
			{
				name: "foo.generated.ts",
				isDirectory: () => false,
				isFile: () => true,
				isSymbolicLink: () => false,
			},
		] as any);
		vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as any);
		const files = await getChangedFiles(
			mockPi(""),
			"/cwd",
			{ files: [], ref: "HEAD", staged: false, all: true },
			["**/*.generated.ts"],
		);
		expect(files.some((f) => f.path.endsWith(".generated.ts"))).toBe(false);
		expect(files.some((f) => f.path.endsWith("foo.ts"))).toBe(true);
	});

	it("parses git diff --name-status output", async () => {
		const pi = mockPi(
			"M\tsrc/index.ts\nA\tsrc/new.tsx\nD\told.js\nR100\tsrc/old.ts\tsrc/new.ts",
		);
		const files = await getChangedFiles(pi, "/cwd", {
			files: [],
			ref: "HEAD",
			staged: false,
			all: false,
		});
		expect(files).toHaveLength(4);
		expect(files[0]).toMatchObject({
			path: "src/index.ts",
			status: "modified",
			language: "TypeScript",
		});
		expect(files[1]).toMatchObject({
			path: "src/new.tsx",
			status: "added",
			language: "TypeScript/React",
		});
		expect(files[2]).toMatchObject({
			path: "old.js",
			status: "deleted",
			language: "JavaScript",
		});
		expect(files[3]).toMatchObject({
			path: "src/new.ts",
			status: "renamed",
			language: "TypeScript",
		});
	});

	it("filters unknown status codes", async () => {
		const pi = mockPi("M\tvalid.ts\n?\tuntracked.txt\n\t\n");
		const files = await getChangedFiles(pi, "/cwd", {
			files: [],
			ref: "HEAD",
			staged: false,
			all: false,
		});
		expect(files).toHaveLength(1);
		expect(files[0].path).toBe("valid.ts");
	});

	it("handles staged flag", async () => {
		const pi = mockPi("M\tstaged.ts");
		await getChangedFiles(pi, "/cwd", {
			files: [],
			ref: "HEAD",
			staged: true,
			all: false,
		});
		expect(pi.exec).toHaveBeenCalledWith("git", [
			"-C",
			"/cwd",
			"diff",
			"--cached",
			"--name-status",
		]);
	});

	it("handles ref comparison", async () => {
		const pi = mockPi("M\tref.ts");
		await getChangedFiles(pi, "/cwd", {
			files: [],
			ref: "main",
			staged: false,
			all: false,
		});
		expect(pi.exec).toHaveBeenCalledWith("git", [
			"-C",
			"/cwd",
			"diff",
			"--name-status",
			"main...HEAD",
		]);
	});

	it("detects language from file extension", async () => {
		const pi = mockPi(
			"M\tapp.ts\nM\tapp.tsx\nM\tscript.js\nM\tscript.jsx\nM\tmain.py\nM\tserver.go\nM\tlib.rs\nM\tquery.sql\nM\tpage.html\nM\tstyle.css\nM\tstyle.scss\nM\tdata.json\nM\tconfig.yaml\nM\treadme.md\nM\tdeploy.sh\nM\tunknown.xyz",
		);
		const files = await getChangedFiles(pi, "/cwd", {
			files: [],
			ref: "HEAD",
			staged: false,
			all: false,
		});
		const map = Object.fromEntries(files.map((f) => [f.path, f.language]));
		expect(map["app.ts"]).toBe("TypeScript");
		expect(map["app.tsx"]).toBe("TypeScript/React");
		expect(map["script.js"]).toBe("JavaScript");
		expect(map["script.jsx"]).toBe("JavaScript/React");
		expect(map["main.py"]).toBe("Python");
		expect(map["server.go"]).toBe("Go");
		expect(map["lib.rs"]).toBe("Rust");
		expect(map["query.sql"]).toBe("SQL");
		expect(map["page.html"]).toBe("HTML");
		expect(map["style.css"]).toBe("CSS");
		expect(map["style.scss"]).toBe("SCSS");
		expect(map["data.json"]).toBe("JSON");
		expect(map["config.yaml"]).toBe("YAML");
		expect(map["readme.md"]).toBe("Markdown");
		expect(map["deploy.sh"]).toBe("Shell");
		expect(map["unknown.xyz"]).toBeNull();
	});
});

describe("getAllSourceFiles", () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	function mockDirent(name: string, isDir: boolean) {
		return {
			name,
			isDirectory: () => isDir,
			isFile: () => !isDir,
			isSymbolicLink: () => false,
		} as any;
	}

	it("discovers all source files in src/", async () => {
		vi.mocked(stat)
			.mockResolvedValueOnce({ isDirectory: () => true } as any) // src
			.mockResolvedValueOnce({ isDirectory: () => false } as any) // lib
			.mockResolvedValueOnce({ isDirectory: () => false } as any) // app
			.mockResolvedValueOnce({ isDirectory: () => false } as any); // packages
		vi.mocked(readdir)
			.mockResolvedValueOnce([
				mockDirent("index.ts", false),
				mockDirent("utils", true),
			])
			.mockResolvedValueOnce([mockDirent("helpers.ts", false)]);

		const files = await getAllSourceFiles("/cwd");
		expect(files.length).toBeGreaterThanOrEqual(2);
		const paths = files.map((f) => f.path);
		expect(paths).toContain("src/index.ts");
		expect(paths).toContain("src/utils/helpers.ts");
	});

	it("skips node_modules and non-code files", async () => {
		vi.mocked(stat)
			.mockResolvedValueOnce({ isDirectory: () => true } as any) // src
			.mockResolvedValueOnce({ isDirectory: () => false } as any) // lib
			.mockResolvedValueOnce({ isDirectory: () => false } as any) // app
			.mockResolvedValueOnce({ isDirectory: () => false } as any); // packages
		vi.mocked(readdir).mockResolvedValue([
			mockDirent("node_modules", true),
			mockDirent("app.ts", false),
			mockDirent("readme.md", false),
			mockDirent("dist", true),
		]);

		const files = await getAllSourceFiles("/cwd");
		const paths = files.map((f) => f.path);
		expect(paths).toContain("src/app.ts");
		expect(paths).not.toContain("src/readme.md");
	});

	it("falls back to root when no source dirs exist", async () => {
		vi.mocked(stat).mockRejectedValue(new Error("ENOENT"));
		vi.mocked(readdir).mockResolvedValueOnce([mockDirent("index.ts", false)]);

		const files = await getAllSourceFiles("/cwd");
		expect(files).toHaveLength(1);
		expect(files[0].path).toBe("index.ts");
		expect(files[0].language).toBe("TypeScript");
	});
});

describe("getFileDiff", () => {
	it("fetches diff for a single file", async () => {
		const pi = mockPi("@@ -1,3 +1,4 @@\n+new line\n old content");
		const diff = await getFileDiff(pi, "/cwd", "src/foo.ts", {
			files: [],
			ref: "HEAD",
			staged: false,
			all: false,
		});
		expect(diff).toContain("new line");
		expect(pi.exec).toHaveBeenCalledWith("git", [
			"-C",
			"/cwd",
			"diff",
			"HEAD",
			"--",
			"src/foo.ts",
		]);
	});

	it("uses staged flag in diff command", async () => {
		const pi = mockPi("staged diff");
		await getFileDiff(pi, "/cwd", "src/foo.ts", {
			files: [],
			ref: "HEAD",
			staged: true,
			all: false,
		});
		expect(pi.exec).toHaveBeenCalledWith("git", [
			"-C",
			"/cwd",
			"diff",
			"--cached",
			"--",
			"src/foo.ts",
		]);
	});

	it("uses ref comparison in diff command", async () => {
		const pi = mockPi("ref diff");
		await getFileDiff(pi, "/cwd", "src/foo.ts", {
			files: [],
			ref: "main",
			staged: false,
			all: false,
		});
		expect(pi.exec).toHaveBeenCalledWith("git", [
			"-C",
			"/cwd",
			"diff",
			"main...HEAD",
			"--",
			"src/foo.ts",
		]);
	});

	it("redacts secrets from diff output before returning", async () => {
		const pi = mockPi("+const key = AKIAIOSFODNN7EXAMPLE;\n-normal line;\n");
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const diff = await getFileDiff(pi, "/cwd", "src/config.ts", {
			files: [],
			ref: "HEAD",
			staged: false,
			all: false,
		});
		expect(diff).toContain("[REDACTED]");
		expect(diff).not.toContain("AKIAIOSFODNN7EXAMPLE");
		expect(diff).toContain("normal line");
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining("Redacted 1 secret-like value(s)"),
		);
		warnSpy.mockRestore();
	});
});

describe("getFileContent", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		vi.mocked(lstat).mockResolvedValue({ isFile: () => true } as any);
		vi.mocked(realpath).mockImplementation((p) => Promise.resolve(p as string));
		// open() returns a fake handle whose readFile delegates to the
		// module-level readFile mock, so content tests keep working.
		vi.mocked(open).mockImplementation(
			async () =>
				({
					stat: () => Promise.resolve({ isFile: () => true } as any),
					readFile: ((...args: unknown[]) =>
						(readFile as unknown as (...a: unknown[]) => Promise<unknown>)(
							...args,
						)) as any,
					close: () => Promise.resolve(),
				}) as any,
		);
	});

	it("returns full content for small files", async () => {
		vi.mocked(readFile).mockResolvedValue("line1\nline2\nline3");
		const result = await getFileContent("/cwd", "src/app.ts");
		expect(result).not.toBeNull();
		expect(result!.content).toBe("line1\nline2\nline3");
		expect(result!.lineCount).toBe(3);
		expect(result!.truncated).toBe(false);
	});

	it("truncates files over 500 lines", async () => {
		const lines = Array.from({ length: 600 }, (_, i) => `line${i + 1}`);
		vi.mocked(readFile).mockResolvedValue(lines.join("\n"));
		const result = await getFileContent("/cwd", "src/big.ts");
		expect(result).not.toBeNull();
		expect(result!.truncated).toBe(true);
		expect(result!.lineCount).toBe(600);
		expect(result!.content).toContain("... (truncated: 100 more lines) ...");
		expect(result!.content).not.toContain("line600");
	});

	it("returns null when file cannot be read (ENOENT)", async () => {
		vi.mocked(readFile).mockRejectedValue(
			Object.assign(new Error("ENOENT"), { code: "ENOENT" as const }),
		);
		const result = await getFileContent("/cwd", "src/missing.ts");
		expect(result).toBeNull();
	});

	it("returns null for permission errors (EACCES)", async () => {
		vi.mocked(readFile).mockRejectedValue(
			Object.assign(new Error("Permission denied"), {
				code: "EACCES" as const,
			}),
		);
		const result = await getFileContent("/cwd", "src/secret.ts");
		expect(result).toBeNull();
	});

	it("throws on unexpected errors", async () => {
		vi.mocked(readFile).mockRejectedValue(new Error("Disk full"));
		await expect(getFileContent("/cwd", "src/file.ts")).rejects.toThrow(
			"Failed to read src/file.ts",
		);
	});

	// Security: Path traversal prevention tests
	it("returns null for absolute Unix path", async () => {
		const result = await getFileContent("/cwd", "/etc/passwd");
		expect(result).toBeNull();
		expect(readFile).not.toHaveBeenCalled();
	});

	it("returns null for absolute Windows path", async () => {
		const result = await getFileContent(
			"/cwd",
			"\\\\windows\\\\system32\\\\config\\\\sam",
		);
		expect(result).toBeNull();
		expect(readFile).not.toHaveBeenCalled();
	});

	it("returns null for path with parent directory traversal", async () => {
		const result = await getFileContent("/cwd", "src/../../etc/passwd");
		expect(result).toBeNull();
		expect(readFile).not.toHaveBeenCalled();
	});

	it("does not expand tilde in path", async () => {
		vi.mocked(readFile).mockResolvedValue("ok");
		const result = await getFileContent("/cwd", "~/secret.txt");
		expect(result).not.toBeNull();
		expect(readFile).toHaveBeenCalled();
	});

	it("returns null for nested parent directory traversal", async () => {
		const result = await getFileContent(
			"/cwd",
			"src/subdir/../../../etc/shadow",
		);
		expect(result).toBeNull();
		expect(readFile).not.toHaveBeenCalled();
	});

	it("allows filenames containing '..' when not a path segment", async () => {
		vi.mocked(readFile).mockResolvedValue("ok");
		const result = await getFileContent("/cwd", "src/range..10.ts");
		expect(result).not.toBeNull();
		expect(readFile).toHaveBeenCalled();
	});

	it("returns null for non-regular files (symlinks, directories)", async () => {
		vi.mocked(lstat).mockResolvedValue({
			isFile: () => false,
			isSymbolicLink: () => true,
		} as any);
		const result = await getFileContent("/cwd", "src/symlink.ts");
		expect(result).toBeNull();
		expect(readFile).not.toHaveBeenCalled();
	});

	it("returns null when a symlink is swapped in after realpath (ELOOP)", async () => {
		vi.mocked(open).mockRejectedValue(
			Object.assign(new Error("ELOOP"), { code: "ELOOP" as const }),
		);
		const result = await getFileContent("/cwd", "src/link.ts");
		expect(result).toBeNull();
		expect(readFile).not.toHaveBeenCalled();
	});

	it("returns null when realpath resolves outside cwd", async () => {
		vi.mocked(realpath).mockImplementation(() =>
			Promise.resolve("/etc/passwd"),
		);
		const result = await getFileContent("/cwd", "src/link");
		expect(result).toBeNull();
		expect(readFile).not.toHaveBeenCalled();
	});

	it("falls back to original path when filename contains a literal percent", async () => {
		vi.mocked(readFile).mockResolvedValue("ok");
		const result = await getFileContent("/cwd", "src/file%name.ts");
		expect(result).not.toBeNull();
		expect(readFile).toHaveBeenCalled();
	});

	it("redacts secrets from file content before returning", async () => {
		vi.mocked(readFile).mockResolvedValue(
			"const key = AKIAIOSFODNN7EXAMPLE;\nnormal code;\n",
		);
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const result = await getFileContent("/cwd", "src/config.ts");
		expect(result).not.toBeNull();
		expect(result!.content).toContain("[REDACTED]");
		expect(result!.content).not.toContain("AKIAIOSFODNN7EXAMPLE");
		expect(result!.content).toContain("normal code");
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining("Redacted 1 secret-like value(s)"),
		);
		warnSpy.mockRestore();
	});

	it("redacts multi-line private key blocks before truncation", async () => {
		const block =
			"-----BEGIN RSA PRIVATE KEY-----\nMIIEogIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";
		const lines = Array.from({ length: 600 }, (_, i) =>
			i === 300 ? block : `line${i + 1}`,
		);
		vi.mocked(readFile).mockResolvedValue(lines.join("\n"));
		const result = await getFileContent("/cwd", "src/secret.ts");
		expect(result).not.toBeNull();
		// The private key block should be fully redacted even though it
		// spans lines and is well within the truncation boundary.
		expect(result!.content).not.toContain("BEGIN RSA PRIVATE KEY");
		expect(result!.content).not.toContain("MIIEogIBAAKCAQEA");
		expect(result!.content).toContain("[REDACTED]");
	});
});

describe("getProjectIndex", () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	function mockDirent(name: string, isDir: boolean, isSymlink = false) {
		return {
			name,
			isDirectory: () => (isSymlink ? false : isDir),
			isFile: () => (isSymlink ? false : !isDir),
			isSymbolicLink: () => isSymlink,
		} as any;
	}

	it("walks source dirs and extracts TypeScript exports", async () => {
		vi.mocked(stat)
			.mockResolvedValueOnce({ isDirectory: () => true } as any) // src
			.mockResolvedValueOnce({ isDirectory: () => false } as any) // lib
			.mockResolvedValueOnce({ isDirectory: () => false } as any) // app
			.mockResolvedValueOnce({ isDirectory: () => false } as any); // packages
		vi.mocked(readdir)
			.mockResolvedValueOnce([
				mockDirent("utils.ts", false),
				mockDirent("helpers", true),
			])
			.mockResolvedValueOnce([]); // helpers dir is empty
		vi.mocked(readFile).mockResolvedValue(
			"export function foo() {}\nexport const bar = 1;",
		);

		const index = await getProjectIndex("/cwd");
		expect(index).toHaveLength(1);
		expect(index[0].path).toMatch(/^src[/\\]utils\.ts$/);
		expect(index[0].exports).toContain("foo");
		expect(index[0].exports).toContain("bar");
	});

	it("skips node_modules and other excluded dirs", async () => {
		vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as any);
		vi.mocked(readdir).mockResolvedValue([
			mockDirent("node_modules", true),
			mockDirent("dist", true),
			mockDirent("app.ts", false),
		]);
		vi.mocked(readFile).mockResolvedValue("export const x = 1;");

		const index = await getProjectIndex("/cwd");
		expect(index.length).toBeGreaterThanOrEqual(1);
		expect(index[0].path).toMatch(/app\.ts$/);
	});

	it("falls back to root when no source dirs exist", async () => {
		vi.mocked(stat).mockRejectedValue(new Error("ENOENT"));
		vi.mocked(readdir).mockResolvedValueOnce([mockDirent("index.ts", false)]);
		vi.mocked(readFile).mockResolvedValue("export default function main() {}");

		const index = await getProjectIndex("/cwd");
		expect(index).toHaveLength(1);
		expect(index[0].path).toMatch(/index\.ts$/);
		expect(index[0].exports).toContain("main");
	});

	it("skips symbolic links to avoid reading outside the project", async () => {
		vi.mocked(stat).mockResolvedValue({ isDirectory: () => false } as any);
		vi.mocked(readdir).mockResolvedValue([
			mockDirent("real.ts", false),
			mockDirent("link.ts", false, true),
		]);
		vi.mocked(readFile).mockResolvedValue("export const x = 1;");

		const index = await getProjectIndex("/cwd");
		expect(index).toHaveLength(1);
		expect(index[0].path).toMatch(/real\.ts$/);
	});

	it("skips symbolic links to directories", async () => {
		vi.mocked(stat).mockResolvedValue({ isDirectory: () => false } as any);
		vi.mocked(readdir).mockResolvedValue([
			mockDirent("real.ts", false),
			mockDirent("linkdir", true, true),
		]);
		vi.mocked(readFile).mockResolvedValue("export const x = 1;");

		const index = await getProjectIndex("/cwd");
		expect(index).toHaveLength(1);
		expect(index[0].path).toMatch(/real\.ts$/);
	});

	it("extracts Python exports", async () => {
		vi.mocked(stat).mockResolvedValue({ isDirectory: () => false } as any);
		vi.mocked(readdir).mockResolvedValue([mockDirent("app.py", false)]);
		vi.mocked(readFile).mockResolvedValue(
			"def foo():\n    pass\nclass Bar:\n    pass",
		);

		const index = await getProjectIndex("/cwd");
		expect(index).toHaveLength(1);
		expect(index[0].exports).toContain("foo");
		expect(index[0].exports).toContain("Bar");
	});

	it("extracts Go exports", async () => {
		vi.mocked(stat).mockResolvedValue({ isDirectory: () => false } as any);
		vi.mocked(readdir).mockResolvedValue([mockDirent("main.go", false)]);
		vi.mocked(readFile).mockResolvedValue(
			"func Foo() {}\nfunc (r *Receiver) Bar() {}",
		);

		const index = await getProjectIndex("/cwd");
		expect(index).toHaveLength(1);
		expect(index[0].exports).toContain("Foo");
		expect(index[0].exports).toContain("Bar");
	});

	it("extracts Rust exports", async () => {
		vi.mocked(stat).mockResolvedValue({ isDirectory: () => false } as any);
		vi.mocked(readdir).mockResolvedValue([mockDirent("lib.rs", false)]);
		vi.mocked(readFile).mockResolvedValue("pub fn foo() {}\npub struct Bar;");

		const index = await getProjectIndex("/cwd");
		expect(index).toHaveLength(1);
		expect(index[0].exports).toContain("foo");
		expect(index[0].exports).toContain("Bar");
	});

	it("respects maxFiles limit", async () => {
		vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as any);
		vi.mocked(readdir).mockResolvedValue([
			mockDirent("a.ts", false),
			mockDirent("b.ts", false),
			mockDirent("c.ts", false),
		]);
		vi.mocked(readFile).mockResolvedValue("export const x = 1;");

		const index = await getProjectIndex("/cwd", 2);
		expect(index).toHaveLength(2);
	});

	it("skips files with no exports", async () => {
		vi.mocked(stat).mockResolvedValue({ isDirectory: () => false } as any);
		vi.mocked(readdir).mockResolvedValue([mockDirent("styles.css", false)]);
		vi.mocked(readFile).mockResolvedValue("body { color: red; }");

		const index = await getProjectIndex("/cwd");
		expect(index).toHaveLength(0);
	});
});

describe("redactSecrets", () => {
	it("redacts AWS access key ids", () => {
		const out = redactSecrets("key=AKIAIOSFODNN7EXAMPLE");
		expect(out.text).toBe("key=[REDACTED]");
		expect(out.redacted).toBe(1);
		expect(out.types).toContain("AWS access key id");
	});

	it("redacts GitHub tokens", () => {
		const out = redactSecrets(
			"token: ghp_abcdefghijklmnopqrstuvwxyz0123456789",
		);
		expect(out.text).toBe("token: [REDACTED]");
		expect(out.types).toContain("GitHub token");
	});

	it("redacts private key blocks spanning multiple lines", () => {
		const block =
			"-----BEGIN RSA PRIVATE KEY-----\nMIIEogIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";
		const out = redactSecrets(block);
		expect(out.text).toBe("[REDACTED]");
		expect(out.types).toContain("private key");
	});

	it("redacts private key blocks with CRLF line endings", () => {
		const block =
			"-----BEGIN RSA PRIVATE KEY-----\r\nMIIEogIBAAKCAQEA\r\n-----END RSA PRIVATE KEY-----";
		const out = redactSecrets(block);
		expect(out.text).toBe("[REDACTED]");
		expect(out.types).toContain("private key");
	});

	it("redacts JWTs", () => {
		const jwt =
			"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4f";
		const out = redactSecrets(`Authorization: Bearer ${jwt}`);
		expect(out.text).toBe("Authorization: Bearer [REDACTED]");
		expect(out.types).toContain("JWT");
	});

	it("redacts assignment-style credentials", () => {
		const out = redactSecrets(
			'const API_KEY = "supersecretpassword1234567890";',
		);
		expect(out.text).toBe("const [REDACTED];");
		expect(out.types).toContain("credential assignment");
	});

	it("redacts multiple distinct credential types and reports each once", () => {
		const input =
			"aws=AKIAIOSFODNN7EXAMPLE\nghp_abcdefghijklmnopqrstuvwxyz0123456789";
		const out = redactSecrets(input);
		expect(out.redacted).toBe(2);
		expect(out.types).toHaveLength(2);
		expect(out.types).toContain("AWS access key id");
		expect(out.types).toContain("GitHub token");
	});

	it("leaves ordinary code untouched (no false positives)", () => {
		const code = "const count = 42;\nfunction add(a, b) { return a + b; }";
		const out = redactSecrets(code);
		expect(out.text).toBe(code);
		expect(out.redacted).toBe(0);
		expect(out.types).toHaveLength(0);
	});

	it("does not redact short assignment values below the length threshold", () => {
		const out = redactSecrets('const token = "abc";');
		expect(out.text).toBe('const token = "abc";');
		expect(out.redacted).toBe(0);
	});

	it("returns the original text when input is empty", () => {
		const out = redactSecrets("");
		expect(out.text).toBe("");
		expect(out.redacted).toBe(0);
	});
});
