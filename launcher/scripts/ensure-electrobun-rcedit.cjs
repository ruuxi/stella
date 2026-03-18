const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

if (process.platform !== "win32") {
	process.exit(0);
}

const projectRoot = process.cwd();
const electrobunExe = path.join(
	projectRoot,
	"node_modules",
	"electrobun",
	"bin",
	"electrobun.exe",
);
const localRceditDir = path.join(projectRoot, "node_modules", "rcedit");
const localRceditExe = path.join(localRceditDir, "bin", "rcedit-x64.exe");

if (!fs.existsSync(electrobunExe) || !fs.existsSync(localRceditExe)) {
	process.exit(0);
}

const exeText = fs.readFileSync(electrobunExe, "latin1");
const match = exeText.match(
	/[A-Z]:\\\\a\\\\electrobun\\\\electrobun\\\\package\\\\node_modules\\\\rcedit\\\\lib/,
);

if (!match) {
	process.exit(0);
}

const expectedLibDir = match[0].replace(/\\\\/g, "\\");
const expectedRceditDir = path.dirname(expectedLibDir);
const driveRoot = path.parse(expectedRceditDir).root;

const ensureDriveExists = () => {
	if (fs.existsSync(driveRoot)) {
		return;
	}

	const driveLetter = driveRoot.replace(/\\$/, "");
	const backingRoot = path.join(
		projectRoot,
		"node_modules",
		".electrobun-rcedit-drive",
		driveLetter[0].toLowerCase(),
	);

	fs.mkdirSync(backingRoot, { recursive: true });
	execFileSync("cmd.exe", ["/c", "subst", driveLetter, backingRoot], {
		stdio: "ignore",
	});
};

ensureDriveExists();

try {
	const stat = fs.lstatSync(expectedRceditDir);
	if (stat.isSymbolicLink() || stat.isDirectory()) {
		process.exit(0);
	}
} catch {
	// Fall through and create it.
}

fs.mkdirSync(path.dirname(expectedRceditDir), { recursive: true });

try {
	fs.symlinkSync(localRceditDir, expectedRceditDir, "junction");
} catch (error) {
	if (!fs.existsSync(expectedRceditDir)) {
		throw error;
	}
}
