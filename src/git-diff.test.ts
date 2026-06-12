import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	getChangedFiles,
	getFileDiff,
	getFileContent,
	getProjectIndex,
	getAllSourceFiles,
} from "./git-diff.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile, readdir, stat, lstat } from "node:fs/promises";

vi.mock("node:fs/promises", () => ({
	readFile: vi.fn(),
	readdir: vi.fn(),
	stat: vi.fn(),
	lstat: vi.fn(),
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
});

describe("getFileContent", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		vi.mocked(lstat).mockResolvedValue({ isFile: () => true } as any);
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

	it("returns null for path with tilde expansion", async () => {
		const result = await getFileContent("/cwd", "~/secret.txt");
		expect(result).toBeNull();
		expect(readFile).not.toHaveBeenCalled();
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
});

describe("getProjectIndex", () => {
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
